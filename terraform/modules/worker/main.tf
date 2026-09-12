resource "cloudflare_workers_script" "this" {
  account_id         = var.account_id
  script_name        = var.script_name
  content            = trimspace(file(var.script_path))
  main_module        = basename(var.script_path)
  compatibility_date = var.compatibility_date
  bindings           = var.bindings
  observability = {
      enabled = true
      head_sampling_rate = 0.1
      logs = {
        enabled = true
        invocation_logs = true
        destinations = ["cloudflare"]
        head_sampling_rate = 0.1
        persist = true
      }
      redact_query_string = false
      traces = {
        destinations = ["cloudflare"]
        enabled = true
        head_sampling_rate = 0.1
        persist = true
      }
    }
}

resource "cloudflare_workers_script_subdomain" "this" {
  account_id       = var.account_id
  script_name      = cloudflare_workers_script.this.script_name
  enabled          = var.subdomain_enabled
  previews_enabled = var.previews_enabled
}