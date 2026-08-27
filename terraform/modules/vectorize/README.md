# vectorize

Creates one Vectorize v2 index. The Cloudflare provider `5.23.0` has no Vectorize resource, so the index is
provisioned by `terraform_data` calling the Cloudflare API, as recorded in
[ADR 0003](../../../docs/decisions/0003-vectorize-api-provisioning.md).

Requires `curl` on the machine running the apply and `CLOUDFLARE_API_TOKEN` exported with `Vectorize Write`
permission. The token is read from the environment and never enters the state.

Inputs: `account_id`, `name`, `dimensions` and optional `metric`, `description`, `metadata_indexes` and
`api_base_url`. Outputs: `name`, `id`, `dimensions`, `metric`.

An existing index with the same name and dimensions is adopted. Changing `dimensions`, `metric` or
`metadata_indexes` recreates the index, which deletes its vectors: reindex the documents afterwards.

```hcl
module "vectorize" {
  source           = "./modules/vectorize"
  account_id       = var.account_id
  name             = "dev-rag-index"
  dimensions       = 768
  metric           = "cosine"
  metadata_indexes = { documentId = "string" }
}
```
