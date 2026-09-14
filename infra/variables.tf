variable "region" {
  description = "AWS region to deploy into. Route53 is global; osv.im's other infra lives in us-west-2. Lightsail container services don't have availability zones (unlike instances), so there's no separate AZ variable."
  type        = string
  default     = "us-west-2"
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
  description = "Name of the existing Route53 hosted zone to add records to (must end with a dot)."
  type        = string
  default     = "osv.im."
}

variable "bucket_name" {
  description = "Name for the Lightsail bucket that holds session files. Bucket names are global across all of Lightsail/S3; override if the default is taken or you are self-hosting."
  type        = string
  default     = "afk-osv-im"
}

variable "github_repo" {
  description = "GitHub \"owner/repo\" allowed to assume the afk-github-deploy role (see ci.tf)."
  type        = string
  default     = "vaskevich/afk"
}

# An AWS account can only have one IAM OIDC provider per issuer URL, and osv.im's
# infra/ci.tf grants its GitHub Actions CI a static IAM user with long-lived
# access keys rather than OIDC -- so despite sharing this account, it hasn't
# already created a token.actions.githubusercontent.com provider for ci.tf to
# reuse. These two variables make that switchable in case that's wrong (a
# provider was created by hand, or by something outside either repo's tofu
# state): leave create_github_oidc_provider at its default to create one here,
# or set it to false and supply github_oidc_provider_arn to reference an
# existing one instead -- creating a second provider for the same issuer fails
# with EntityAlreadyExists.
variable "github_owner_id" {
  description = "Numeric GitHub id of the repo owner, for the immutable OIDC subject (see ci.tf). `gh api users/OWNER --jq .id`."
  type        = number
  default     = 1815707
}

variable "github_repo_id" {
  description = "Numeric GitHub id of the repository, for the immutable OIDC subject (see ci.tf). `gh api repos/OWNER/REPO --jq .id`."
  type        = number
  default     = 1369376504
}

variable "create_github_oidc_provider" {
  description = "Whether to create the GitHub Actions OIDC provider in this account. Set false (and supply github_oidc_provider_arn) if one already exists for token.actions.githubusercontent.com."
  type        = bool
  default     = true
}

variable "github_oidc_provider_arn" {
  description = "ARN of an existing GitHub Actions OIDC provider to reference instead of creating one. Required when create_github_oidc_provider is false; ignored otherwise."
  type        = string
  default     = ""
}
