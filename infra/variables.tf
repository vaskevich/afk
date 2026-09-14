variable "region" {
  description = "AWS region to deploy into. Route53 is global; osv.im's other infra lives in us-west-2. Lightsail container services don't have availability zones (unlike instances), so there's no separate AZ variable."
  type        = string
  default     = "us-west-2"
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
  description = "Name of the existing Route53 hosted zone to add records to (must end with a dot)."
  type        = string
  default     = "osv.im."
}

variable "bucket_name" {
  description = "Name for the Lightsail bucket that holds session files. Bucket names are global across all of Lightsail/S3, so there's no safe shared default -- pick something unique, e.g. \"afk-sessions-<your-handle-or-account-id>\"."
  type        = string
}
