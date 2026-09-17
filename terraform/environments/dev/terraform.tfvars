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
      "migrations/0008_seed_graph_permissions.sql",
      "migrations/0009_seed_ingredient_permissions.sql",
      "migrations/0011_seed_ai_permissions.sql",
      "migrations/0012_seed_auth_stats_permission.sql",
      "migrations/0013_add_graphrag_permission.sql",
      "migrations/0017_seed_agent_permissions.sql"
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
    # do modulo d1 durante o apply. 0007 ja criou nodes/edges com dados;
    # 0010 e ALTER-based e faz backfill para nao perder linhas existentes.
    run_migrations = true
    migrations = [
      "migrations/0007_create_graph_nodes_and_edges.sql",
      "migrations/0010_add_graph_containers_and_access.sql"
    ]
  }
  chat = {
    name                  = "dev-chat"
    primary_location_hint = "wnam"
    run_migrations        = true
    migrations = [
      "migrations/0014_create_chat_sessions.sql",
      "migrations/0015_add_chat_access.sql",
      "migrations/0018_add_agent_snapshot_to_chat_sessions.sql",
      "migrations/0020_add_agent_tools_snapshot_to_chat_sessions.sql",
      "migrations/0022_add_agent_graph_id_snapshot_to_chat_sessions.sql"
    ]
  }
  agents = {
    name                  = "dev-agents"
    primary_location_hint = "wnam"
    run_migrations        = true
    migrations = [
      "migrations/0016_create_agents.sql",
      "migrations/0019_add_tools_to_agents.sql",
      "migrations/0021_add_graph_id_to_agents.sql"
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
    service_bindings = [
      { name = "GRAPH_WORKER", target_worker = "graph" }
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
      },
      {
        name         = "CHAT_DB"
        type         = "d1"
        resource_key = "chat"
      },
      {
        name         = "AGENTS_DB"
        type         = "d1"
        resource_key = "agents"
      }
    ]
    service_bindings = [
      { name = "RAG_WORKER", target_rag = "rag" },
      { name = "GRAPH_WORKER", target_worker = "graph" }
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
  graphrag = {
    script_path        = "workers/graphrag/dist/index.mjs"
    compatibility_date = "2026-08-24"
    service_bindings = [
      { name = "RAG_WORKER", target_rag = "rag" },
      { name = "GRAPH_WORKER", target_worker = "graph" },
      { name = "AI_WORKER", target_worker = "ai" }
    ]
  }
}

rag_stacks = {
  rag = {
    script_path        = "workers/rag/dist/index.mjs"
    compatibility_date = "2026-08-24"
    service_bindings = [
      { name = "GRAPH_WORKER", target_worker = "graph" },
      { name = "AI_WORKER", target_worker = "ai" }
    ]
  }
}