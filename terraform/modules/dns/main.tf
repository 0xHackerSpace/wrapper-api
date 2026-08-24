resource "cloudflare_dns_record" "this" {
  zone_id = var.record.zone_id
  name    = var.record.name
  type    = var.record.type
  content = var.record.content
  ttl     = var.record.ttl
  proxied = var.record.proxied
  comment = var.record.comment
}
