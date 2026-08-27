output "name" {
  description = "Vectorize index name, resolved after the index exists."
  value       = terraform_data.index.output.name
}

output "id" {
  description = "Identifier of the resource tracking the index lifecycle."
  value       = terraform_data.index.id
}

output "dimensions" {
  description = "Vector dimensions of the index."
  value       = var.dimensions
}

output "metric" {
  description = "Distance metric of the index."
  value       = var.metric
}
