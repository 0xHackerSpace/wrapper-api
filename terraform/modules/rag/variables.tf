variable "account_id" {
  description = "Cloudflare account identifier."
  type        = string
  nullable    = false
}

variable "environment" {
  description = "Deployment environment exposed to the Worker as the ENVIRONMENT binding."
  type        = string
  nullable    = false
}

variable "name" {
  description = "Base name for the Worker script and, unless overridden, for the bucket and the index."
  type        = string
  nullable    = false
  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,40}$", var.name))
    error_message = "name must be lowercase alphanumeric with hyphens and at most 41 characters."
  }
}

variable "script_path" {
  description = "Path to the ES Module Worker entrypoint that implements the RAG endpoints."
  type        = string
  nullable    = false
  validation {
    condition     = endswith(var.script_path, ".mjs")
    error_message = "Worker entrypoints must use the .mjs extension."
  }
}

variable "compatibility_date" {
  description = "Workers runtime compatibility date in YYYY-MM-DD form."
  type        = string
  nullable    = false
  validation {
    condition     = can(regex("^[0-9]{4}-[0-9]{2}-[0-9]{2}$", var.compatibility_date))
    error_message = "compatibility_date must use YYYY-MM-DD."
  }
}

variable "bucket_name" {
  description = "R2 bucket holding source documents. Defaults to <name>-documents."
  type        = string
  default     = null
}

variable "bucket_location" {
  description = "Best-effort bucket location on first creation."
  type        = string
  default     = null
}

variable "bucket_jurisdiction" {
  description = "Data residency jurisdiction of the bucket."
  type        = string
  default     = null
}

variable "bucket_storage_class" {
  description = "Default R2 storage class."
  type        = string
  default     = null
}

variable "index_name" {
  description = "Vectorize index holding the embeddings. Defaults to <name>-index."
  type        = string
  default     = null
}

variable "embedding_model" {
  description = "Workers AI text embedding model. Defaults to @cf/google/embeddinggemma-300m."
  type        = string
  default     = null
  validation {
    condition     = var.embedding_model == null || can(regex("^@[a-z0-9][a-z0-9._/-]*$", coalesce(var.embedding_model, "@cf/x")))
    error_message = "embedding_model must be a Workers AI model identifier such as @cf/google/embeddinggemma-300m."
  }
}

variable "generation_model" {
  description = "Workers AI text generation model. Defaults to @cf/meta/llama-3.1-8b-instruct."
  type        = string
  default     = null
  validation {
    condition     = var.generation_model == null || can(regex("^@[a-z0-9][a-z0-9._/-]*$", coalesce(var.generation_model, "@cf/x")))
    error_message = "generation_model must be a Workers AI model identifier such as @cf/meta/llama-3.1-8b-instruct."
  }
}

variable "embedding_dimensions" {
  description = "Embedding size the index is created with. Defaults to 768, the output of the default embedding model."
  type        = number
  default     = null
  validation {
    condition     = var.embedding_dimensions == null || (coalesce(var.embedding_dimensions, 768) >= 1 && coalesce(var.embedding_dimensions, 768) <= 1536)
    error_message = "embedding_dimensions must be between 1 and 1536."
  }
}

variable "vector_metric" {
  description = "Distance metric used for similarity search. Defaults to cosine."
  type        = string
  default     = null
  validation {
    condition     = var.vector_metric == null || contains(["cosine", "euclidean", "dot-product"], coalesce(var.vector_metric, "cosine"))
    error_message = "vector_metric must be cosine, euclidean, or dot-product."
  }
}

variable "chunk_size" {
  description = "Maximum characters per chunk sent to the embedding model. Defaults to 1200."
  type        = number
  default     = null
  validation {
    condition     = var.chunk_size == null || (coalesce(var.chunk_size, 1200) >= 200 && coalesce(var.chunk_size, 1200) <= 4000)
    error_message = "chunk_size must be between 200 and 4000 characters."
  }
}

variable "chunk_overlap" {
  description = "Characters repeated between consecutive chunks. Defaults to 150 and must stay below chunk_size."
  type        = number
  default     = null
  validation {
    condition     = var.chunk_overlap == null || (coalesce(var.chunk_overlap, 150) >= 0 && coalesce(var.chunk_overlap, 150) <= 1000)
    error_message = "chunk_overlap must be between 0 and 1000 characters."
  }
}

variable "top_k" {
  description = "Number of chunks retrieved per query. Defaults to 5."
  type        = number
  default     = null
  validation {
    condition     = var.top_k == null || (coalesce(var.top_k, 5) >= 1 && coalesce(var.top_k, 5) <= 50)
    error_message = "top_k must be between 1 and 50."
  }
}

variable "metadata_indexes" {
  description = "Filterable Vectorize metadata properties, keyed by property name, with the index type as value."
  type        = map(string)
  default = {
    documentId = "string"
    source     = "string"
  }
  nullable = false
}

variable "routes" {
  description = "Zone routes that expose the RAG Worker."
  type = list(object({
    zone_id = string
    pattern = string
  }))
  default  = []
  nullable = false
}

variable "additional_bindings" {
  description = "Extra Worker bindings, such as an AUTH_TOKEN secret added outside of version control."
  type        = list(map(string))
  default     = []
  nullable    = false
}
