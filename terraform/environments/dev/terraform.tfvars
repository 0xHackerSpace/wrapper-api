# Fill IDs and resource declarations for development. Do not put tokens or secrets here.
account_id  = "00000000000000000000000000000000"
environment = "dev"

workers = {
  api = {
    script_path        = "workers/api/index.mjs"
    compatibility_date = "2026-08-24"
  }
}

rag_stacks = {
  rag = {
    script_path        = "workers/rag/index.mjs"
    compatibility_date = "2026-08-24"
  }
}
