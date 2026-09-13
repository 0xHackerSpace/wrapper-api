# Entidade: Ingredient

Representa um ingrediente gerenciado pelo `api-worker`, persistido no D1 `dev-ingredient` (ver [ADR 0004](../decisions/0004-d1-multiple-databases.md) e [diagrama de entidades](../database-diagram.md)).

## Schema

Tabela `ingredients` ([migration 0006](../../terraform/migrations/0006_create_ingredients.sql)):

| Campo | Tipo | Obrigatório | Notas |
|---|---|---|---|
| `id` | TEXT | sim (PK) | |
| `nome` | TEXT | sim | Nome de exibição; também usado como `label` do node correspondente no grafo. |
| `slug` | TEXT | sim | `UNIQUE`; identificador amigável, imutável na prática (ver Regras de negócio). |
| `type` | TEXT | sim | Categoria livre (sem `CHECK`/enum no schema). |
| `reference` | TEXT | não | |
| `url` | TEXT | não | |
| `permissions` | TEXT | não | Campo livre pré-existente; não tem relação com o RBAC (`permissions`/`profile_permissions`) do `dev-auth`, apesar do nome. |
| `created_at` | DATETIME | sim | Default `CURRENT_TIMESTAMP`. |
| `updated_at` | DATETIME | sim | Default `CURRENT_TIMESTAMP`; não há trigger de auto-update — quem atualiza é `updateIngredient()`. |

Índices: `idx_ingredients_slug`, `idx_ingredients_type`.

## Regras de negócio

- `slug` é único — criar ou atualizar com um `slug` já existente falha (`"Ingredient with this slug already exists"`), verificado explicitamente em `ingredients-db.mjs` antes do INSERT/UPDATE (não depende só da constraint do banco).
- Atualizar `slug` é permitido, mas só re-valida unicidade se o valor realmente mudou em relação ao existente.
- Não há soft-delete; `DELETE` remove a linha de fato.

## Autorização (RBAC)

Permissions dedicadas ([migration 0009](../../terraform/migrations/0009_seed_ingredient_permissions.sql)): `ingredient:read`, `ingredient:create`, `ingredient:update`, `ingredient:delete`. Perfis seedados: `profile-ingredient-user` (só `ingredient:read`) e `profile-ingredient-admin` (CRUD completo); `profile-admin` também tem as quatro.

## Endpoints (`api-worker`)

| Método | Rota | Permission |
|---|---|---|
| GET | `/ingredients` | `ingredient:read` |
| GET | `/ingredients/:id` | `ingredient:read` |
| POST | `/ingredients` | `ingredient:create` |
| PUT | `/ingredients/:id` | `ingredient:update` |
| DELETE | `/ingredients/:id` | `ingredient:delete` |
| GET | `/ingredients/:id/recommendations?relation=&indirect=&maxDepth=` | `ingredient:read` |

## Relação com o grafo de conhecimento

Conforme [ADR 0016](../decisions/0016-domain-graph-service-accounts-and-fire-and-forget-enrichment.md), todo `ingredient` é espelhado como um node no grafo dedicado `ingredients` (D1 `dev-graph`, ver [graph-sync.mjs](../../terraform/workers/api/src/lib/graph-sync.mjs)):

- Node: `type: "ingredient"`, `label: <nome>`, `properties.ingredientId: <id>`.
- Sincronização é fire-and-forget via `ctx.waitUntil()` sob o service actor fixo `svc-api-ingredients` — nunca bloqueia nem falha a resposta HTTP do `api-worker` se o `graph-worker` estiver indisponível.
- Create/update/delete do ingredient disparam `syncIngredientCreated`/`syncIngredientUpdated`/`syncIngredientDeleted`. Update busca o node pelo **label anterior** (`before.nome`) — um rename de `nome` muda o label, então a busca precisa usar o valor pré-update; se o node não for encontrado (ingredient criado antes dessa sincronização existir, ou uma sync anterior ter falhado), a sincronização se auto-corrige criando o node em vez de não fazer nada.
- `GET /ingredients/:id/recommendations` faz travessia do grafo a partir desse node e resolve cada vizinho de volta a um registro completo de `ingredient` via `properties.ingredientId` + lookup no D1; se essa propriedade não resolver mais (ingrediente removido sem o node ter sido limpo ainda), cai para `{nodeId, label}`.

## Gaps conhecidos

- `permissions` (coluna) é um campo legado sem uso claro documentado — não confundir com o sistema de RBAC.
- Sem paginação em `GET /ingredients` — retorna todos os registros.
