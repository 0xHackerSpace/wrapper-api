locals {
  defaults = {
    embedding_model      = "@cf/google/embeddinggemma-300m"
    generation_model     = "@cf/meta/llama-3.1-8b-instruct"
    embedding_dimensions = 768
    vector_metric        = "cosine"
    chunk_size           = 1200
    chunk_overlap        = 150
    top_k                = 5
  }

  bucket_name          = coalesce(var.bucket_name, "${var.name}-documents")
  index_name           = coalesce(var.index_name, "${var.name}-index")
  embedding_model      = coalesce(var.embedding_model, local.defaults.embedding_model)
  generation_model     = coalesce(var.generation_model, local.defaults.generation_model)
  embedding_dimensions = coalesce(var.embedding_dimensions, local.defaults.embedding_dimensions)
  vector_metric        = coalesce(var.vector_metric, local.defaults.vector_metric)
  chunk_size           = coalesce(var.chunk_size, local.defaults.chunk_size)
  chunk_overlap        = coalesce(var.chunk_overlap, local.defaults.chunk_overlap)
  top_k                = coalesce(var.top_k, local.defaults.top_k)

  # Configuration the Worker reads from plain_text bindings, so no environment specific value lives in the .mjs.
  configuration = {
    ENVIRONMENT          = var.environment
    EMBEDDING_MODEL      = local.embedding_model
    GENERATION_MODEL     = local.generation_model
    EMBEDDING_DIMENSIONS = tostring(local.embedding_dimensions)
    CHUNK_SIZE           = tostring(local.chunk_size)
    CHUNK_OVERLAP        = tostring(local.chunk_overlap)
    TOP_K                = tostring(local.top_k)
  }

  bindings = concat(
    [
      { name = "AI", type = "ai" },
      { name = "VECTORIZE", type = "vectorize", index_name = module.index.name },
      { name = "DOCUMENTS", type = "r2_bucket", bucket_name = module.documents.name },
    ],
    [for name, text in local.configuration : { name = name, type = "plain_text", text = text }],
    var.additional_bindings
  )
}

check "chunking" {
  assert {
    condition     = local.chunk_overlap < local.chunk_size
    error_message = "chunk_overlap must stay below chunk_size, otherwise chunking makes no progress."
  }
}

module "documents" {
  source        = "../r2"
  account_id    = var.account_id
  name          = local.bucket_name
  location      = var.bucket_location
  jurisdiction  = var.bucket_jurisdiction
  storage_class = var.bucket_storage_class
}

module "index" {
  source           = "../vectorize"
  account_id       = var.account_id
  name             = local.index_name
  dimensions       = local.embedding_dimensions
  metric           = local.vector_metric
  description      = "Embeddings for the ${var.name} retrieval-augmented generation Worker."
  metadata_indexes = var.metadata_indexes
}

module "worker" {
  source             = "../worker"
  account_id         = var.account_id
  script_name        = var.name
  script_path        = var.script_path
  compatibility_date = var.compatibility_date
  bindings           = local.bindings
  routes             = var.routes
}
