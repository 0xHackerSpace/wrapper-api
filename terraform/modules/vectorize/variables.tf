variable "account_id" {
  description = "Cloudflare account identifier."
  type        = string
  nullable    = false
}

variable "name" {
  description = "Vectorize index name."
  type        = string
  nullable    = false
  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,63}$", var.name))
    error_message = "name must be lowercase alphanumeric with hyphens and at most 64 characters."
  }
}

variable "dimensions" {
  description = "Vector dimensions, which must match the embedding model output."
  type        = number
  nullable    = false
  validation {
    condition     = var.dimensions >= 1 && var.dimensions <= 1536 && floor(var.dimensions) == var.dimensions
    error_message = "dimensions must be a whole number between 1 and 1536."
  }
}

variable "metric" {
  description = "Distance metric used for similarity search."
  type        = string
  default     = "cosine"
  nullable    = false
  validation {
    condition     = contains(["cosine", "euclidean", "dot-product"], var.metric)
    error_message = "metric must be cosine, euclidean, or dot-product."
  }
}

variable "description" {
  description = "Index description stored in Cloudflare."
  type        = string
  default     = null
  validation {
    condition     = var.description == null || can(regex("^[^\"\\\\]*$", coalesce(var.description, "")))
    error_message = "description must not contain double quotes or backslashes."
  }
}

variable "metadata_indexes" {
  description = "Filterable metadata properties, keyed by property name, with the Vectorize index type as value."
  type        = map(string)
  default     = {}
  nullable    = false
  validation {
    condition     = alltrue([for kind in values(var.metadata_indexes) : contains(["string", "number", "boolean"], kind)])
    error_message = "metadata index types must be string, number, or boolean."
  }
}

variable "api_base_url" {
  description = "Cloudflare API base URL."
  type        = string
  default     = "https://api.cloudflare.com/client/v4"
  nullable    = false
}
