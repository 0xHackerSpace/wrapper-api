# D1 Database Migrations

Sistema de versionamento de banco de dados usando Terraform com rastreamento automático de mudanças.

## 📁 Estrutura de Migrations

```
terraform/migrations/
├── 0001_create_users.sql       # Create users table
├── 0002_create_auth_logs.sql   # Create auth_logs table
└── 0003_seed_users.sql         # Seed initial users
```

## 🚀 Como Funciona

### Estratégia terraform_data com filesha256

```hcl
resource "terraform_data" "migrations" {
  triggers_replace = [
    for migration in var.migrations : filesha256(migration)
  ]

  provisioner "local-exec" {
    command = "npx wrangler d1 execute ... --file migration.sql --remote"
  }

  depends_on = [cloudflare_d1_database.this]
}
```

**Comportamento**:
- ✅ Detecta mudanças em qualquer arquivo de migration
- ✅ Reaplica migrations quando arquivos mudam
- ✅ Executa após criação do database
- ✅ Suporta múltiplas migrations em sequência

## 📝 Adicionar Nova Migration

### 1. Criar Arquivo SQL

```bash
# Criar arquivo com número sequencial
touch terraform/migrations/0004_add_column.sql
```

**Nomear como**: `NNNN_description.sql`
- `NNNN`: Número sequencial (0001, 0002, etc.)
- `description`: Descrição breve do que faz

### 2. Escrever SQL

```sql
-- Migration: 0004_add_column
-- Description: Add last_logout_at column to users
-- Created: 2026-09-11

ALTER TABLE users ADD COLUMN last_logout_at DATETIME;

CREATE INDEX idx_users_last_logout ON users(last_logout_at);
```

**Boas Práticas**:
- ✅ Use `IF NOT EXISTS` / `IF NOT EXISTS` para idempotência
- ✅ Adicione comentário no início com número e descrição
- ✅ Uma migration = um conceito/mudança lógica
- ✅ Mantenha migrations pequenas e focadas

### 3. Atualizar terraform.tfvars

```hcl
d1_databases = {
  auth = {
    name          = "dev-auth"
    run_migrations = true
    migrations = [
      "terraform/migrations/0001_create_users.sql",
      "terraform/migrations/0002_create_auth_logs.sql",
      "terraform/migrations/0003_seed_users.sql",
      "terraform/migrations/0004_add_column.sql"  # ← Nova
    ]
  }
}
```

### 4. Aplicar com Terraform

```bash
# Exportar API token
export CLOUDFLARE_API_TOKEN='seu-token-com-d1-permissao'

# Aplicar
terraform apply -var-file=environments/dev/terraform.tfvars
```

## 🔄 Fluxo de Desenvolvimento

### Local Development

```bash
# 1. Criar migration
touch terraform/migrations/0004_my_change.sql
echo "ALTER TABLE users ADD COLUMN..." > terraform/migrations/0004_my_change.sql

# 2. Atualizar tfvars com nova migration

# 3. Validar e aplicar
terraform validate
terraform plan -var-file=environments/dev/terraform.tfvars
terraform apply -var-file=environments/dev/terraform.tfvars
```

### CI/CD Pipeline

```yaml
- name: Apply Migrations
  env:
    CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
  run: |
    terraform apply -var-file=environments/${{ env.ENVIRONMENT }}/terraform.tfvars
```

## 📊 Migrations Existentes

### 0001_create_users.sql
- Cria tabela `users`
- Campos: id, username, email, password_hash, status, timestamps
- Índices para username, email, status

### 0002_create_auth_logs.sql
- Cria tabela `auth_logs`
- Rastreia: login attempts, status, IP, user agent
- FK para users (id)
- Índices para user_id, timestamp, action+status

### 0003_seed_users.sql
- Insere 3 usuários de teste
- Admin, TestUser, Demo
- Status: active
- **Nota**: Senhas em desenvolvimento (nunca em prod)

## 🔒 Segurança em Migrations

### ❌ Nunca colocar em migrations versionadas

```sql
-- ❌ ERRADO - Senhas em texto claro
INSERT INTO users (username, password_hash)
VALUES ('admin', 'plain_text_password');

-- ❌ ERRADO - Chaves de API
INSERT INTO config (key, value)
VALUES ('api_key', 'sk-1234567890');
```

### ✅ Forma Correta

```sql
-- ✅ CORRETO - Placeholder ou hash
INSERT INTO users (username, password_hash)
VALUES ('admin', 'pbkdf2:sha256:...');

-- ✅ CORRETO - Usar var ou secrets manager
-- Valores sensíveis via additional_bindings
```

## 🧪 Testar Migrations

### Via Wrangler CLI

```bash
# Executar migration específica
wrangler d1 execute dev-auth --file=terraform/migrations/0001_create_users.sql --remote

# Ver estado do database
wrangler d1 info dev-auth --remote

# Query no database
wrangler d1 execute dev-auth --command="SELECT * FROM users;" --remote
```

### Via Terraform

```bash
# Plan mostra o que vai mudar
terraform plan -var-file=environments/dev/terraform.tfvars

# Apply executa as migrations
terraform apply -var-file=environments/dev/terraform.tfvars

# State contém referência aos arquivos
terraform state list
```

## 🔧 Troubleshooting

### "Authentication error" ao rodar migrations

**Problema**: API token sem permissão D1

**Solução**:
1. Gere novo token: https://dash.cloudflare.com/profile/api-tokens
2. Permissões necessárias: `D1 > D1 Read` e `D1 > D1 Write`
3. Exporte: `export CLOUDFLARE_API_TOKEN='novo-token'`
4. Tente novamente: `terraform apply ...`

### Migration não está sendo reaplicada

**Problema**: Arquivo não mudou, então terraform não detecta

**Solução**:
```bash
# Forçar re-execução via taint
terraform taint module.d1[\"auth\"].terraform_data.migrations[0]
terraform apply -var-file=environments/dev/terraform.tfvars
```

### Erro "table already exists"

**Problema**: Já executou essa migration antes

**Solução**:
```sql
-- Use IF NOT EXISTS
CREATE TABLE IF NOT EXISTS users (...)

-- Ou IF NOT FOUND para alter
ALTER TABLE users ADD COLUMN IF NOT EXISTS new_col TEXT;
```

### Database não conecta do worker

**Problema**: D1 binding não configurado

**Solução**:
1. Verifique tfvars tem binding D1:
```hcl
bindings = [{
  name = "DB"
  type = "d1"
  resource_key = "auth"
}]
```
2. Rode `terraform apply` novamente
3. Verifique conexão no auth worker

## 📚 Referências

- [Cloudflare D1 Docs](https://developers.cloudflare.com/d1/)
- [Wrangler D1 CLI](https://developers.cloudflare.com/workers/wrangler/commands/#d1)
- [Terraform local-exec](https://www.terraform.io/language/resources/provisioners/local-exec)
- [Terraform data provisioners](https://www.terraform.io/language/resources/terraform-data)

## ✅ Checklist para Nova Migration

- [ ] Arquivo nomeado: `NNNN_description.sql`
- [ ] Comentário no início com número/descrição
- [ ] Use `IF NOT EXISTS` para segurança
- [ ] Sem dados sensíveis (senhas, tokens, etc)
- [ ] Adicionar path ao `migrations` list no tfvars
- [ ] Validar: `terraform validate`
- [ ] Planejar: `terraform plan`
- [ ] Aplicar: `terraform apply`
- [ ] Testar: `wrangler d1 execute ... --command "..."`
- [ ] Commit junto com tfvars
