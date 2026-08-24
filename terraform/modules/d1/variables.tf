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
