/**
 * DNS record in the existing osv.im hosted zone (managed by the separate osv.im
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

resource "aws_route53_record" "afk" {
  zone_id = data.aws_route53_zone.osv_im.zone_id
  name    = var.domain_name
  type    = "A"
  ttl     = 300
  records = [aws_lightsail_static_ip.afk.ip_address]
}
