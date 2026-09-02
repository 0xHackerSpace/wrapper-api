# Fill IDs and resource declarations for development. Do not put tokens or secrets here.
account_id  = "00000000000000000000000000000000"
environment = "dev"

kv_namespaces = {
  auth_clients = {}
}

workers = {
  api = {
    script_path        = "workers/api/index.mjs"
    compatibility_date = "2026-08-24"
  }

  auth = {
    script_path        = "workers/auth/index.mjs"
    compatibility_date = "2026-08-24"
    subdomain_enabled  = true

    # SIGNING_KEY is set outside Terraform and survives every apply.
    keep_bindings = ["secret_text"]

    bindings = [
      { name = "CLIENTS", type = "kv_namespace", resource_key = "auth_clients" },
    ]

    additional_bindings = [
      { name = "ENVIRONMENT", type = "plain_text", text = "dev" },
      { name = "TOKEN_ISSUER", type = "plain_text", text = "dev-auth" },
      { name = "TOKEN_TTL", type = "plain_text", text = "3600" },
    ]
  }
}

rag_stacks = {
  rag = {
    script_path        = "workers/rag/index.mjs"
    compatibility_date = "2026-08-24"
    subdomain_enabled  = true

    # Fill zone_id and hostname to expose the Worker on a domain of this account.
    # domains = [{
    #   hostname = "rag.example.com"
    #   zone_id  = "00000000000000000000000000000000"
    # }]
  }
}
