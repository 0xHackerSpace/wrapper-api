output "id" {
  description = "KV namespace ID."
  value       = cloudflare_workers_kv_namespace.this.id
}

output "title" {
  description = "KV namespace title."
  value       = cloudflare_workers_kv_namespace.this.title
}
