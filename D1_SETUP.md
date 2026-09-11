# D1 Database Setup - Autenticação Real

Guia para configurar e usar o D1 database com o serviço de autenticação.

## 📋 Schema de Usuários

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  email TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  first_name TEXT,
  last_name TEXT,
  status TEXT DEFAULT 'active',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_login_at DATETIME
);
```

## 🚀 Setup Inicial

### 1. Criar D1 Database (via Terraform)

```hcl
d1_databases = {
  auth = {
    name                  = "dev-auth"
    primary_location_hint = "wnam"
  }
}
```

Depois:
```bash
terraform apply
```

### 2. Executar Schema SQL

```bash
# Via Wrangler CLI
wrangler d1 execute dev-auth --file=terraform/workers/auth/schema.sql --remote

# Ou via API Cloudflare
curl -X POST https://api.cloudflare.com/client/v4/accounts/{account_id}/d1/database/{database_id}/query \
  -H "Authorization: Bearer {api_token}" \
  -H "Content-Type: application/json" \
  -d '{
    "sql": "CREATE TABLE IF NOT EXISTS users (...)"
  }'
```

### 3. Vincular D1 ao Worker

No `terraform.tfvars`:

```hcl
workers = {
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
    additional_bindings = [
      {
        name = "JWT_SECRET"
        type = "plain_text"
        text = "..."
      }
    ]
  }
}
```

## 📝 Gerenciamento de Usuários

### Adicionar Novo Usuário

```sql
INSERT INTO users (id, username, email, password_hash, first_name, last_name)
VALUES (
  'user-004',
  'newuser',
  'new@example.com',
  'pbkdf2:sha256:100000:...',
  'John',
  'Doe'
);
```

**Nota**: Use a função `hashPassword()` do auth worker para gerar o hash.

### Listar Usuários

```sql
SELECT id, username, email, first_name, last_name, status, last_login_at
FROM users
WHERE status = 'active';
```

### Desativar Usuário

```sql
UPDATE users
SET status = 'inactive'
WHERE username = 'username';
```

## 🔐 Fluxo de Autenticação com D1

```
┌─────────────────────┐
│   Cliente (curl)    │
└──────────┬──────────┘
           │
           │ POST /login
           │ {username, password}
           ▼
┌──────────────────────────────────┐
│   Auth Worker                    │
│   - Valida JWT_SECRET            │
│   - Conecta ao D1                │
│   - Busca usuário por username   │
│   - Verifica senha (PBKDF2)      │
│   - Atualiza last_login          │
│   - Loga tentativa               │
│   - Gera JWT token               │
└──────────┬───────────────────────┘
           │
           │ Retorna token
           ▼
┌─────────────────────┐
│   Cliente (curl)    │
│   Armazena token    │
└─────────────────────┘
```

## 🧪 Teste de Autenticação com D1

### 1. Login (com validação do D1)

```bash
curl -X POST https://dev-auth.0xhackerspace.workers.dev/login \
  -H "Content-Type: application/json" \
  -d '{
    "username": "admin",
    "password": "password123"
  }'
```

**Resposta:**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refresh_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "user": {
    "id": "user-001",
    "username": "admin",
    "email": "admin@example.com"
  }
}
```

### 2. Ver Estatísticas de Usuários

```bash
curl https://dev-auth.0xhackerspace.workers.dev/stats
```

**Resposta:**
```json
{
  "total_users": 3,
  "active_users": 3,
  "database": "D1"
}
```

### 3. Ver Logs de Autenticação

```sql
SELECT user_id, action, status, timestamp
FROM auth_logs
ORDER BY timestamp DESC
LIMIT 10;
```

## 🛡️ Segurança

### Hashing de Senhas

Usa **PBKDF2-SHA256** com:
- 100.000 iterações
- Salt aleatório de 16 bytes
- Formato: `pbkdf2:sha256:100000:{salt}:{key}`

### Comparação Segura

Implementa comparação de tempo constante para evitar timing attacks.

### Auditoria

Cada tentativa de login é registrada em `auth_logs`:
- `user_id`: ID do usuário
- `action`: login_attempt, login_success, login_blocked
- `status`: success, failed
- `ip_address`: IP do cliente
- `timestamp`: Quando ocorreu

## 📊 Queries Úteis

### Usuários mais ativos

```sql
SELECT username, COUNT(*) as login_attempts, MAX(timestamp) as last_attempt
FROM auth_logs
WHERE action = 'login_success'
GROUP BY user_id
ORDER BY login_attempts DESC;
```

### Tentativas falhadas nas últimas 24 horas

```sql
SELECT username, COUNT(*) as failed_attempts
FROM auth_logs
WHERE action = 'login_attempt' AND status = 'failed'
AND timestamp > datetime('now', '-1 day')
GROUP BY user_id
ORDER BY failed_attempts DESC;
```

### Usuários inativos (sem login há mais de 30 dias)

```sql
SELECT username, email, last_login_at
FROM users
WHERE status = 'active'
AND (last_login_at IS NULL OR last_login_at < datetime('now', '-30 days'));
```

## 🔄 Backup e Restauração

### Fazer backup

```bash
wrangler d1 backup create dev-auth --remote
```

### Restaurar de backup

```bash
wrangler d1 backup restore dev-auth <backup_id> --remote
```

## 🚨 Troubleshooting

### "Authentication error" ao criar D1

**Problema**: API token não tem permissão para D1.

**Solução**:
1. Gere um novo token com permissão D1 Read + Write
2. Configure: `export CLOUDFLARE_API_TOKEN='...'`
3. Tente novamente

### Database não conecta do worker

**Problema**: Binding D1 não configurado.

**Solução**:
1. Verifique se `DB` binding está em `additional_bindings`
2. Verifique se `resource_key` aponta para D1 existente
3. Rode `terraform apply` novamente

### "Invalid credentials" mesmo com senha correta

**Problema**: Hash de senha não corresponde.

**Solução**:
1. Gere nova senha com a função `hashPassword()`
2. Atualize no banco: `UPDATE users SET password_hash = '...' WHERE username = '...'`

## 📚 Referências

- [Cloudflare D1 Docs](https://developers.cloudflare.com/d1/)
- [PBKDF2 Algorithm](https://tools.ietf.org/html/rfc2898)
- [Web Crypto API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API)

## Próximos Passos

1. ✅ Schema de usuários criado
2. ✅ Auth worker integrado com D1
3. ⏳ Importar usuários reais
4. ⏳ Implementar 2FA (Two-Factor Authentication)
5. ⏳ Implementar password reset
6. ⏳ Implementar rate limiting no D1
