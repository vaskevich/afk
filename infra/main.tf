/**
 * Lightsail container service running the afk server, plus the TLS certificate for
 * its custom domain. There is no persistent disk here: session data lives in the
 * Lightsail bucket in storage.tf. OpenTofu does not manage deployments (the set of
 * containers actually running) -- that's `aws lightsail create-container-service-deployment`,
 * driven by deploy.sh, so that shipping a new image doesn't require a `tofu apply`.
 */

resource "aws_lightsail_container_service" "afk" {
  name        = "afk"
  power       = "nano" # smallest size; a handful of req/s from a few clients needs nothing more
  scale       = 1
  is_disabled = false

  public_domain_names {
    certificate {
      certificate_name = aws_lightsail_certificate.afk.name
      domain_names     = [var.domain_name]
    }
  }

  tags = {
    Project = "afk"
  }
}

# Lightsail-managed certificate for the custom domain. Requires the DNS validation
# CNAMEs in dns.tf to be in place before AWS will issue it; until then (and until a
# deployment exists -- see deploy.sh) the custom domain won't serve traffic, but the
# service's own generated `*.cs.amazonlightsail.com` URL (aws_lightsail_container_service.afk.url)
# works as soon as a deployment is created.
resource "aws_lightsail_certificate" "afk" {
  name        = "afk"
  domain_name = var.domain_name

  tags = {
    Project = "afk"
  }
}
