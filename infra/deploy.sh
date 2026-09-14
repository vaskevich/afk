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
        "AFK_PUBLIC_BASE_URL": "https://afk.osv.im",
        "AFK_STORAGE": "s3",
        "AFK_S3_BUCKET": "${S3_BUCKET}",
        "AFK_S3_REGION": "${S3_REGION}",
        "AFK_S3_ACCESS_KEY_ID": "${S3_ACCESS_KEY_ID}",
        "AFK_S3_SECRET_ACCESS_KEY": "${S3_SECRET_ACCESS_KEY}"
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

echo "==> Creating a new deployment on ${SERVICE_NAME}"
aws lightsail create-container-service-deployment \
  --region "${REGION}" \
  --cli-input-json "file://${DEPLOYMENT_JSON}"

echo "==> Done. Watch rollout with:"
echo "    aws lightsail get-container-services --region ${REGION} --service-name ${SERVICE_NAME}"
