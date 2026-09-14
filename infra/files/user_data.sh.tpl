#!/usr/bin/env bash
# One-time bootstrap for the afk Lightsail instance. Runs as root via cloud-init
# on first boot only. Changing this file and re-applying tofu replaces the
# instance (see main.tf) -- prefer editing the live box + deploy.sh for anything
# after initial setup.
set -euxo pipefail

export DEBIAN_FRONTEND=noninteractive

# --- base packages -----------------------------------------------------------
apt-get update
apt-get install -y ca-certificates curl gnupg rsync git ufw

# --- Node ${node_major} via NodeSource ----------------------------------------
curl -fsSL https://deb.nodesource.com/setup_${node_major}.x | bash -
apt-get install -y nodejs

corepack enable
corepack prepare pnpm@${pnpm_version} --activate

# --- Caddy (official apt repo) -------------------------------------------------
install -d /usr/share/keyrings
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  > /etc/apt/sources.list.d/caddy-stable.list
apt-get update
apt-get install -y caddy

# --- service user + directories ------------------------------------------------
id -u ${service_user} >/dev/null 2>&1 || useradd --system --create-home --home-dir /opt/${service_user} --shell /usr/sbin/nologin ${service_user}

mkdir -p ${app_dir} ${data_dir}
chown -R ${service_user}:${service_user} /opt/${service_user}

# Let the sudo-capable login user (ubuntu) rsync deploys in as ${service_user}
# without needing its login shell.
usermod -aG ${service_user} ubuntu || true

# --- systemd unit ---------------------------------------------------------------
cat <<'UNIT' > /etc/systemd/system/afk.service
[Unit]
Description=afk telemetry server
After=network.target

[Service]
Type=simple
User=${service_user}
Group=${service_user}
WorkingDirectory=${app_dir}
Environment=NODE_ENV=production
Environment=AFK_PORT=4141
Environment=AFK_PUBLIC_BASE_URL=${public_base_url}
Environment=AFK_DATA_DIR=${data_dir}
ExecStart=/usr/bin/pnpm --filter @afk/server start
Restart=on-failure
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=${data_dir}

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable afk.service
# Not started here: app_dir is empty until the first `deploy.sh` run.

# --- Caddy reverse proxy + automatic TLS ----------------------------------------
cat <<'CADDYFILE' > /etc/caddy/Caddyfile
${domain_name} {
	reverse_proxy localhost:4141
}
CADDYFILE

systemctl enable caddy
systemctl restart caddy

# --- firewall (belt-and-suspenders on top of the Lightsail networking rules) ----
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
