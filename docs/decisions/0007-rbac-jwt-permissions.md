# ADR 0007: RBAC com Permissões no JWT

Usamos Role-Based Access Control (RBAC) com permissões incluídas no JWT retornado pelo endpoint `/login`.

**Modelo de Dados:**

Quatro tabelas gerenciam o RBAC:

1. **profiles**: Papéis (Admin, User, Guest, RAG User, API User)
2. **permissions**: Ações por recurso (ex: `user:create`, `api:access`, `rag:query`)
3. **user_profiles**: Relação N:M entre usuários e papéis
4. **profile_permissions**: Relação N:M entre papéis e permissões

**Payload do JWT:**

```json
{
  "sub": "user-id",
  "username": "username",
  "type": "access",
  "permissions": ["resource:action", "resource:action"],
  "profiles": ["profile_name"],
  "iat": 1234567890,
  "exp": 1234571490
}
```

**Fluxo:**

1. Login: `POST /login` valida credenciais
2. Fetch: Queries em `user_profiles` → `profiles` → `profile_permissions` → `permissions`
3. Transform: Array de `{resource, action, profile}` → array de strings `"resource:action"`
4. Encode: JWT inclui `permissions` e `profiles`
5. Client: Decodifica JWT e verifica `permissions` antes de chamar endpoints protegidos

**Recursos e Ações Predefinidos:**

- `user`: create, read, update, delete
- `profile`: create, read, update, delete
- `permission`: create, read, update, delete
- `auth`: login, logout
- `api`: access
- `rag`: ingest, query

**Profiles Predefinidos:**

- **Admin**: Todas as 17 permissões
- **User**: 5 permissões (api:access, auth:login/logout, rag:query, user:read)
- **Guest**: 2 permissões (auth:login, rag:query)
- **RAG User**: Permissões de RAG (ingest, query) + auth
- **API User**: Permissões de API (access) + auth

**Autorização no Worker API:**

Endpoints protegidos verificam JWT e consultam `payload.permissions` antes de executar a ação. A responsabilidade é **partilhada**:
- **Backend**: Valida JWT e lista permissões
- **Frontend/Client**: Decodifica JWT e controla UI baseado em `permissions`
- **Ambos**: Respeitam permissões em operações críticas
