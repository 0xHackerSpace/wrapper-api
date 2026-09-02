# worker

Publishes one ES Module Worker from a `.mjs` file, plus optional routes and custom domains. Inputs: account ID, script name/path, compatibility date, bindings, routes and domains. Outputs: script ID, name and domains.

`subdomain_enabled` publishes the Worker on `https://<script_name>.<account>.workers.dev` with
`cloudflare_workers_script_subdomain`; `subdomain_previews_enabled` does the same for version preview URLs.
Leave both null to keep the account default unmanaged. The `<account>` part is the workers.dev subdomain of the
account, chosen once in the Cloudflare dashboard, so Terraform cannot output the full URL.

A `domains` entry attaches a hostname to the Worker with `cloudflare_workers_custom_domain`: Cloudflare creates the DNS record and issues the certificate, so no `dns_records` entry is needed. Use `routes` instead when the trigger is a pattern with a path, or when the hostname already has a DNS record managed elsewhere.

```hcl
module "worker" {
  source             = "../../worker"
  account_id         = var.account_id
  script_name        = "example"
  script_path        = "${path.root}/../../workers/api/index.mjs"
  compatibility_date = "2026-08-24"

  subdomain_enabled = true

  domains = [{
    hostname = "api.example.com"
    zone_id  = var.zone_id
  }]
}
```
