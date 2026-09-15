#!/usr/bin/env bash
# Builds the afk server image, pushes it to the Lightsail container registry, and
# creates a new deployment on the "afk" container service. Shared by two callers:
#
#   - A laptop, through aws-vault: aws-vault exec osv_im_admin -- infra/deploy.sh
#   - .github/workflows/deploy.yml, after authenticating via OIDC (no aws-vault)
#
# Never embeds credentials itself: the AWS CLI picks up whatever credentials are
# already in the environment (aws-vault's temporary ones, or the OIDC-assumed
# role's in CI). Bucket configuration (name/access key) comes from the
# AFK_S3_BUCKET/AFK_S3_ACCESS_KEY_ID/AFK_S3_SECRET_ACCESS_KEY environment
# variables when set -- which is how CI supplies them, from a repository
# variable and secrets, since a runner has no local tofu state -- and falls back
# to `tofu output` otherwise, which is what a laptop run with no environment
# variables set ends up doing. See infra/README.md.
#
# Assumes `aws-vault exec osv_im_admin -- tofu -chdir=infra apply` has already
# created the container service and bucket.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

REGION="us-west-2"
SERVICE_NAME="afk"
CONTAINER_NAME="server"
CONTAINER_PORT=4141
PUBLIC_BASE_URL="https://afk.osv.im"
# Rollout polling: Lightsail takes a few minutes to pull the image, start the
# container, pass the health check, and swap the endpoint over.
ROLLOUT_POLL_INTERVAL_SECONDS=15
ROLLOUT_POLL_ATTEMPTS=40 # 10 minutes
# Live check: after the deployment is ACTIVE the endpoint can lag a little
# before the new container answers, so allow a short retry window.
VERIFY_POLL_INTERVAL_SECONDS=5
VERIFY_POLL_ATTEMPTS=12 # 1 minute
LOG_TAIL_LINES=50
# How long the server may hold accepted frames in memory before writing them to
# the bucket as a slab (AFK_S3_SLAB_FLUSH_SECONDS, default 60). Lowered here
# because a deploy is exactly when that window costs data: Lightsail routes
# traffic to the new container before the old one's SIGTERM flush lands, the new
# one loads the session from the bucket without those frames, numbers its own
# from the same index, and its slab PUT overwrites the old one under the same
# frames/<index>.ndjson key -- silently, after the client was told the frames
# were accepted. Measured on 2026-09-15: 106 of 1,472 frames lost across three
# rollouts, 16 to 33 seconds each. Ten seconds shrinks the window; it does not
# close it (the fix is the single-writer item under Storage & retention in
# BACKLOG.md). The price is about six times as many slab objects while a session
# is live, all of them replaced by one frames.ndjson when it ends.
SLAB_FLUSH_SECONDS=10
# The image tag to build and push: first CLI argument, else $IMAGE_TAG from the
# environment, else "afk:latest". deploy.yml passes the commit SHA as the
# argument so a pushed image can be traced back to the commit that built it.
IMAGE_TAG="${1:-${IMAGE_TAG:-afk:latest}}"

# The commit and time this image is built from, baked in as AFK_BUILD_SHA and
# AFK_BUILD_TIME (see the Dockerfile) and reported by GET /versionz. The rollout
# check at the end of this script compares the live server's commit with GIT_SHA.
GIT_SHA="$(git -C "${REPO_ROOT}" rev-parse --short HEAD)"
BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo "==> Building ${IMAGE_TAG} from ${REPO_ROOT} (commit ${GIT_SHA})"
docker build \
  --build-arg "GIT_SHA=${GIT_SHA}" \
  --build-arg "BUILD_TIME=${BUILD_TIME}" \
  -t "${IMAGE_TAG}" "${REPO_ROOT}"

echo "==> Pushing ${IMAGE_TAG} to the Lightsail registry for ${SERVICE_NAME}"
# Captures the registered image name (e.g. ":afk.server.3") from the CLI's own
# output rather than guessing the next version number ourselves.
PUSH_OUTPUT="$(
  aws lightsail push-container-image \
    --region "${REGION}" \
    --service-name "${SERVICE_NAME}" \
    --label "${CONTAINER_NAME}" \
    --image "${IMAGE_TAG}"
)"
echo "${PUSH_OUTPUT}"

REGISTERED_IMAGE="$(echo "${PUSH_OUTPUT}" | grep -oE ':[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[0-9]+' | tail -n1)"
if [[ -z "${REGISTERED_IMAGE}" ]]; then
  echo "error: could not parse the registered image name out of push-container-image output" >&2
  exit 1
