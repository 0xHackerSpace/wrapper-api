# Auth Worker - Exemplos de Uso

## Configuração do JWT_SECRET

Antes de usar o worker, configure o `JWT_SECRET` no `terraform.tfvars`:

```hcl
workers = {
  auth = {
    script_path        = "workers/auth/dist/index.mjs"
    compatibility_date = "2026-08-24"
    additional_bindings = [
      {
        name = "JWT_SECRET"
        type = "plain_text"
        text = "sua-chave-secreta-muito-segura-e-longa"
      }
    ]
  }
}
```

## Fluxo Completo de Autenticação

### 1. Login e Obter Tokens

```bash
RESPONSE=$(curl -s -X POST https://dev-auth.0xhackerspace.workers.dev/login \
  -H "Content-Type: application/json" \
  -d '{
    "username": "john_doe",
    "password": "secure_password_123"
  }')

echo "$RESPONSE" | jq .

# Extrair tokens
ACCESS_TOKEN=$(echo "$RESPONSE" | jq -r '.token')
REFRESH_TOKEN=$(echo "$RESPONSE" | jq -r '.refresh_token')

echo "Access Token: $ACCESS_TOKEN"
echo "Refresh Token: $REFRESH_TOKEN"
```

**Resposta esperada:**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJqb2huX2RvZSIsInVzZXJuYW1lIjoiam9obl9kb2UiLCJ0eXBlIjoiYWNjZXNzIiwiaWF0IjoxNjk0NDU0MDAwLCJleHAiOjE2OTQ0NTc2MDB9.abc123...",
  "refresh_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJqb2huX2RvZSIsInVzZXJuYW1lIjoiam9obl9kb2UiLCJ0eXBlIjoicmVmcmVzaCIsImlhdCI6MTY5NDQ1NDAwMCwiZXhwIjoxNjk1MDU4ODAwfQ.xyz789...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "user": {
    "username": "john_doe"
  }
}
```

### 2. Verificar Token

Use o access token para verificar validade em outros serviços:

```bash
curl -s -X POST https://dev-auth.0xhackerspace.workers.dev/verify \
  -H "Content-Type: application/json" \
  -d "{\"token\": \"$ACCESS_TOKEN\"}" | jq .
```

**Resposta (válido):**
```json
{
  "valid": true,
  "payload": {
    "sub": "john_doe",
    "username": "john_doe",
    "type": "access",
    "iat": 1694454000,
    "exp": 1694457600
  },
  "user": {
    "username": "john_doe"
  }
}
```

### 3. Usar Token em Requisições

Envie o token via header `Authorization`:

```bash
curl -s https://api.0xhackerspace.workers.dev/protected \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json"
```

**Middleware/Handler verificar no seu worker:**
```javascript
const token = request.headers.get("Authorization")?.replace("Bearer ", "");
const payload = await verifyToken(token, env.JWT_SECRET);

if (!payload) {
  return new Response("Unauthorized", { status: 401 });
}

// Usar payload.username para identificar o usuário
```

### 4. Renovar Token (quando expirar)

Quando o access token expirar (após 1 hora), use o refresh token:

```bash
curl -s -X POST https://dev-auth.0xhackerspace.workers.dev/refresh \
  -H "Content-Type: application/json" \
  -d "{\"refresh_token\": \"$REFRESH_TOKEN\"}" | jq .
```

**Resposta:**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJqb2huX2RvZSIsInVzZXJuYW1lIjoiam9obl9kb2UiLCJ0eXBlIjoiYWNjZXNzIiwiaWF0IjoxNjk0NDU3NjAwLCJleHAiOjE2OTQ0NjEyMDB9.def456...",
  "token_type": "Bearer",
  "expires_in": 3600
}
```

## Usando em Outros Workers

### Exemplo: Middleware de Autenticação

```javascript
import { verifyToken } from "../auth/src/lib/jwt.mjs";

async function requireAuth(request, env) {
  const authHeader = request.headers.get("Authorization");
  
  if (!authHeader?.startsWith("Bearer ")) {
    return { error: "Missing authorization header", status: 401 };
  }

  const token = authHeader.slice(7); // Remove "Bearer "
  const payload = await verifyToken(token, env.JWT_SECRET);

  if (!payload) {
    return { error: "Invalid or expired token", status: 401 };
  }

  return { payload, status: null };
}

// Usar no handler
export default {
  async fetch(request, env, ctx) {
    const auth = await requireAuth(request, env);
    
    if (auth.status) {
      return new Response(JSON.stringify(auth), { status: auth.status });
    }

    const { payload } = auth;
    console.log(`Usuário autenticado: ${payload.username}`);
    
    // Continuar processamento...
  },
};
```

## Estrutura do Payload JWT

```javascript
{
  "sub": "john_doe",              // Subject (identificador único)
  "username": "john_doe",         // Username
  "type": "access",               // "access" ou "refresh"
  "iat": 1694454000,              // Issued at (timestamp Unix)
  "exp": 1694457600               // Expiration (timestamp Unix)
}
```

## Tratamento de Erros

### Requisições Inválidas

```bash
curl -X POST https://dev-auth.0xhackerspace.workers.dev/login \
  -H "Content-Type: application/json" \
  -d '{"username": "ab"}'  # Username muito curto

# Resposta: 400 Bad Request
# {"error":"Invalid username"}
```

### Token Expirado

```bash
curl -X POST https://dev-auth.0xhackerspace.workers.dev/verify \
  -H "Content-Type: application/json" \
  -d '{"token":"eyJ...expired..."}'

# Resposta: 401 Unauthorized
# {"error":"Invalid or expired token"}
```

## Segurança

- ✅ Tokens são assinados com HS256 (HMAC-SHA256)
- ✅ Expiração implementada (`exp` claim)
- ✅ Validação de assinatura garante integridade
- ⚠️ Use HTTPS em produção (Cloudflare fornece)
- ⚠️ Mantenha `JWT_SECRET` seguro (não compartilhe)
- ⚠️ Valide credenciais contra banco de dados em produção

## Próximos Passos

1. Conectar a uma base de dados (D1) para validar usuários
2. Implementar rate limiting para login
3. Adicionar refresh token rotation
4. Implementar revogação de tokens (blacklist)
5. Adicionar claims adicionais (roles, permissions)
