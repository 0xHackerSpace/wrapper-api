resource "cloudflare_workers_script" "this" {
  account_id         = var.account_id
  script_name        = var.script_name
  content            = trimspace(file(var.script_path))
  main_module        = basename(var.script_path)
  compatibility_date = var.compatibility_date
  bindings           = var.bindings
}

resource "cloudflare_workers_route" "this" {
  for_each = { for route in var.routes : "${route.zone_id}:${route.pattern}" => route }

  zone_id = each.value.zone_id
  pattern = each.value.pattern
  script  = cloudflare_workers_script.this.id
}

resource "cloudflare_workers_custom_domain" "this" {
  for_each = { for domain in var.domains : domain.hostname => domain }

  account_id = var.account_id
  hostname   = each.value.hostname
  service    = cloudflare_workers_script.this.script_name
  zone_id    = each.value.zone_id
  zone_name  = each.value.zone_name
}

resource "cloudflare_workers_script_subdomain" "this" {
  count = var.subdomain_enabled == null ? 0 : 1

  account_id       = var.account_id
  script_name      = cloudflare_workers_script.this.script_name
  enabled          = var.subdomain_enabled
  previews_enabled = var.subdomain_previews_enabled
}
