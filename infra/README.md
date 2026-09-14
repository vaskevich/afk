# afk infra

OpenTofu config for the afk server at `https://afk.osv.im`, running as a **Lightsail
container service** with a **Lightsail bucket** for session storage. Same AWS
account and `aws-vault` profile as the sibling `osv.im` repo, kept as its own
OpenTofu state since it manages a different lifecycle.

## Shape

- **Compute**: `aws_lightsail_container_service` named `afk`, power `nano` (the
  smallest size), scale 1. Traffic is a handful of req/s from a few clients, so
  this is comfortably oversized. Lightsail container services don't have
  availability zones (unlike instances) and come with TLS, a load balancer, and a
  health-checked public endpoint built in -- no Caddy, no systemd unit, no SSH.
- **Images/deploys**: OpenTofu does **not** manage container deployments (the set
  of containers actually running) -- that's `aws lightsail
create-container-service-deployment`, driven by `deploy.sh`, so shipping a new
  image never requires a `tofu apply`. `tofu apply` only provisions the service,
  certificate, DNS, and bucket.
- **TLS + custom domain**: `aws_lightsail_certificate` for `afk.osv.im`, validated
  via Route53 CNAMEs (`dns.tf`, one per `domain_validation_options` entry) in the
  existing `osv.im` hosted zone, looked up by name via a **data source**
  (`data.aws_route53_zone`) rather than a hardcoded zone ID -- one extra
  read-only API call, but keeps this repo self-contained and resilient to the
  zone ever being recreated. Needs `route53:GetHostedZone`/`ListHostedZonesByName`,
  which the admin profile has.
- **DNS**: a Route53 CNAME for `afk.osv.im` pointing at the container service's
  own generated hostname (`aws_lightsail_container_service.afk.url`, with the
  `https://` scheme and trailing slash stripped). This resolves as soon as it's
  applied, but the custom domain only actually serves the app once (a) a
  deployment exists (`deploy.sh`) and (b) the certificate above has finished
  validating, which AWS does asynchronously. Until then, the container service's
  own `*.cs.amazonlightsail.com` URL (`tofu output container_service_url`) works
  as soon as a deployment exists.
- **Storage**: `aws_lightsail_bucket` (bundle `small_1_0`, the smallest: 5 GB
  storage / 25 GB transfer) plus `aws_lightsail_bucket_access_key`. Lightsail's
  "resource access" (granting compute direct access to a bucket) only wires up
  **instances**, not container services, so the container gets credentials the
  ordinary way instead: the access key id/secret as environment variables
  (`AFK_S3_ACCESS_KEY_ID` / `AFK_S3_SECRET_ACCESS_KEY`), read from `tofu output`
  by `deploy.sh` and passed into the deployment spec. See
  `packages/server/src/store/s3-storage.ts`. Lightsail buckets have no lifecycle
  rules, so session expiry is the server's own sweeper (see BACKLOG.md), same as
  every other backend.
- **State backend**: local state (no `backend` block), matching osv.im's repo --
  `infra/terraform.tfstate` is gitignored, applied from a single operator's
  machine. Migrating to an S3+DynamoDB backend later is a small, mechanical
  change if that ever stops being enough.
- **aws-vault profile**: `osv_im_admin` (present in `~/.aws/config`), the same
  profile and account osv.im's infra uses. The profile is named only on the
  command line, never in `providers.tf` -- `aws-vault exec` handles the MFA
  prompt and exports temporary credentials, and a `profile` argument in the
  provider would override those and fail on the profile's `mfa_serial`:

  ```sh
  aws-vault exec osv_im_admin -- tofu -chdir=infra plan
  aws-vault exec osv_im_admin -- tofu -chdir=infra apply
  ```

  osv.im's `main.tf` also has Terraform assume an additional role
  (`var.aws_terraform_role_arn`) on top of the aws-vault profile. This repo
  reproduces that as optional (`providers.tf`, defaults to unset) rather than
  guessing at the ARN.

### Estimated monthly cost

