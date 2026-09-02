output "id" {
  description = "Worker script identifier."
  value       = cloudflare_workers_script.this.id
}

output "script_name" {
  description = "Published Worker script name."
  value       = cloudflare_workers_script.this.script_name
}

output "domains" {
  description = "Custom domain hostnames routed to this Worker."
  value       = [for domain in cloudflare_workers_custom_domain.this : domain.hostname]
}

output "subdomain_enabled" {
  description = "Whether Terraform publishes this Worker on workers.dev. Null when the setting is unmanaged."
  value       = one(cloudflare_workers_script_subdomain.this[*].enabled)
}
