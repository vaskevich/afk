provider "aws" {
  region  = var.region
  profile = var.aws_vault_profile

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
