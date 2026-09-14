provider "aws" {
  region = var.region

  # No `profile` here on purpose: credentials come from the environment, which
  # `aws-vault exec osv_im_admin -- ...` populates with temporary keys after
  # prompting for MFA. Setting `profile` would make the provider re-resolve
  # osv_im_admin from ~/.aws/config instead, hit its mfa_serial, and fail with
  # "assume role with MFA enabled, but AssumeRoleTokenProvider session option
  # not set" -- OpenTofu cannot prompt for an MFA token.

  # osv.im's infra repo assumes a second, MFA-gated role on top of the aws-vault
  # profile (see its main.tf). We couldn't confirm the exact role ARN it uses at
  # apply time (its terraform.tfvars is gitignored and the checked-in copy is
  # blank), so that's reproduced here as optional: leave aws_terraform_role_arn
  # unset to just use the aws-vault profile's own credentials, or set it if the
  # afk deploy should assume the same restricted role osv.im uses.
  dynamic "assume_role" {
    for_each = var.aws_terraform_role_arn != "" ? [var.aws_terraform_role_arn] : []
    content {
      role_arn = assume_role.value
    }
  }
}
