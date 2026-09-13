locals {
  rag_script_paths = {
    for key, stack in var.rag_stacks : key => abspath("${path.root}/${stack.script_path}")
  }
}

locals {
  rag_script_names = {
    for key, s in var.rag_stacks : key => coalesce(s.name, "${var.environment}-${key}")
  }
  rag_service_bindings = {
    for key, s in var.rag_stacks : key => [for sb in s.service_bindings : merge(
      { name = sb.name, type = "service" },
      sb.target_worker != null ? { service = local.worker_script_names[sb.target_worker] } : {},
      sb.target_rag != null ? { service = local.rag_script_names[sb.target_rag] } : {},
      sb.entrypoint != null ? { entrypoint = sb.entrypoint } : {}
    )]
  }
}

module "rag" {
  source   = "./modules/rag"
  for_each = var.rag_stacks

  account_id           = var.account_id
  environment          = var.environment
  name                 = coalesce(each.value.name, "${var.environment}-${each.key}")
  script_path          = local.rag_script_paths[each.key]
  compatibility_date   = each.value.compatibility_date
  subdomain_enabled    = coalesce(each.value.subdomain_enabled, true)
  previews_enabled     = coalesce(each.value.previews_enabled, false)
  bucket_name          = each.value.bucket_name
  bucket_location      = each.value.bucket_location
  bucket_jurisdiction  = each.value.bucket_jurisdiction
  bucket_storage_class = each.value.bucket_storage_class
  index_name           = each.value.index_name
  embedding_model      = each.value.embedding_model
  generation_model     = each.value.generation_model
  embedding_dimensions = each.value.embedding_dimensions
  vector_metric        = each.value.vector_metric
  chunk_size           = each.value.chunk_size
  chunk_overlap        = each.value.chunk_overlap
  top_k                = each.value.top_k
  metadata_indexes     = each.value.metadata_indexes
  additional_bindings  = concat(each.value.additional_bindings, local.rag_service_bindings[each.key])
}
