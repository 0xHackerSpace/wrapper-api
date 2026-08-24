output "id" {
  description = "Worker script identifier."
  value       = cloudflare_workers_script.this.id
}

output "script_name" {
  description = "Published Worker script name."
  value       = cloudflare_workers_script.this.script_name
}
