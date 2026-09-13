variable "account_id" {
  description = "Cloudflare account identifier."
  type        = string
}

variable "name" {
  description = "D1 database name."
  type        = string
}

variable "primary_location_hint" {
  description = "Optional D1 primary location hint."
  type        = string
  default     = null
}

variable "run_migrations" {
  description = "Whether to run migrations after database creation."
  type        = bool
  default     = false
}

variable "migrations" {
  description = "List of migration SQL file paths to apply."
  type        = list(string)
  default     = []
}

variable "cloudflare_api_token" {
  description = "Cloudflare API token for running migrations."
  type        = string
  sensitive   = true
  default     = ""
}
