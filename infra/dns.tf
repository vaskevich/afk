/**
 * DNS records in the existing osv.im hosted zone (managed by the separate osv.im
 * infra repo/state). We look the zone up by name via a data source rather than
 * hardcoding its zone ID: it's one extra (cheap, read-only) API call, keeps this
 * repo readable without cross-referencing the other repo's state/output, and
 * survives the zone ever being recreated. The tradeoff is that `tofu plan`
 * needs route53:ListHostedZonesByName/GetHostedZone permission, which the
 * aws-vault admin profile already has.
 */

data "aws_route53_zone" "osv_im" {
  name         = var.hosted_zone_name
  private_zone = false
}

# One CNAME per domain_validation_options entry, so AWS can confirm we control
# afk.osv.im and issue aws_lightsail_certificate.afk. A set, so it's for_each'd
# keyed by domain name rather than indexed by position.
resource "aws_route53_record" "afk_certificate_validation" {
  for_each = {
    for dvo in aws_lightsail_certificate.afk.domain_validation_options : dvo.domain_name => dvo
  }

  zone_id = data.aws_route53_zone.osv_im.zone_id
  name    = each.value.resource_record_name
  type    = each.value.resource_record_type
  ttl     = 300
  records = [each.value.resource_record_value]
}

# Points the public hostname at the container service's own generated hostname.
# `url` is a full "https://<name>.<region>.cs.amazonlightsail.com/" -- strip the
# scheme and trailing slash to get the bare hostname a CNAME needs.
#
# NOTE: this record resolves as soon as it's applied, but the custom domain only
# actually serves the app once (a) a container deployment exists (deploy.sh) and
# (b) aws_lightsail_certificate.afk has finished validating against the records
# above, which AWS does asynchronously outside of tofu's control.
resource "aws_route53_record" "afk" {
  zone_id = data.aws_route53_zone.osv_im.zone_id
  name    = var.domain_name
  type    = "CNAME"
  ttl     = 300
  records = [trimsuffix(trimprefix(aws_lightsail_container_service.afk.url, "https://"), "/")]
}
