/**
 * GitHub Actions access to this AWS account: an OIDC identity provider (no
 * long-lived access keys in GitHub) and an IAM role .github/workflows/deploy.yml
 * assumes to build, push, and deploy the afk container image. See
 * infra/README.md's "CI and deploys" section for the one-time setup this needs
 * on the GitHub side (repository secrets/variables, the "production" environment).
 *
 * Whether to create the OIDC provider here is switchable -- see the comment on
 * create_github_oidc_provider in variables.tf for why (short version: an AWS
 * account can only have one IAM OIDC provider per issuer URL, and osv.im's own
 * infra/ci.tf grants its CI a static IAM user rather than OIDC, so there's no
 * known existing provider in this account to point at instead).
 */

resource "aws_iam_openid_connect_provider" "github_actions" {
  count = var.create_github_oidc_provider ? 1 : 0

  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
  # GitHub's OIDC token-signing root CA thumbprint. AWS has validated GitHub's
  # OIDC tokens against its own trusted CA bundle (ignoring this field) since
  # mid-2023, but the provider resource still requires a value here -- this is
  # the thumbprint AWS's own docs and console have used since.
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]

  tags = {
    Project = "afk"
  }
}

data "aws_iam_openid_connect_provider" "github_actions" {
  count = var.create_github_oidc_provider ? 0 : 1

  arn = var.github_oidc_provider_arn
}

locals {
  github_oidc_provider_arn = (
    var.create_github_oidc_provider
    ? aws_iam_openid_connect_provider.github_actions[0].arn
    : data.aws_iam_openid_connect_provider.github_actions[0].arn
  )
}

# Trust policy: only workflow runs for this repo's own main branch, scoped
# further to jobs that declare `environment: production` (see deploy.yml's
# `deploy` job), can assume this role.
#
# A job that sets `environment: production` actually presents GitHub's
# environment-shaped subject (`repo:OWNER/REPO:environment:production`)
# *instead of* the ref-shaped one -- GitHub swaps the claim in whenever a job
# targets an environment, per its OIDC docs. So the `ref:refs/heads/main` value
# below may never actually be the subject presented in practice. It's kept
# anyway as belt-and-suspenders: cheap to allow, and it keeps this role usable
# if the `environment:` line is ever accidentally dropped from the workflow --
# it would still only work from main, not from an arbitrary branch or PR.
locals {
  # "owner@id/repo@id", from `gh api repos/OWNER/REPO/actions/oidc/customization/sub`.
  github_repo_immutable = "${split("/", var.github_repo)[0]}@${var.github_owner_id}/${split("/", var.github_repo)[1]}@${var.github_repo_id}"
}

data "aws_iam_policy_document" "github_deploy_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.github_oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values = [
        "repo:${var.github_repo}:ref:refs/heads/main",
        "repo:${var.github_repo}:environment:production",
        # GitHub's "immutable subject" (on for this repo) appends numeric ids to the
        # owner and repo so renames cannot hijack a trust policy:
        # repo:OWNER@OWNER_ID/REPO@REPO_ID:environment:production. Both forms are
        # accepted so toggling the repo setting either way keeps deploys working.
        "repo:${local.github_repo_immutable}:ref:refs/heads/main",
        "repo:${local.github_repo_immutable}:environment:production",
      ]
    }
  }
}

resource "aws_iam_role" "github_deploy" {
  name               = "afk-github-deploy"
  assume_role_policy = data.aws_iam_policy_document.github_deploy_trust.json

  tags = {
    Project = "afk"
  }
}

# Permissions actually needed to build/push/deploy from CI (infra/deploy.sh,
# run by .github/workflows/deploy.yml). `aws lightsail push-container-image`
# doesn't correspond to one single IAM action -- it's a client-side command
# (backed by the separate `lightsailctl` plugin, see deploy.yml) that:
#   1. Calls CreateContainerServiceRegistryLogin for short-lived docker login
#      credentials to the service's private registry, then does a plain
#      `docker push` with them -- registry auth, not a Lightsail API call.
#   2. Calls RegisterContainerImage to tell Lightsail about the image just
#      pushed and get back its registered name (e.g. ":afk.server.7").
# Those two, plus CreateContainerServiceDeployment for the deployment itself,
# are the actions AWS's own docs list as required for pushing/deploying
# container images (https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-pushing-container-images.html)
# -- high confidence. GetContainerServices, GetContainerImages,
# GetContainerServiceDeployments, and GetContainerAPIMetadata are included
# defensively: they're plain reads the CLI and the lightsailctl plugin are
# known to make along the way (resolving the service, listing already-registered
# images, checking deployment status, and negotiating plugin/API versions), but
# AWS doesn't publish one authoritative minimal-policy list for this CLI
# command the way it did for the two actions above -- medium confidence. If a
# deploy ever fails on an AccessDenied for a `lightsail:` action not listed
# here, it belongs on this list.
data "aws_iam_policy_document" "github_deploy_permissions" {
  statement {
    sid    = "LightsailContainerDeploy"
    effect = "Allow"
    actions = [
      "lightsail:CreateContainerServiceRegistryLogin",
      "lightsail:RegisterContainerImage",
      "lightsail:GetContainerImages",
      "lightsail:GetContainerServices",
      "lightsail:GetContainerServiceDeployments",
      "lightsail:CreateContainerServiceDeployment",
      "lightsail:GetContainerAPIMetadata",
    ]
    # Lightsail container service actions have no resource-level permissions
    # (no ARN to scope to) -- see
    # https://docs.aws.amazon.com/lightsail/latest/userguide/security_iam_service-with-iam.html.
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "github_deploy" {
  name   = "afk-github-deploy"
  role   = aws_iam_role.github_deploy.id
  policy = data.aws_iam_policy_document.github_deploy_permissions.json
}