fi
echo "==> Registered image: ${REGISTERED_IMAGE}"

# Session storage credentials: prefer whatever is already in the environment
# (CI's repository secrets/variable), and only shell out to `tofu output` -- which
# needs local state and AWS credentials with permission to read it -- for
# whichever of these a laptop run left unset. Never stored in a file:
# infra/terraform.tfvars only holds the bucket *name* variable, not these
# generated values. The bucket always lives in $REGION (storage.tf gives it no
# region of its own -- it inherits the provider's), so there's no separate
# AFK_S3_REGION to configure anywhere.
S3_BUCKET="${AFK_S3_BUCKET:-}"
if [[ -z "${S3_BUCKET}" ]]; then
  echo "==> AFK_S3_BUCKET not set; reading bucket name from tofu output"
  S3_BUCKET="$(tofu -chdir="${SCRIPT_DIR}" output -raw bucket_name)"
fi
S3_REGION="${REGION}"
S3_ACCESS_KEY_ID="${AFK_S3_ACCESS_KEY_ID:-}"
if [[ -z "${S3_ACCESS_KEY_ID}" ]]; then
  echo "==> AFK_S3_ACCESS_KEY_ID not set; reading bucket access key from tofu output"
  S3_ACCESS_KEY_ID="$(tofu -chdir="${SCRIPT_DIR}" output -raw bucket_access_key_id)"
fi
S3_SECRET_ACCESS_KEY="${AFK_S3_SECRET_ACCESS_KEY:-}"
if [[ -z "${S3_SECRET_ACCESS_KEY}" ]]; then
  echo "==> AFK_S3_SECRET_ACCESS_KEY not set; reading bucket secret key from tofu output"
  S3_SECRET_ACCESS_KEY="$(tofu -chdir="${SCRIPT_DIR}" output -raw bucket_secret_access_key)"
fi

# The deployment spec: one container running the image just pushed, plus the
# public endpoint that wires the load balancer's health check to it. Written to a
# temp file so we don't have to fight shell quoting around --containers/--public-endpoint.
DEPLOYMENT_JSON="$(mktemp)"
trap 'rm -f "${DEPLOYMENT_JSON}"' EXIT

cat >"${DEPLOYMENT_JSON}" <<EOF
{
  "serviceName": "${SERVICE_NAME}",
  "containers": {
    "${CONTAINER_NAME}": {
      "image": "${REGISTERED_IMAGE}",
      "ports": {
        "${CONTAINER_PORT}": "HTTP"
      },
      "environment": {
        "AFK_PORT": "${CONTAINER_PORT}",
        "AFK_PUBLIC_BASE_URL": "${PUBLIC_BASE_URL}",
        "AFK_STORAGE": "s3",
        "AFK_S3_BUCKET": "${S3_BUCKET}",
        "AFK_S3_REGION": "${S3_REGION}",
        "AFK_S3_ACCESS_KEY_ID": "${S3_ACCESS_KEY_ID}",
        "AFK_S3_SECRET_ACCESS_KEY": "${S3_SECRET_ACCESS_KEY}",
        "AFK_S3_SLAB_FLUSH_SECONDS": "${SLAB_FLUSH_SECONDS}"
      }
    }
  },
  "publicEndpoint": {
    "containerName": "${CONTAINER_NAME}",
    "containerPort": ${CONTAINER_PORT},
    "healthCheck": {
      "path": "/api/health"
    }
  }
}
EOF

# Prints the last LOG_TAIL_LINES lines of the container's log to stderr, for a
# failed rollout. `[message]` (a list per event) makes --output text put one
# event per line. Never fails the script: the log is a courtesy at this point.
print_log_tail() {
  echo "==> Last ${LOG_TAIL_LINES} container log lines from ${SERVICE_NAME}/${CONTAINER_NAME}:" >&2
  if ! aws lightsail get-container-log \
    --region "${REGION}" \
    --service-name "${SERVICE_NAME}" \
    --container-name "${CONTAINER_NAME}" \
    --query "logEvents[-${LOG_TAIL_LINES}:].[message]" \
    --output text >&2; then
    echo "(could not fetch the container log)" >&2
  fi
}

