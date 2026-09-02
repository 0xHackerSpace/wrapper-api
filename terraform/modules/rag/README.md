# rag

Composes one retrieval-augmented generation stack: an R2 bucket for source documents, a Vectorize index for
embeddings and a Worker that exposes `GET /health`, `POST /ingest` and `POST /query`. It reuses the `r2`,
`vectorize` and `worker` modules instead of declaring resources of its own.

Inputs: `account_id`, `environment`, `name`, `script_path`, `compatibility_date` and optional bucket, index,
model, retrieval, `routes`, `domains` and `subdomain_enabled` settings. Outputs: `id`, `script_name`,
`domains`, `subdomain_enabled`, `bucket_name`, `index_name`, `configuration`.

`subdomain_enabled` publishes the Worker on `https://<name>.<account>.workers.dev`, which is enough to reach
the endpoints without owning a zone.

`domains` attaches hostnames to the Worker through `cloudflare_workers_custom_domain`, which also creates the
DNS record and the certificate. The endpoints then answer on `https://<hostname>/health`, `/ingest` and
`/query`.

Bindings attached to the Worker:

| Binding | Type | Provides |
| --- | --- | --- |
| `AI` | `ai` | Workers AI inference for embeddings and generation |
| `VECTORIZE` | `vectorize` | the index created by the `vectorize` module |
| `DOCUMENTS` | `r2_bucket` | the bucket created by the `r2` module |
| `ENVIRONMENT`, `EMBEDDING_MODEL`, `GENERATION_MODEL`, `EMBEDDING_DIMENSIONS`, `CHUNK_SIZE`, `CHUNK_OVERLAP`, `TOP_K` | `plain_text` | model and retrieval configuration |

Model and index must agree: the default `@cf/google/embeddinggemma-300m` emits 768 dimensions, which is the
default of `embedding_dimensions`. Changing either recreates the index and requires reindexing the documents
stored in R2.

`/ingest` and `/query` are unauthenticated unless an `AUTH_TOKEN` binding is present, in which case both
require `Authorization: Bearer <token>`. Provide it through `additional_bindings` from a secret source; never
from a versioned `.tfvars`.

The `worker` module uploads a single file, so the entrypoint must stay self-contained and use no imports.

```hcl
module "rag" {
  source             = "./modules/rag"
  account_id         = var.account_id
  environment        = var.environment
  name               = "dev-rag"
  script_path        = abspath("${path.root}/../workers/rag/index.mjs")
  compatibility_date = "2026-08-24"

  subdomain_enabled = true

  domains = [{
    hostname = "rag.example.com"
    zone_id  = var.zone_id
  }]
}
```
