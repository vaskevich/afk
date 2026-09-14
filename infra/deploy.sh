#!/usr/bin/env bash
# Builds the afk server image, pushes it to the Lightsail container registry, and
# creates a new deployment on the "afk" container service. Run through aws-vault:
#
#   aws-vault exec osv_im_admin -- infra/deploy.sh
#
# Assumes `aws-vault exec osv_im_admin -- tofu -chdir=infra apply` has already
# created the container service and bucket (see infra/README.md). Never embeds
# credentials: the AWS CLI picks up aws-vault's temporary credentials from the
# environment, and the bucket access key is read fresh from tofu output each run.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

REGION="us-west-2"
SERVICE_NAME="afk"
CONTAINER_NAME="server"
CONTAINER_PORT=4141
IMAGE_TAG="afk:latest"

echo "==> Building ${IMAGE_TAG} from ${REPO_ROOT}"
docker build -t "${IMAGE_TAG}" "${REPO_ROOT}"

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

# Session storage credentials come from tofu output, not from any file on disk --
# infra/terraform.tfvars only holds the bucket *name* variable, not these
# generated values.
echo "==> Reading bucket configuration from tofu output"
S3_BUCKET="$(tofu -chdir="${SCRIPT_DIR}" output -raw bucket_name)"
S3_REGION="$(tofu -chdir="${SCRIPT_DIR}" output -raw bucket_region)"
S3_ACCESS_KEY_ID="$(tofu -chdir="${SCRIPT_DIR}" output -raw bucket_access_key_id)"
S3_SECRET_ACCESS_KEY="$(tofu -chdir="${SCRIPT_DIR}" output -raw bucket_secret_access_key)"

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
