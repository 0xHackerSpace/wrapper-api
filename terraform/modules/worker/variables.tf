variable "account_id" {
  description = "Cloudflare account identifier."
  type        = string
  nullable    = false
}

variable "script_name" {
  description = "Name used for the Worker script and routes."
  type        = string
  nullable    = false
  validation {
    condition     = can(regex("^[a-zA-Z0-9][a-zA-Z0-9_-]*$", var.script_name))
    error_message = "script_name may contain letters, numbers, hyphens, and underscores."
  }
}

variable "script_path" {
  description = "Absolute or module-resolved path to the ES Module Worker entrypoint."
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

variable "bindings" {
  description = "Cloudflare Workers bindings in the provider's metadata format."
  type        = any
  default     = []
  nullable    = false
}

variable "routes" {
  description = "Zone routes that invoke this Worker."
  type = list(object({
    zone_id = string
    pattern = string
  }))
  default  = []
  nullable = false
}
