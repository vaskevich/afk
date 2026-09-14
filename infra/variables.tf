variable "region" {
  description = "AWS region to deploy into. Route53 is global; osv.im's other infra lives in us-west-2."
  type        = string
  default     = "us-west-2"
}

variable "availability_zone" {
  description = "Lightsail availability zone (region + letter suffix, e.g. us-west-2a)."
  type        = string
  default     = "us-west-2a"
}

variable "aws_vault_profile" {
  description = "aws-vault profile used for `aws-vault exec <profile> -- tofu ...`. Matches ~/.aws/config's osv_im_admin, the same profile the osv.im repo uses."
  type        = string
  default     = "osv_im_admin"
}

variable "aws_terraform_role_arn" {
  description = "Optional role to assume on top of the aws-vault profile, for parity with osv.im's infra repo. Leave blank to use the aws-vault profile's credentials directly."
  type        = string
  default     = ""
}

variable "domain_name" {
  description = "Public hostname the dashboard/ingest API is served on."
  type        = string
  default     = "afk.osv.im"
}

variable "hosted_zone_name" {
  description = "Name of the existing Route53 hosted zone to add the A record to (must end with a dot)."
  type        = string
  default     = "osv.im."
}

variable "lightsail_bundle_id" {
  description = "Lightsail instance size. micro_3_0 = 1 GB RAM / 2 vCPUs / 40 GB SSD / 2 TB transfer (~$5/mo). nano_3_0 (512 MB RAM, ~$3.50/mo) is cheaper but risks OOM during `pnpm install` on deploy; see infra/README.md."
  type        = string
  default     = "micro_3_0"
}

variable "blueprint_id" {
  description = "Lightsail OS blueprint."
  type        = string
  default     = "ubuntu_22_04"
}

variable "ssh_public_key" {
  description = "Contents of the SSH public key (e.g. ~/.ssh/id_ed25519.pub) to install for the deploy user. Required — no default, since it shouldn't be a guessable value baked into the repo."
  type        = string
}

variable "ssh_allowed_cidrs" {
  description = "CIDR blocks allowed to reach port 22. Narrow this to your own IP/32 if possible; left open by default because home IPs change."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "service_user" {
  description = "Unix user the afk server runs as (unprivileged, no login shell)."
  type        = string
  default     = "afk"
}

variable "ssh_login_user" {
  description = "OS login user for SSH/deploys -- the Ubuntu blueprint's default sudo-capable user, not the unprivileged service_user."
  type        = string
  default     = "ubuntu"
}

variable "app_dir" {
  description = "Directory on the instance the app is deployed into."
  type        = string
  default     = "/opt/afk/app"
}

variable "data_dir" {
  description = "Directory on the instance where session files are stored on local disk. Defaults to packages/server/data under app_dir to match the existing dev convention (see packages/server/.gitignore) -- the server doesn't yet honor an AFK_DATA_DIR override, so keep this nested under app_dir until it does."
  type        = string
  default     = "/opt/afk/app/packages/server/data"
}

variable "node_major_version" {
  description = "Node.js major version to install via NodeSource."
  type        = number
  default     = 20
}

variable "pnpm_version" {
  description = "pnpm version to activate via corepack. Should track the monorepo's packageManager field."
  type        = string
  default     = "10.13.1"
}

variable "enable_s3_storage" {
  description = "Whether to create the S3 bucket for session storage. Off by default -- this is the 'later' migration target from BACKLOG.md, not needed while sessions live on local disk."
  type        = bool
  default     = false
}

variable "s3_bucket_name" {
  description = "Name for the (optional) S3 bucket that will eventually hold session files. Bucket names are global, so this must be unique."
  type        = string
  default     = "afk-osv-im-sessions"
}

variable "s3_lifecycle_expiration_days" {
  description = "Days after which session objects expire in S3, once enabled."
  type        = number
  default     = 7
}
