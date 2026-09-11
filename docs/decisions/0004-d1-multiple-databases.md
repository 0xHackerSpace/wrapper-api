# ADR 0004: Múltiplos bancos de dados D1

Usamos múltiplos bancos de dados D1 separados por domínio funcional: `dev-auth` para autenticação e RBAC, `dev-ingredient` para dados de ingredientes.

**Motivação:**

- Separa responsabilidades e modelos de dados por contexto
- Facilita escalabilidade independente de cada banco
- Permite diferentes estratégias de backup, replicação e migração por domínio
- Cada Worker que precisa acessar um banco recebe um binding D1 específico no `terraform/environments/dev/terraform.tfvars`

**Implementação:**

Cada D1 é declarado em `d1_databases` do tfvars com sua própria configuração:

```hcl
d1_databases = {
  auth = {
    name = "dev-auth"
    run_migrations = true
    migrations = ["terraform/migrations/000X_*.sql"]
  }
  ingredient = {
    name = "dev-ingredient"
    run_migrations = true
    migrations = ["terraform/migrations/000X_*.sql"]
  }
}
```

Workers recebem bindings via `bindings` no tfvars. O módulo `terraform/modules/worker` resolve `resource_key` para o `database_id` correspondente via `locals.worker_bindings`.

**Migrações:**

Cada banco é migrado independentemente via `wrangler d1 execute` apontando para um arquivo de migration específico. Migrations são versionadas numericamente e executadas sequencialmente (ex: `0006_create_ingredients.sql`).
