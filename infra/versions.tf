terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # No `backend` block: state is local (infra/terraform.tfstate), matching the osv.im
  # infra repo. It is gitignored below. See infra/README.md for the tradeoffs.
}
