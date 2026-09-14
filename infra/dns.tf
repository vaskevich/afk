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

# One CNAME per validated domain, so AWS can confirm we control afk.osv.im and
# issue aws_lightsail_certificate.afk.
#
# for_each is keyed off var.domain_name -- the same (and only) name given to the
# certificate -- rather than off domain_validation_options. for_each *keys* must
# be known at plan time, and the certificate's validation options are unknown
# until after apply; the record *values* looked up from them may stay unknown.
resource "aws_route53_record" "afk_certificate_validation" {
  for_each = toset([var.domain_name])

  zone_id = data.aws_route53_zone.osv_im.zone_id
  name    = one([for dvo in aws_lightsail_certificate.afk.domain_validation_options : dvo.resource_record_name if dvo.domain_name == each.key])
  type    = one([for dvo in aws_lightsail_certificate.afk.domain_validation_options : dvo.resource_record_type if dvo.domain_name == each.key])
  ttl     = 300
  records = [one([for dvo in aws_lightsail_certificate.afk.domain_validation_options : dvo.resource_record_value if dvo.domain_name == each.key])]
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