# Polls the service until the deployment created above is the current one and
# ACTIVE (success), or Lightsail marks it FAILED (the previous deployment keeps
# running; we print the log tail and fail), or the attempts run out (also a
# failure: a deploy that is still ACTIVATING after ten minutes is not going to
# make it). A transient CLI error is just another attempt.
wait_for_rollout() {
  local attempt status current_version current_state next_version next_state
  for ((attempt = 1; attempt <= ROLLOUT_POLL_ATTEMPTS; attempt++)); do
    if status="$(aws lightsail get-container-services \
      --region "${REGION}" \
      --service-name "${SERVICE_NAME}" \
      --query 'containerServices[0].[currentDeployment.version,currentDeployment.state,nextDeployment.version,nextDeployment.state]' \
      --output text 2>&1)"; then
      read -r current_version current_state next_version next_state <<<"${status}"
      if [[ "${current_version}" == "${NEW_VERSION}" && "${current_state}" == "ACTIVE" ]]; then
        echo "==> Deployment ${NEW_VERSION} is ACTIVE"
        return 0
      fi
      if [[ "${next_version}" == "${NEW_VERSION}" && "${next_state}" == "FAILED" ]] ||
        [[ "${current_version}" == "${NEW_VERSION}" && "${current_state}" == "FAILED" ]]; then
        echo "error: deployment ${NEW_VERSION} FAILED; the previous deployment is still serving" >&2
        print_log_tail
        return 1
      fi
      echo "    ${attempt}/${ROLLOUT_POLL_ATTEMPTS}: current ${current_version} (${current_state}), next ${next_version} (${next_state}); waiting ${ROLLOUT_POLL_INTERVAL_SECONDS}s"
    else
      echo "    ${attempt}/${ROLLOUT_POLL_ATTEMPTS}: get-container-services failed (${status}); waiting ${ROLLOUT_POLL_INTERVAL_SECONDS}s"
    fi
    sleep "${ROLLOUT_POLL_INTERVAL_SECONDS}"
  done
  echo "error: deployment ${NEW_VERSION} was not ACTIVE after $((ROLLOUT_POLL_ATTEMPTS * ROLLOUT_POLL_INTERVAL_SECONDS))s" >&2
  print_log_tail
  return 1
}

# Asks the live server which commit it is running (GET /versionz, see
# docs/PROTOCOL.md) and compares it with the one this script built. No jq on a
# laptop, so the commit is cut out of the compact JSON with sed: the "server"
# object is the only one whose "commit" key follows "server":{ with no closing
# brace in between.
verify_live_commit() {
  local attempt body live_commit
  for ((attempt = 1; attempt <= VERIFY_POLL_ATTEMPTS; attempt++)); do
    body="$(curl -fsS --max-time 10 "${PUBLIC_BASE_URL}/versionz" 2>/dev/null)" || body=""
    live_commit="$(printf '%s' "${body}" | sed -n 's/.*"server":{[^}]*"commit":"\([^"]*\)".*/\1/p')"
    if [[ "${live_commit}" == "${GIT_SHA}" ]]; then
      echo "==> ${PUBLIC_BASE_URL}/versionz reports commit ${GIT_SHA}: ${body}"
      return 0
    fi
    echo "    ${attempt}/${VERIFY_POLL_ATTEMPTS}: live commit is \"${live_commit}\", want ${GIT_SHA}; waiting ${VERIFY_POLL_INTERVAL_SECONDS}s"
    sleep "${VERIFY_POLL_INTERVAL_SECONDS}"
  done
  echo "error: ${PUBLIC_BASE_URL}/versionz never reported commit ${GIT_SHA} (last body: ${body:-none})" >&2
  return 1
}

echo "==> Creating a new deployment on ${SERVICE_NAME}"
# The deployment's version number, read from the create call's own response so
# the polling below can tell this deployment apart from the one it replaces.
NEW_VERSION="$(
  aws lightsail create-container-service-deployment \
    --region "${REGION}" \
    --cli-input-json "file://${DEPLOYMENT_JSON}" \
    --query 'containerService.nextDeployment.version' \
    --output text
)"
if [[ -z "${NEW_VERSION}" || "${NEW_VERSION}" == "None" ]]; then
  echo "error: create-container-service-deployment did not return a deployment version" >&2
  exit 1
fi
echo "==> Deployment ${NEW_VERSION} accepted; waiting for it to become ACTIVE"

wait_for_rollout
verify_live_commit

echo "==> Done: deployment ${NEW_VERSION} (commit ${GIT_SHA}) is live at ${PUBLIC_BASE_URL}"
