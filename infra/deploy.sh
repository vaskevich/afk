#!/usr/bin/env bash
# Ships the current checkout to the afk Lightsail instance and restarts the
# service. Run from anywhere; it resolves paths relative to this script.
#
# Usage:
#   infra/deploy.sh [user@]host
#
# If HOST is omitted, it's read from `tofu output -raw static_ip` (so you
# normally just run `infra/deploy.sh` after `tofu apply`).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

SSH_USER="${DEPLOY_SSH_USER:-ubuntu}"
SERVICE_USER="${DEPLOY_SERVICE_USER:-afk}"
APP_DIR="${DEPLOY_APP_DIR:-/opt/afk/app}"

if [[ $# -ge 1 ]]; then
  TARGET="$1"
else
  IP="$(cd "${SCRIPT_DIR}" && tofu output -raw static_ip)"
  TARGET="${SSH_USER}@${IP}"
fi

echo "==> Deploying ${REPO_ROOT} to ${TARGET}:${APP_DIR}"

# Sync the checkout, skipping VCS/build/dev-only cruft and the local infra
# state. node_modules is excluded: pnpm install runs on the box so native
# deps and lockfile resolution match the server's own OS/arch.
rsync -az --delete \
  --exclude='.git/' \
  --exclude='node_modules/' \
  --exclude='**/node_modules/' \
  --exclude='infra/.terraform/' \
  --exclude='infra/terraform.tfstate*' \
  --exclude='infra/*.tfvars' \
  --exclude='packages/server/data/' \
  --exclude='packages/web/dist/' \
  "${REPO_ROOT}/" "${TARGET}:/tmp/afk-deploy/"

# Move into place as the service user, install deps, restart the service.
# shellcheck disable=SC2087
ssh "${TARGET}" bash -s -- "${APP_DIR}" "${SERVICE_USER}" <<'REMOTE'
set -euo pipefail
APP_DIR="$1"
SERVICE_USER="$2"

sudo rsync -a --delete \
  --exclude='node_modules/' \
  --exclude='**/node_modules/' \
  --exclude="packages/server/data/" \
  /tmp/afk-deploy/ "${APP_DIR}/"
sudo chown -R "${SERVICE_USER}:${SERVICE_USER}" "${APP_DIR}"
rm -rf /tmp/afk-deploy

sudo -u "${SERVICE_USER}" bash -lc "
  set -euo pipefail
  cd '${APP_DIR}'
  corepack enable >/dev/null 2>&1 || true
  pnpm install --frozen-lockfile
"

sudo systemctl restart afk.service
sudo systemctl --no-pager --full status afk.service | head -n 12
REMOTE

echo "==> Done."
