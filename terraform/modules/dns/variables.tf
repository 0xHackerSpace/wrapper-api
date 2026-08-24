variable "record" {
  description = "DNS record declaration."
  type = object({
    zone_id = string
    name    = string
    type    = string
    content = string
    ttl     = optional(number, 1)
    proxied = optional(bool)
    comment = optional(string)
  })
  nullable = false
}
