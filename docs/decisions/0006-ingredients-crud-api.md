# ADR 0006: API CRUD para Ingredientes

Ingredientes são gerenciados via endpoints RESTful no Worker API (`https://dev-api.0xhackerspace.workers.dev/ingredients`), com dados armazenados em D1 (`dev-ingredient`).

**Schema:**

```sql
CREATE TABLE ingredients (
  id TEXT PRIMARY KEY,
  nome TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  reference TEXT,
  url TEXT,
  permissions TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
)
```

**Endpoints:**

- `GET /ingredients` - Lista todos os ingredientes
- `GET /ingredients/:id` - Obtém ingrediente por ID
- `POST /ingredients` - Cria novo ingrediente (requer: `nome`, `slug`, `type`)
- `PUT /ingredients/:id` - Atualiza ingrediente
- `DELETE /ingredients/:id` - Deleta ingrediente

**Validações:**

- `slug` é único (UNIQUE constraint no banco)
- `nome`, `slug` e `type` são obrigatórios
- `reference`, `url`, `permissions` são opcionais
- IDs são UUIDs gerados via `crypto.randomUUID()`

**Respostas de Erro:**

- `400 Bad Request`: Campos obrigatórios faltando
- `404 Not Found`: Recurso não existe
- `409 Conflict`: Slug já existente (ou outro conflito de unicidade)
- `500 Internal Server Error`: Erro no banco de dados

**Implementação:**

- Handler functions em `terraform/workers/api/src/index.mjs`
- Queries em `terraform/workers/api/src/lib/ingredients-db.mjs`
- D1 binding `INGREDIENTS_DB` disponível para o Worker API

**Timestamps:**

- `created_at` é definido automaticamente no INSERT
- `updated_at` é atualizado no UPDATE
- Ambos são returnados nas respostas
