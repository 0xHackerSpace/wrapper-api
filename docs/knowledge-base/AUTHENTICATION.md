# Autenticação com JWT

Todos os workers (API e RAG) usam **JWT (JSON Web Tokens)** para autenticação. Os tokens são gerados pelo serviço `auth` e validados automaticamente pelos serviços protegidos.

## Fluxo de Autenticação

```
┌─────────────┐
│   Client    │
└──────┬──────┘
       │
       │ 1. POST /login (username, password)
       ▼
┌──────────────────────────────────┐
│  Auth Worker                     │
│  https://dev-auth.workers.dev    │
└──────────────────┬───────────────┘
       │
       │ 2. Retorna JWT token
       ▼
┌──────────────────────────────────┐
│  Client armazena token           │
└──────────────────┬───────────────┘
       │
       │ 3. Authorization: Bearer {token}
       ▼
┌──────────────────────────────────┐
│  API/RAG Worker                  │
│  Valida JWT automaticamente      │
│  Processa requisição se válido   │
└──────────────────────────────────┘
```

## Serviço de Autenticação

**URL**: `https://dev-auth.0xhackerspace.workers.dev`

### 1. Fazer Login

```bash
curl -X POST https://dev-auth.0xhackerspace.workers.dev/login \
  -H "Content-Type: application/json" \
  -d '{
    "username": "user123",
    "password": "password"
  }'
```

**Resposta:**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refresh_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "user": { "username": "user123" }
}
```

### 2. Usar Token em Requisições

Guarde o `token` retornado e envie em todas as requisições protegidas:

```bash
curl -X GET https://dev-api.0xhackerspace.workers.dev/protected \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
```

### 3. Renovar Token (quando expirar)

Quando o token expirar, use o `refresh_token`:

```bash
curl -X POST https://dev-auth.0xhackerspace.workers.dev/refresh \
  -H "Content-Type: application/json" \
  -d '{"refresh_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."}'
```

## Worker API

**URL**: `https://dev-api.0xhackerspace.workers.dev`

### Endpoints Públicos

#### GET /health
Sem autenticação.
```bash
curl https://dev-api.0xhackerspace.workers.dev/health
```

#### GET /
Sem autenticação. Retorna informações do serviço.
```bash
curl https://dev-api.0xhackerspace.workers.dev/
```

### Endpoints Protegidos

Requerem `Authorization: Bearer {token}`

#### GET /protected
Acesso a recurso protegido.

```bash
curl -X GET https://dev-api.0xhackerspace.workers.dev/protected \
  -H "Authorization: Bearer {token}"
```

**Resposta:**
```json
{
  "message": "Access to protected resource granted",
  "user": {
    "sub": "user123",
    "username": "user123"
  },
  "token_info": {
    "issued_at": "2026-09-10T20:00:00.000Z",
    "expires_at": "2026-09-10T21:00:00.000Z",
    "type": "access"
  }
}
```

#### GET /profile
Retorna informações do perfil do usuário autenticado.

```bash
curl -X GET https://dev-api.0xhackerspace.workers.dev/profile \
  -H "Authorization: Bearer {token}"
```

## Worker RAG

**URL**: `https://dev-rag.0xhackerspace.workers.dev`

Todos os endpoints (exceto `/health`) requerem autenticação JWT.

### GET /health
Sem autenticação.
```bash
curl https://dev-rag.0xhackerspace.workers.dev/health
```

### POST /ingest
Ingesta documento para indexação.

```bash
curl -X POST https://dev-rag.0xhackerspace.workers.dev/ingest \
  -H "Authorization: Bearer {token}" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Seu documento aqui...",
    "source": "documento-1.txt",
    "metadata": { "category": "tutorial" }
  }'
```

### POST /query
Consulta documentos indexados.

```bash
curl -X POST https://dev-rag.0xhackerspace.workers.dev/query \
  -H "Authorization: Bearer {token}" \
  -H "Content-Type: application/json" \
  -d '{
    "question": "Qual é o assunto do documento?"
  }'
```

## Configuração do JWT_SECRET

O `JWT_SECRET` deve ser configurado em cada worker via `additional_bindings`.

No `terraform.tfvars`:

```hcl
workers = {
  api = {
    script_path        = "workers/api/dist/index.mjs"
    compatibility_date = "2026-08-24"
    additional_bindings = [
      {
        name = "JWT_SECRET"
        type = "plain_text"
        text = var.jwt_secret  # De um secrets manager
      }
    ]
  }
}

rag_stacks = {
  rag = {
    script_path        = "workers/rag/dist/index.mjs"
    compatibility_date = "2026-08-24"
    additional_bindings = [
      {
        name = "JWT_SECRET"
        type = "plain_text"
        text = var.jwt_secret  # Mesmo valor que no API
      }
    ]
  }
}
```

## Tratamento de Erros

### 401 Unauthorized
```json
{
  "error": "Missing authorization token"
}
```

### 401 Invalid Token
```json
{
  "error": "Invalid or expired token"
}
```

### 500 JWT_SECRET não configurado
```json
{
  "error": "JWT_SECRET not configured"
}
```

## Fluxo Completo - Exemplo Prático

### 1. Login
```bash
AUTH_RESPONSE=$(curl -s -X POST https://dev-auth.0xhackerspace.workers.dev/login \
  -H "Content-Type: application/json" \
  -d '{"username": "john_doe", "password": "secure_pass"}')

TOKEN=$(echo $AUTH_RESPONSE | jq -r '.token')
echo "Token: $TOKEN"
```

### 2. Usar em API
```bash
curl -s -X GET https://dev-api.0xhackerspace.workers.dev/profile \
  -H "Authorization: Bearer $TOKEN" | jq .
```

### 3. Usar em RAG
```bash
curl -s -X POST https://dev-rag.0xhackerspace.workers.dev/ingest \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Conteúdo do documento",
    "source": "doc.txt"
  }' | jq .
```

### 4. Renovar Token (quando expirar)
```bash
REFRESH_TOKEN=$(echo $AUTH_RESPONSE | jq -r '.refresh_token')

NEW_TOKEN=$(curl -s -X POST https://dev-auth.0xhackerspace.workers.dev/refresh \
  -H "Content-Type: application/json" \
  -d "{\"refresh_token\": \"$REFRESH_TOKEN\"}" | jq -r '.token')

echo "Novo token: $NEW_TOKEN"
```

## Segurança

- ✅ JWT assinado com HS256
- ✅ Tokens expiram automaticamente
- ✅ Refresh tokens permitem renovação
- ✅ Validação de assinatura em cada request
- ⚠️ Mantenha `JWT_SECRET` seguro
- ⚠️ Use HTTPS em produção (Cloudflare fornece)
- ⚠️ Implemente rate limiting no auth worker
- ⚠️ Valide credenciais contra banco de dados

## Próximos Passos

1. Conectar auth worker com D1 database
2. Implementar hash de senhas (bcrypt)
3. Adicionar refresh token rotation
4. Implementar token blacklist/revogação
5. Adicionar claims adicionais (roles, permissions)
6. Implementar rate limiting
