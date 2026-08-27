module "vectorize" {
  source     = "../../"
  account_id = var.account_id
  name       = "example-rag-index"
  dimensions = 768
}

variable "account_id" {
  description = "Cloudflare account identifier."
  type        = string
}
