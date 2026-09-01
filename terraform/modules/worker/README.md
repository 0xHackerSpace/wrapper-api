# worker

Publishes one ES Module Worker from a `.mjs` file, plus optional routes and custom domains. Inputs: account ID, script name/path, compatibility date, bindings, routes and domains. Outputs: script ID, name and domains.

A `domains` entry attaches a hostname to the Worker with `cloudflare_workers_custom_domain`: Cloudflare creates the DNS record and issues the certificate, so no `dns_records` entry is needed. Use `routes` instead when the trigger is a pattern with a path, or when the hostname already has a DNS record managed elsewhere.

```hcl
module "worker" {
  source             = "../../worker"
  account_id         = var.account_id
  script_name        = "example"
  script_path        = "${path.root}/../../workers/api/index.mjs"
  compatibility_date = "2026-08-24"

  domains = [{
    hostname = "api.example.com"
    zone_id  = var.zone_id
  }]
}
```
