# Spec: AI Chat and Auth Stats Permission Enforcement

## Contexto

A [ADR 0013](../decisions/0013-jwt-permission-enforcement.md) aplicou o enforcement de permissions do JWT em `api-worker`, `graph-worker` e `rag-worker`, mas deixou `ai-worker` (inteiramente público) e `GET /stats` do `auth-worker` (também público) fora de escopo — na época, adicionar auth a rotas antes públicas foi tratado como uma decisão de acesso distinta de "aplicar o que já existe". Este spec fecha essa lacuna para essas duas rotas.

Nenhuma mudança de Terraform é necessária: `JWT_SECRET` já é injetado em **todo** worker de `var.workers` via o merge em `locals.tf` (`local.jwt_secret_binding` é concatenado aos bindings de cada worker), `ai` incluso. O trabalho é só código + duas migrations novas de seed.

## Fora de escopo

- `GET /v1/models` (ai-worker) — continua público.
- `POST /login`, `POST /signup`, `POST /verify`, `POST /refresh` (auth-worker) — continuam como estão. `/verify` e `/refresh` já validam um token recebido no corpo da requisição (não usam header `Authorization: Bearer`), não fazem sentido como "rotas protegidas" no mesmo sentido das outras.
- Qualquer profile novo dedicado a IA (ex: "AI User") — decidido explicitamente contra, ver abaixo.

## Mudanças por worker

### `ai-worker`

Hoje não tem nenhuma infraestrutura de auth (sem `lib/auth.mjs`, sem `lib/jwt.mjs`). Precisa ganhar ambos, no mesmo padrão de `api-worker`/`graph-worker` (cópia própria por worker, já que o esbuild bundla cada um isoladamente — ver ADR 0013).

- `GET /health`, `GET /`, `GET /v1/models` — sem mudança, continuam públicas.
- `POST /v1/chat/completions` — passa a exigir `requirePermission(request, env, "ai:chat")` como primeira linha do handler, antes do check de `env.AI`.

### `auth-worker`

Ganha um `lib/auth.mjs` novo (reaproveitando o `verifyToken` que já existe em `lib/jwt.mjs`, usado hoje só para emitir/validar tokens dentro de `/verify` e `/refresh`).

- `POST /login`, `POST /signup`, `POST /verify`, `POST /refresh`, `GET /health`, `GET /` — sem mudança.
- `GET /stats` — passa a exigir `requirePermission(request, env, "auth:stats")` como primeira linha do handler, antes do check de `env.DB`.

### Comportamento sem `JWT_SECRET` configurado

Ambos falham fechado: `requireAuth` lança `AuthError(500, "JWT_SECRET not configured")`, igual `api-worker`/`graph-worker`. Não seguem o padrão do `rag-worker` (que pula a checagem quando `JWT_SECRET` está ausente) — esse comportamento do `rag-worker` foi uma concessão a algo pré-existente antes do enforcement; `ai-worker` e o `/stats` do `auth-worker` nunca tiveram checagem nenhuma antes, então não há legado a preservar.

## Novas permissions e profiles

Duas migrations novas, seguindo o padrão de uma por recurso (mesmo estilo de `0008_seed_graph_permissions.sql` / `0009_seed_ingredient_permissions.sql`):

**`0011_seed_ai_permissions.sql`**
- Permission `ai:chat` ("Use AI chat completions").
- Atribuída **só** a `profile-admin`. Decisão deliberada: nenhum profile intermediário (nem o `User` básico) recebe acesso — quem quiser usar o chat precisa ser promovido a Admin. Não foi criado um profile dedicado tipo "AI User" porque `ai:chat` é uma ação só (sem divisão leitura/escrita como `graph:*`/`ingredient:*`), o que tornaria um profile exclusivo para uma única permission um exagero.

**`0012_seed_auth_stats_permission.sql`**
- Permission `auth:stats` ("Read aggregate user statistics").
- Atribuída **só** a `profile-admin`. Não existia nenhuma permission existente que servisse bem semanticamente (`user:read` já está no profile `User` básico, o que a tornaria ampla demais para dados agregados administrativos).

Ambas as migrations precisam ser adicionadas à lista `migrations` do `auth` em `terraform/environments/{env}/terraform.tfvars`.

## Modelo de autorização (resumo)

| Worker | Rota | Antes | Depois |
|---|---|---|---|
| ai | `GET /health`, `GET /`, `GET /v1/models` | público | público (sem mudança) |
| ai | `POST /v1/chat/completions` | público | `ai:chat` (só Admin) |
| auth | `POST /login`, `/signup`, `/verify`, `/refresh` | público | público (sem mudança) |
| auth | `GET /stats` | público | `auth:stats` (só Admin) |

## Casos de erro a cobrir nos testes

- `POST /v1/chat/completions` sem token → 401.
- `POST /v1/chat/completions` com token válido mas sem `ai:chat` (ex: profile `User`) → 403.
- `POST /v1/chat/completions` com `ai:chat` (Admin) → segue o fluxo normal (200/201, comportamento já existente do `chatCompletion`).
- `GET /v1/models` sem token nenhum → continua 200 (não regressão).
- `GET /stats` sem token → 401.
- `GET /stats` com token válido mas sem `auth:stats` → 403.
- `GET /stats` com `auth:stats` (Admin) → 200 com os dados agregados.
- `POST /login`/`/signup`/`/verify`/`/refresh` sem qualquer header `Authorization` → continuam funcionando normalmente (não regressão).
- Ambos os workers, sem `JWT_SECRET` configurado, em qualquer rota agora protegida → 500.

## Gaps conhecidos / próximos passos

- Nenhum usuário real recebe automaticamente as novas permissions além de quem já tem o profile `Admin` via `user_profiles` — usuários `Admin` existentes ganham `ai:chat`/`auth:stats` só depois que a migration rodar (efeito automático da consulta de permissions no login, não precisa de ação manual adicional).
- Este spec não reconsidera se `/v1/models` ou os endpoints públicos de `auth-worker` deveriam ganhar proteção no futuro — ficou fora de escopo deliberadamente.
