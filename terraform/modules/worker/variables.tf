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

variable "keep_bindings" {
  description = "Binding types preserved from the previous upload, for bindings created outside Terraform such as secrets."
  type        = set(string)
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

variable "domains" {
  description = "Custom domains routed to this Worker. Cloudflare creates the DNS record and the certificate for each hostname."
  type = list(object({
    hostname  = string
    zone_id   = optional(string)
    zone_name = optional(string)
  }))
  default  = []
  nullable = false
  validation {
    condition     = alltrue([for domain in var.domains : domain.zone_id != null || domain.zone_name != null])
    error_message = "each domain must set zone_id or zone_name so Cloudflare can resolve the zone."
  }
  validation {
    condition     = alltrue([for domain in var.domains : can(regex("^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$", domain.hostname))])
    error_message = "hostname must be a lowercase domain name, either the zone apex or a subdomain of it."
  }
}

variable "subdomain_enabled" {
  description = "Whether the Worker answers on <script_name>.<account>.workers.dev. Null leaves the setting unmanaged."
  type        = bool
  default     = null
}

variable "subdomain_previews_enabled" {
  description = "Whether version preview URLs are served on workers.dev. Only read when subdomain_enabled is set."
  type        = bool
  default     = null
}
