resource "cloudflare_workers_script" "this" {
  account_id         = var.account_id
  script_name        = var.script_name
  content            = trimspace(file(var.script_path))
  main_module        = basename(var.script_path)
  compatibility_date = var.compatibility_date
  bindings           = var.bindings
}

resource "cloudflare_workers_script_subdomain" "this" {
  account_id       = var.account_id
  script_name      = cloudflare_workers_script.this.script_name
  enabled          = var.subdomain_enabled
  previews_enabled = var.previews_enabled
}