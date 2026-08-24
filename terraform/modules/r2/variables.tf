variable "account_id" {
  description = "Cloudflare account identifier."
  type        = string
}
variable "name" {
  description = "R2 bucket name."
  type        = string
}
variable "location" {
  description = "Best-effort bucket location on first creation."
  type        = string
  default     = null
}
variable "jurisdiction" {
  description = "Data residency jurisdiction."
  type        = string
  default     = null
}
variable "storage_class" {
  description = "Default R2 storage class."
  type        = string
  default     = null
}
