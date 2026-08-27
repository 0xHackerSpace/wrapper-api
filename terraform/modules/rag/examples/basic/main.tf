module "rag" {
  source             = "../../"
  account_id         = var.account_id
  environment        = "dev"
  name               = "example-rag"
  script_path        = abspath("${path.root}/../../../../../workers/rag/index.mjs")
  compatibility_date = "2026-08-24"
}

variable "account_id" {
  description = "Cloudflare account identifier."
  type        = string
}
