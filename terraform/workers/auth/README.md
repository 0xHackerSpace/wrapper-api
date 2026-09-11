# Auth Worker

Serviço de autenticação e autorização baseado em JWT (JSON Web Tokens).

## Configuração

O worker requer a variável de ambiente `JWT_SECRET` definida no binding (deve ser fornecida via `additional_bindings` a partir de uma fonte segura).

```hcl
additional_bindings = [
  {
    name = "JWT_SECRET"
    type = "plain_text"
    text = var.jwt_secret  # De um secrets manager
  }
]
```

## Endpoints

### GET /health
Health check simples.

```bash
curl https://dev-auth.0xhackerspace.workers.dev/health
# {"status":"ok","service":"auth"}
```

### GET /
Informações do serviço e endpoints disponíveis.

```bash
curl https://dev-auth.0xhackerspace.workers.dev/
```

### POST /login
Gera tokens JWT (access token + refresh token).

**Request:**
```bash
curl -X POST https://dev-auth.0xhackerspace.workers.dev/login \
  -H "Content-Type: application/json" \
  -d '{
    "username": "user123",
    "password": "password"
  }'
```

**Response:**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refresh_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "user": { "username": "user123" }
}
```

**Clams do Token:**
- `sub`: Username (subject)
- `username`: Username
- `type`: "access"
- `iat`: Issued at (timestamp)
- `exp`: Expiration (timestamp)

### POST /verify
Valida um token JWT.

**Request:**
```bash
curl -X POST https://dev-auth.0xhackerspace.workers.dev/verify \
  -H "Content-Type: application/json" \
  -d '{
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  }'
```

**Response (válido):**
```json
{
  "valid": true,
  "payload": {
    "sub": "user123",
    "username": "user123",
    "type": "access",
    "iat": 1630000000,
    "exp": 1630003600
  },
  "user": { "username": "user123" }
}
```

**Response (inválido/expirado):**
```json
{
  "error": "Invalid or expired token",
  "status": 401
}
```

### POST /refresh
Renova um token de acesso usando refresh token.

**Request:**
```bash
curl -X POST https://dev-auth.0xhackerspace.workers.dev/refresh \
  -H "Content-Type: application/json" \
  -d '{
    "refresh_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  }'
```

**Response:**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "token_type": "Bearer",
  "expires_in": 3600
}
```

## Tempos de Expiração

- **Access Token**: 3600 segundos (1 hora)
- **Refresh Token**: 604800 segundos (7 dias)

## Estrutura

```
auth/
├── src/
│   ├── index.mjs           # Handler principal com endpoints
│   └── lib/
│       ├── jwt.mjs         # Geração e validação de JWT
│       └── response.mjs    # Utilidades de resposta HTTP
└── dist/
    └── index.mjs           # Versão compilada (esbuild)
```

## Fluxo de Autenticação Típico

1. **Login**: Cliente envia `username` e `password` → Recebe `token` e `refresh_token`
2. **Requisição Autenticada**: Cliente envia `Authorization: Bearer {token}` em endpoints que exigem autenticação
3. **Verificação**: Servidor valida token via POST `/verify`
4. **Refresh**: Quando token expira, cliente usa `refresh_token` para obter novo `token`

## Notas

- Em produção, validar `username` e `password` contra banco de dados
- O `JWT_SECRET` deve ser uma string segura e longa
- Nunca compartilhe o secret entre diferentes ambientes
- Implemente rate limiting para endpoints de login
- Use HTTPS em produção (Cloudflare fornece automaticamente)