| Item                                               | Cost                                                     |
| -------------------------------------------------- | -------------------------------------------------------- |
| Lightsail container service, `nano` power, scale 1 | ~$7.00                                                   |
| Lightsail bucket, `small_1_0` bundle               | ~$1.00                                                   |
| Route53 record in the existing zone                | ~$0.00 (hosted-zone fee already paid by the osv.im repo) |
| TLS (Lightsail-managed certificate)                | $0.00                                                    |
| **Total**                                          | **~$8/month**                                            |

## No longer used

This repo used to provision a Lightsail **instance** (Ubuntu + Caddy + systemd,
rsync deploys over SSH) with an S3 bucket wired up separately. That design is
gone:

- `infra/.ssh/` (the deploy SSH key pair) and `infra/terraform.tfvars` (which held
  `ssh_public_key`, etc.) are no longer read by anything here. Both are
  gitignored and were left on disk rather than deleted, but there's nothing left
  to `ssh` into -- the container service has no SSH access at all. Delete them
  whenever you like, or repurpose `terraform.tfvars` for `bucket_name` (see
  below).
- `files/user_data.sh.tpl` (cloud-init bootstrap), the instance/static-IP/firewall
  resources, and the plain S3 bucket resource (no bucket access key, since
  instances get bucket access via Lightsail's "resource access" feature instead)
  are all removed from this state. If you still have an old instance running
  from a previous `apply`, it is now orphaned from this config -- destroy it by
  hand via the Lightsail console or CLI.

## First-time setup

1. Copy the tfvars example and pick a bucket name. Bucket names are global
   across all of Lightsail/S3, so `afk-sessions` itself is almost certainly
   taken -- use something unique (your handle, account id, etc.):

   ```sh
   cp infra/terraform.tfvars.example infra/terraform.tfvars   # then edit bucket_name
   ```

2. `aws-vault exec osv_im_admin -- tofu -chdir=infra init`
3. `aws-vault exec osv_im_admin -- tofu -chdir=infra apply`
4. `aws-vault exec osv_im_admin -- infra/deploy.sh` -- builds the image, pushes
   it, and creates the first deployment.
5. Wait for the certificate to finish validating
   (`aws lightsail get-certificates --region us-west-2` shows `ISSUED`) and for
   the deployment to go `ACTIVE`
   (`aws lightsail get-container-services --region us-west-2 --service-name afk`).
6. Visit `https://afk.osv.im`.

## Deploys

```sh
aws-vault exec osv_im_admin -- infra/deploy.sh
```

`deploy.sh`:

1. Builds an image (tag from the first argument, else `$IMAGE_TAG`, else
   `afk:latest`) from the repo root's `Dockerfile`.
2. Pushes it to the service's private registry with
   `aws lightsail push-container-image` and captures the registered image name
   (e.g. `:afk.server.3`) from its output. This needs the `lightsailctl` plugin
   on `PATH` (not bundled with the AWS CLI) -- see [the AWS
   docs](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-install-software.html)
   to install it locally; `deploy.yml` installs it fresh on every CI run.
3. Reads the bucket name/access key from the `AFK_S3_BUCKET` /
   `AFK_S3_ACCESS_KEY_ID` / `AFK_S3_SECRET_ACCESS_KEY` environment variables when
   set, falling back to `tofu output` for whichever is unset (never stored in a
   file either way), and creates a new deployment with
   `aws lightsail create-container-service-deployment`: one container (`server`)
   running that image on port 4141, and a public endpoint pointed at it with a
   health check on `/api/health`.

Run it through `aws-vault` (`aws-vault exec osv_im_admin -- infra/deploy.sh`) --
it never embeds credentials itself, it relies on the AWS CLI picking up
aws-vault's temporary credentials from the environment. `deploy.yml` runs the
same script with credentials from an OIDC-assumed role instead -- see "CI and
deploys" above.

## CI and deploys

GitHub Actions runs two workflows (`.github/workflows/`):

- **`ci.yml`** -- on every pull request and push to main: `pnpm typecheck`,
  `pnpm lint`, `pnpm format:check`, `pnpm test`, `pnpm build` in one job, and
  `tofu fmt -check` + `tofu validate` for `infra/` (no credentials, no state) in
  another.
- **`deploy.yml`** -- on `workflow_dispatch` or a push to main, after `ci.yml`'s
  jobs pass (it calls `ci.yml` as a reusable workflow and `needs` it). The
  `deploy` job authenticates to AWS via GitHub's OIDC provider -- no long-lived
  AWS keys stored in GitHub -- then runs `infra/deploy.sh`, the same script
  described in [Deploys](#deploys) below, with the bucket credentials supplied
  as environment variables instead of `tofu output` (a GitHub-hosted runner has
  no local tofu state).

### One-time setup

1. `aws-vault exec osv_im_admin -- tofu -chdir=infra apply` -- besides the
   container service/bucket, this also provisions `ci.tf`: a GitHub OIDC
   identity provider (`token.actions.githubusercontent.com`, unless one already
   exists in this account -- see the comment on `create_github_oidc_provider` in
   `variables.tf`) and the `afk-github-deploy` IAM role, trusted only by this
   repo's `main` branch and its `production` GitHub environment, with a policy
   scoped to exactly the Lightsail actions `deploy.sh` needs (see `ci.tf` for
   the reasoning and confidence level behind each one).

2. In the GitHub repo, create a **`production` environment**
   (Settings > Environments > New environment). `deploy.yml`'s deploy job
   declares `environment: production`; this is also what the IAM role's trust
   policy in `ci.tf` keys off (a job targeting an environment presents an
   environment-shaped OIDC subject, not a branch-shaped one). Optionally
   restrict the environment to deployments from `main` and/or require a
   reviewer, for a second layer of protection beyond the trust policy.

3. In the GitHub repo, set these under Settings > Secrets and variables >
   Actions, reading the values from `tofu output` (never commit them):

   ```sh
   # Variables (not secret, but not meant to be edited by hand either):
   gh variable set AWS_DEPLOY_ROLE_ARN --body "$(tofu -chdir=infra output -raw github_deploy_role_arn)"
   gh variable set AFK_S3_BUCKET --body "$(tofu -chdir=infra output -raw bucket_name)"

   # Secrets:
   gh secret set AFK_S3_ACCESS_KEY_ID --body "$(tofu -chdir=infra output -raw bucket_access_key_id)"
   gh secret set AFK_S3_SECRET_ACCESS_KEY --body "$(tofu -chdir=infra output -raw bucket_secret_access_key)"
   ```

   (Or set the same four under the repo's Settings UI, pasting each `tofu
output -raw ...` value by hand.) If the bucket access key is ever rotated
   (`tofu apply` after a change to `storage.tf`, or a manual key rotation in the
   Lightsail console), re-run the two `gh secret set` commands -- GitHub secrets
   don't track tofu state and won't update themselves.

## Files

- `versions.tf` -- OpenTofu + provider version pins.
- `providers.tf` -- AWS provider, aws-vault profile, optional assume-role.
- `variables.tf` -- everything configurable; sane defaults, `bucket_name`
  required (bucket names are global, so there's no safe shared default).
- `main.tf` -- the container service and its Lightsail certificate.
- `dns.tf` -- Route53 zone data source, certificate validation CNAMEs, and the
  `afk.osv.im` CNAME to the container service's generated hostname.
- `storage.tf` -- the session-storage bucket and its access key.
- `ci.tf` -- GitHub OIDC provider + the `afk-github-deploy` IAM role
  `.github/workflows/deploy.yml` assumes. See "CI and deploys" above.
- `outputs.tf` -- URLs, the bucket name/region/access key (secret marked
  `sensitive`), and the GitHub deploy role ARN, consumed by `deploy.sh` and the
  one-time GitHub setup above.
- `deploy.sh` -- builds the image, pushes it, creates a deployment. Shared by a
  laptop (via `aws-vault`) and `deploy.yml` -- see "CI and deploys" above.
- `terraform.tfvars.example` -- copy to `terraform.tfvars` (gitignored) and fill
  in `bucket_name`.
