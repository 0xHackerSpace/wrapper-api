# Fill IDs and resource declarations for development. Do not put tokens or secrets here.
account_id        = "dbe6f61104309ab5a6bf80c5721f4712"
environment       = "dev"
workers_subdomain = "0xhackerspace"
# cloudflare_api_token should be set via environment variable or HCP Terraform UI
jwt_secret = "dev-jwt-secret-key-32-characters-min"

d1_databases = {
  auth = {
    name                  = "dev-auth"
    primary_location_hint = "wnam"
    run_migrations        = true
    migrations = [
      "migrations/0001_create_users.sql",
      "migrations/0002_create_auth_logs.sql",
      "migrations/0003_seed_users.sql",
      "migrations/0004_add_profiles_and_permissions.sql",
      "migrations/0005_seed_roles_and_permissions.sql",
      "migrations/0008_seed_graph_permissions.sql"
    ]
  }
  ingredient = {
    name                  = "dev-ingredient"
    primary_location_hint = "wnam"
    run_migrations        = true
    migrations = [
      "migrations/0006_create_ingredients.sql"
    ]
  }
  graph = {
    name                  = "dev-graph"
    primary_location_hint = "wnam"
    # run_migrations = true: aplicado automaticamente pelo terraform_data
    # do modulo d1 durante o apply (dev-graph e um banco novo, sem dados
    # de producao em risco).
    run_migrations = true
    migrations = [
      "migrations/0007_create_graph_nodes_and_edges.sql"
    ]
  }
}

workers = {
  api = {
    script_path        = "workers/api/dist/index.mjs"
    compatibility_date = "2026-08-24"
    bindings = [
      {
        name         = "INGREDIENTS_DB"
        type         = "d1"
        resource_key = "ingredient"
      }
    ]
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
  }
  ai = {
    script_path        = "workers/ai/dist/index.mjs"
    compatibility_date = "2026-08-24"
    bindings = [
      {
        name = "AI"
        type = "ai"
      }
    ]
  }
  graph = {
    script_path        = "workers/graph/dist/index.mjs"
    compatibility_date = "2026-08-24"
    bindings = [
      {
        name         = "GRAPH_DB"
        type         = "d1"
        resource_key = "graph"
      }
    ]
  }
}

rag_stacks = {
  rag = {
    script_path        = "workers/rag/dist/index.mjs"
    compatibility_date = "2026-08-24"
  }
}