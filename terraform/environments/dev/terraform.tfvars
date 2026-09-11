# Fill IDs and resource declarations for development. Do not put tokens or secrets here.
account_id              = "dbe6f61104309ab5a6bf80c5721f4712"
environment             = "dev"
workers_subdomain       = "0xhackerspace"
# cloudflare_api_token should be set via environment variable or HCP Terraform UI

d1_databases = {
  auth = {
    name                  = "dev-auth"
    primary_location_hint = "wnam"
    run_migrations        = true
    migrations = [
      "terraform/migrations/0001_create_users.sql",
      "terraform/migrations/0002_create_auth_logs.sql",
      "terraform/migrations/0003_seed_users.sql",
      "terraform/migrations/0004_add_profiles_and_permissions.sql",
      "terraform/migrations/0005_seed_roles_and_permissions.sql"
    ]
  }
}

workers = {
  api = {
    script_path        = "workers/api/dist/index.mjs"
    compatibility_date = "2026-08-24"
    # JWT_SECRET should be set via wrangler secrets
  }
  auth = {
    script_path        = "workers/auth/dist/index.mjs"
    compatibility_date = "2026-08-24"
    bindings = [
      {
        name         = "DB"
        type         = "d1"
        resource_key = "auth"
      }
    ]
    # JWT_SECRET should be set via wrangler secrets
  }
}

rag_stacks = {
  rag = {
    script_path        = "workers/rag/dist/index.mjs"
    compatibility_date = "2026-08-24"
    # JWT_SECRET should be set via wrangler secrets
  }
}