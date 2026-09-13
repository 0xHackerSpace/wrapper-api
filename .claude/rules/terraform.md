---
paths:
  - "terraform/**/*.tf"
---

# Terraform Rules for wrapper-api

## Naming Conventions

- **Resources**: `snake_case` (e.g., `cloudflare_workers_kv_namespace`, `cloudflare_d1_database`)
- **Variables**: `snake_case` (e.g., `jwt_secret`, `environment_name`)
- **Outputs**: `snake_case` 
- **Local values**: `snake_case`
- **Data sources**: `snake_case`
- **Worker names**: `snake_case` in Terraform, must match file structure in `terraform/workers/{name}/`

## Module Structure

### Worker Modules
Each worker in `terraform/modules/worker/`:
```
Module inputs:
- name: string (e.g., "api-worker")
- script_path: string (path to dist/index.mjs)
- compatibility_date: string (e.g., "2026-08-24")
- bindings: list (KV, D1, R2, Analytics Engine, etc.)
- routes: list (route patterns like "example.com/api/*")
- service_bindings: list (service-to-service bindings if needed)
```

Module outputs:
- `worker_id`: for cross-module references
- `routes`: for route binding references

### Database Modules
For D1 creation:
```
Module inputs:
- account_id: string
- db_name: string (e.g., "dev-auth", "dev-ingredient")
- database_id: string (Cloudflare auto-generated)
- initialization_sql: optional
```

Outputs:
- `database_id`: for worker bindings
- `binding_name`: standardized binding name for workers

## Bindings Best Practices

### D1 Bindings
- Binding name = database name (snake_case)
- Example: `dev_auth`, `dev_ingredient`
- Always pass `database_id` from D1 module outputs
- Include in worker `env` or `plain_text_bindings`

### KV Bindings
- Naming: `{feature}_kv` (e.g., `cache_kv`, `session_kv`)
- Use `namespace_id` from KV module

### R2 Bindings
- Naming: `{purpose}_bucket` (e.g., `uploads_bucket`, `logs_bucket`)
- Use `bucket_id` from R2 module

### Service Bindings
- For worker-to-worker communication
- Format: `service_name = { service = "worker-name" }`
- Document in comments why service binding is needed

## Variables & Secrets

### Sensitive Variables
- `jwt_secret`: Never hardcode, use `var.jwt_secret` (injected at runtime)
- All workers that need JWT validation must receive `jwt_secret` binding
- Example in tfvars: Set via environment: `export TF_VAR_jwt_secret="..."`

### Environment-Specific Variables
- Store in `terraform/environments/{env}/terraform.tfvars`
- Include: `environment_name`, `account_id`, `zone_id`, `workers`, `d1_databases`
- Never commit `.tfvars` files with secrets

## Imports & Data Sources

### Cloudflare Resources
- Always authenticate via `provider "cloudflare"` with API token
- Use data sources to reference existing resources (e.g., `data "cloudflare_zone"`)
- Never hardcode zone IDs or account IDs; use variables

### Local File References
- Use `file()` to read migration SQL or startup scripts
- Store SQL files in `migrations/{db}/` directory
- Reference as: `file("${path.module}/../../migrations/{db}/{file}.sql")`

## Worker Configuration

### Script Path
- Must point to compiled output: `terraform/workers/{name}/dist/index.mjs`
- esbuild resolves imports; Terraform just references the dist file
- Compatibility date should align with Cloudflare platform version (currently `2026-08-24`)

### Bindings Order
```hcl
bindings = [
  # D1 databases first
  {
    name         = "dev_auth"
    type         = "d1"
    database_id  = module.db_auth.database_id
  },
  # Then KV, R2, etc.
  {
    name         = "cache_kv"
    type         = "kv_namespace"
    namespace_id = cloudflare_workers_kv_namespace.cache.id
  },
  # Secret bindings last
  {
    name = "jwt_secret"
    type = "plain_text"
    text = var.jwt_secret
  }
]
```

## Routes & Patterns

### Route Patterns
- Format: `{subdomain}.{domain.com}/{path}/*`
- Example: `api.example.com/ingredients/*`
- Use descriptive comments for routing logic
- One route per worker in most cases; use middleware pattern for shared routes

### Route Ordering
- More specific routes before general routes (Terraform processes in order)
- Document any route conflicts or overrides

## D1 Databases

### Database Naming
- Format: `{env}-{feature}` (e.g., `dev-auth`, `dev-ingredient`)
- One database per major feature domain (not monolithic)
- Binding name matches database name (snake_case)

### Migrations
- Store in `migrations/{db}/{sequence}-{name}.sql`
- Execute via: `wrangler d1 execute {db} --remote < migrations/{db}/{file}.sql`
- Document in PR if schema changes affect workers
- Never auto-apply migrations; manual execution with confirmation

## State Management

### Remote State
- Use HCP Terraform workspace: `0xHackerSpace/config/wrapper-api`
- State is managed remotely; never commit `terraform.tfstate`
- Use `terraform output` to fetch values locally if needed

### Local Development
- Dev environment in `terraform/environments/dev/terraform.tfvars`
- Never run `terraform apply` locally; use CI/CD for production
- For local testing, use `terraform plan` only

## When to Ask for Confirmation

- ❌ Changes to `terraform/main.tf` or new modules
- ❌ Adding or removing workers
- ❌ Database schema changes (migrations)
- ❌ Auth/permission structure changes
- ❌ Anything affecting `production` environment
- ✅ Small fixes (variable name typos, output formatting, comments)
- ✅ Routine updates within existing modules (e.g., adding a binding to a worker)

## Common Patterns

### Adding a New Worker
1. Create folder: `terraform/workers/{name}/src/`
2. Implement handler in `src/index.mjs`
3. Add to build script: `scripts/build-workers.mjs`
4. Define module in `terraform/modules/worker/` if custom logic needed
5. Add to `terraform/environments/dev/terraform.tfvars`:
   ```hcl
   "{name}" = {
     script_path        = "workers/{name}/dist/index.mjs"
     compatibility_date = "2026-08-24"
     bindings           = [...]
     routes             = ["api.example.com/{path}/*"]
   }
   ```
6. Run: `npm run build:workers && terraform plan`

### Adding a D1 Database
1. Create module in `terraform/modules/databases/`
2. Add to `terraform/main.tf` (or environment-specific file)
3. Pass `database_id` to workers that need it
4. Document schema in `docs/architecture.md`
5. Create migration files in `migrations/{db}/`

## Code Quality

- Run `terraform fmt` before commit
- Use `terraform validate` to check syntax
- Use `terraform plan` to review changes before apply
- Include comments for non-obvious resource choices
- No placeholder values; use meaningful variable defaults

## Links & References
- Project CLAUDE.md: Architecture overview, decision records in `docs/decisions/`
- ADRs: `docs/decisions/` (especially 0004 for D1 strategy, 0005 for JWT)
- Build script: `scripts/build-workers.mjs`
- Terraform commands: See project CLAUDE.md "Useful Commands"