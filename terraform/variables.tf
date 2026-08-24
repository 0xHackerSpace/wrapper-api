variable "account_id" {
  description = "Cloudflare account identifier."
  type        = string
  nullable    = false
  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.account_id))
    error_message = "account_id must be a 32-character lowercase hexadecimal Cloudflare account ID."
  }
}

variable "environment" {
  description = "Deployment environment."
  type        = string
  nullable    = false
  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be dev, staging, or prod."
  }
}

variable "kv_namespaces" {
  description = "KV namespaces keyed by a stable logical name."
  type        = map(object({ title = optional(string) }))
  default     = {}
  nullable    = false
}

variable "r2_buckets" {
  description = "R2 buckets keyed by a stable logical name."
  type = map(object({
    name          = optional(string)
    location      = optional(string)
    jurisdiction  = optional(string)
    storage_class = optional(string)
  }))
  default  = {}
  nullable = false
}

variable "d1_databases" {
  description = "D1 databases keyed by a stable logical name."
  type = map(object({
    name                  = optional(string)
    primary_location_hint = optional(string)
  }))
  default  = {}
  nullable = false
}

variable "queues" {
  description = "Cloudflare Queues keyed by a stable logical name."
  type        = map(object({ name = optional(string) }))
  default     = {}
  nullable    = false
}

variable "dns_records" {
  description = "DNS records keyed by a stable logical name."
  type = map(object({
    zone_id = string
    name    = string
    type    = string
    content = string
    ttl     = optional(number, 1)
    proxied = optional(bool)
    comment = optional(string)
  }))
  default  = {}
  nullable = false
}

variable "workers" {
  description = "Workers and their routes. Binding resource_key references a resource collection key."
  type = map(object({
    script_path        = string
    script_name        = optional(string)
    compatibility_date = string
    routes = optional(list(object({
      zone_id = string
      pattern = string
    })), [])
    bindings = optional(list(object({
      name         = string
      type         = string
      resource_key = string
    })), [])
    additional_bindings = optional(list(map(string)), [])
  }))
  default  = {}
  nullable = false
}
