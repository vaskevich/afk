# afk infra

OpenTofu config for a hobby-scale, cheapest-reasonable deployment of the afk server at
`https://afk.osv.im`. Modeled on the sibling `osv.im` repo's Terraform (same AWS
account, same `aws-vault` profile, same "no remote backend" state approach) but kept
as its own OpenTofu state since it manages a different lifecycle (an app server, not
a static site's CDN/DNS).

## Recommended shape

- **Compute**: one Lightsail instance, bundle `micro_3_0` (1 GB RAM / 2 vCPUs / 40 GB
  SSD / 2 TB transfer, ~$5/mo), Ubuntu 22.04 blueprint. Traffic is a handful of
  req/s from a few clients — this is comically oversized for the *traffic*, but
  `pnpm install` plus running the server via `tsx` (no build step — see
  [Tradeoffs](#tradeoffs)) wants more headroom than the $3.50/mo `nano_3_0` (512 MB)
  tier comfortably gives. Bump `lightsail_bundle_id` down if you want to try nano and
  watch for OOM during deploys.
- **Static IP**: `aws_lightsail_static_ip` + `aws_lightsail_static_ip_attachment`.
  Free while attached to a running instance; this is what the DNS record points at
  so the instance can be stopped/started without a new IP.
- **Firewall**: `aws_lightsail_instance_public_ports` opens 22 (SSH, restrict via
  `ssh_allowed_cidrs`), 80 and 443 (Caddy). Port 4141 (the Node app) is never exposed
  publicly — Caddy reverse-proxies to `localhost:4141`. `ufw` is also enabled on the
  box in `user_data` as a second layer.
- **DNS**: `afk.osv.im` A record pointing at the static IP, added to the _existing_
  `osv.im` hosted zone via a **data source** (`data.aws_route53_zone`, looked up by
  name), not a hardcoded zone ID. One extra read-only API call at plan time, but it
  keeps this repo self-contained (no need to go copy an ID out of the osv.im repo's
  state/outputs) and it's what you'd want if that zone were ever recreated. Needs
  `route53:GetHostedZone`/`ListHostedZonesByName`, which the admin profile has.
- **TLS**: Caddy, installed by `user_data`, auto-issuing/renewing a Let's Encrypt cert
  for `afk.osv.im` and reverse-proxying to the Node app. See
  [Tradeoffs](#tradeoffs) for alternatives considered.
- **App runtime**: systemd unit `afk.service`, running as an unprivileged `afk`
  system user (no login shell), `WorkingDirectory=/opt/afk/app`,
  `ExecStart=pnpm --filter @afk/server start` (the repo's existing script — runs
  the server straight through `tsx`, no separate build). Sandboxed with
  `ProtectSystem=strict` / `NoNewPrivileges` / `PrivateTmp`, with
  `ReadWritePaths` scoped to the session-data directory.
- **Getting the code onto the box / deploys**: `infra/deploy.sh` `rsync`s the current
  local checkout to the instance (excluding `.git`, `node_modules`, build output, and
  session data), then SSHes in to move it into place as the `afk` user, run
  `pnpm install --frozen-lockfile`, and restart the systemd unit. See
  [Deploys](#deploys) below. Chosen over a `git pull`-on-box approach so deploys
  don't depend on the box being able to reach GitHub or hold a deploy key, and so you
  can ship work-in-progress without committing first.
- **Session data**: local disk, at `packages/server/data` under the app directory —
  the same relative path the server already uses in dev (see
  `packages/server/.gitignore`). The systemd unit sets `AFK_DATA_DIR` for when the
  server is updated to honor it, but today it doesn't read that variable; nothing to
  do until the disk-persistence backlog item lands, at which point point it at
  `$AFK_DATA_DIR` (or keep the relative default and skip the env var).
- **S3 (later)**: `infra/storage.tf` defines the bucket, a public-access block, and a
  lifecycle rule expiring objects after 7 days — all gated behind
  `enable_s3_storage` (default `false`), so `tofu apply` today does not create
  anything in S3. Flip the variable once the server actually writes there, and add
  whatever IAM access the server needs at that point (an instance role wasn't added
  now since there's nothing for it to do yet).
- **State backend**: local state (no `backend` block), matching osv.im's repo, which
  also has no S3/DynamoDB backend configured — `terraform.tfstate` there is
  gitignored and applied from a single operator's machine. Same here:
  `infra/terraform.tfstate` is gitignored. This is a single-maintainer hobby project,
  so the lack of locking/shared state isn't a real cost; migrating to an S3+DynamoDB
  backend later is a small, mechanical change if that ever stops being true.
- **aws-vault profile**: `osv_im_admin` (present in `~/.aws/config`, chained through
  `osv_im_read_only` to `arn:aws:iam::613192498653:role/RootAccountAccessRole` with
  MFA) — the same profile and account osv.im's infra uses. Invoke as:

  ```sh
  aws-vault exec osv_im_admin -- tofu plan
  aws-vault exec osv_im_admin -- tofu apply
  ```

  osv.im's `main.tf` _also_ has Terraform assume an additional role
  (`var.aws_terraform_role_arn`) on top of the aws-vault profile. This repo
  reproduces that as optional (`providers.tf`, defaults to unset) rather than
  guessing at the ARN — see [What I couldn't determine](#what-i-couldnt-determine).

### Estimated monthly cost

| Item                                                                    | Cost                                                                                                                      |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Lightsail `micro_3_0` instance (compute + 40 GB SSD + 2 TB transfer)    | ~$5.00                                                                                                                    |
| Lightsail static IP (attached)                                          | $0.00                                                                                                                     |
| Route53 record in the existing zone                                     | ~$0.00 (the $0.50/mo hosted-zone fee is already paid by the osv.im repo; queries are fractions of a cent at this traffic) |
| TLS (Let's Encrypt via Caddy)                                           | $0.00                                                                                                                     |
| S3 (disabled today; small NDJSON files, 7-day expiration, once enabled) | a few cents/month                                                                                                         |
| **Total**                                                               | **~$5-6/month**                                                                                                           |

## Tradeoffs

- **Caddy vs. alternatives for TLS.** Considered: nginx + certbot (more moving
  parts — a renewal cron/timer, a separate reverse-proxy config format, no
  auto-reload on renewal without extra glue); an ALB with an ACM certificate
  (ALB alone runs ~$16+/mo _before_ any traffic — kills "cheapest" outright, and
  you'd still need a compute target behind it); CloudFront or a Lightsail
  "distribution" (CDN) in front with ACM (adds cost and, more importantly, CDNs
  buffer/cache by default in ways that fight the SSE endpoint
  `GET /api/sessions/:id/stream`, which needs to stream unbuffered). Caddy's
  automatic cert issuance/renewal and native streaming reverse proxy make it the
  least operational overhead for this shape.
- **micro_3_0 vs. nano_3_0.** The cheaper tier would probably work fine at
  steady-state (a handful of req/s barely uses any CPU/RAM), but `pnpm install`
  plus running TypeScript directly through `tsx` (which transpiles in-process,
  unlike running pre-built JS) is the part likely to be memory-hungry during a
  deploy. Once the app is built to plain JS for production (a natural side effect
  of "serve the built dashboard from Node" in BACKLOG.md) and `pnpm install
--prod` is enough at deploy time, nano_3_0 becomes a safer bet and would cut
  ~$1.50/mo.
- **rsync-based deploy vs. `git pull` on the box.** A git-based deploy is simpler
  to reason about and avoids rsync exclude bookkeeping, but requires either a
  public repo or a deploy key on the box, and only ever deploys committed code.
  rsync works regardless of the repo's visibility and lets you ship a dirty
  working tree, which fits "hobby project, deploying from a laptop" better. Worth
  revisiting if/when there's CI.
- **Route53 data source vs. hardcoded zone ID.** Covered above — data source
  chosen for readability and resilience over a hardcoded ID, at the cost of one
  extra read call and a permission dependency (already satisfied by the admin
  profile).
- **Local vs. remote OpenTofu state.** Covered above — matched to osv.im's own
  choice for consistency; call out if multi-machine/CI apply ever becomes a
  requirement.

## What I couldn't determine

- **The exact `aws_terraform_role_arn` osv.im's Terraform assumes at apply time.**
  Its `terraform.tfvars` is gitignored, and the checked-in template has that
  variable (and `aws_vault_profile`) blank, so the real value is only in Oleg's
  local, untracked copy. This repo makes the extra `assume_role` optional
  (empty by default) instead of guessing; if osv.im's apply-time role should also
  cover this project, set `aws_terraform_role_arn` in `infra/terraform.tfvars`.
- **Current exact Lightsail bundle/blueprint IDs and pricing.** `micro_3_0` /
  `ubuntu_22_04` have been stable identifiers, but AWS does refresh Lightsail's
  catalog (e.g. `ubuntu_24_04` may now be preferable). Worth a quick
  `aws-vault exec osv_im_admin -- aws lightsail get-bundles` /
  `get-blueprints` check before the first `tofu apply` (not run here, since this
  task was read/design-only).
- **Whether `osv_im_admin` (or a narrower role) has Lightsail permissions today.**
  It's an `AdministratorAccess`-rooted role per osv.im's README, so it should, but
  wasn't verified against a live account.

## Deploys

```sh
aws-vault exec osv_im_admin -- tofu -chdir=infra apply   # provision/update infra
infra/deploy.sh                                          # ship code + restart
```

`deploy.sh` reads the target IP from `tofu output -raw static_ip` if you don't pass
a host explicitly (`infra/deploy.sh ubuntu@1.2.3.4`). It syncs the repo via `rsync`
(skipping `.git`, `node_modules`, build output, and on-disk session data), installs
dependencies on the box as the `afk` service user, and restarts `afk.service`.

First-time setup:

1. Generate a dedicated deploy key pair and point the config at its public half.
   Both `infra/.ssh/` and `terraform.tfvars` are gitignored; `deploy.sh` uses the
   private key automatically (override with `DEPLOY_SSH_KEY`):

   ```sh
   ssh-keygen -t ed25519 -N "" -C afk-deploy -f infra/.ssh/afk_ed25519
   cp infra/terraform.tfvars.example infra/terraform.tfvars   # then paste infra/.ssh/afk_ed25519.pub into ssh_public_key
   ```

   Narrow `ssh_allowed_cidrs` to your own IP if it's stable.

2. `aws-vault exec osv_im_admin -- tofu -chdir=infra init`
3. `aws-vault exec osv_im_admin -- tofu -chdir=infra apply`
4. `infra/deploy.sh`
5. Visit `https://afk.osv.im`.

## Files

- `versions.tf` — OpenTofu + provider version pins.
- `providers.tf` — AWS provider, aws-vault profile, optional assume-role.
- `variables.tf` — everything configurable; sane defaults, `ssh_public_key`
  required.
- `main.tf` — Lightsail instance, static IP, firewall.
- `dns.tf` — Route53 zone data source + `afk.osv.im` A record.
- `storage.tf` — S3 bucket + lifecycle rule for later, behind `enable_s3_storage`.
- `outputs.tf` — static IP, SSH/URL convenience outputs.
- `files/user_data.sh.tpl` — one-time boot script: installs Node/pnpm/Caddy,
  creates the service user and directories, installs the systemd unit and
  Caddyfile. **Changing this and re-applying replaces the instance** (Lightsail
  treats `user_data` changes as force-new), which would wipe local-disk session
  data — treat it as bootstrap-only and use `deploy.sh`/SSH for anything after
  initial setup.
- `deploy.sh` — ships the current checkout and restarts the service.
- `terraform.tfvars.example` — copy to `terraform.tfvars` (gitignored) and fill in.
