output "id" {
  description = "Worker script identifier."
  value       = module.worker.id
}

output "script_name" {
  description = "Published Worker script name."
  value       = module.worker.script_name
}

output "domains" {
  description = "Custom domain hostnames routed to the RAG Worker."
  value       = module.worker.domains
}

output "subdomain_enabled" {
  description = "Whether Terraform publishes the RAG Worker on workers.dev."
  value       = module.worker.subdomain_enabled
}

output "bucket_name" {
  description = "R2 bucket holding the source documents."
  value       = module.documents.name
}

output "index_name" {
  description = "Vectorize index holding the embeddings."
  value       = module.index.name
}

output "configuration" {
  description = "Model and retrieval configuration delivered to the Worker as plain_text bindings."
  value       = local.configuration
}
