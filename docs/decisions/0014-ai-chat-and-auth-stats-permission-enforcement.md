# ADR 0014: Enforcement de Permissões no AI Worker e no `/stats` do Auth Worker

O Worker `ai` passa a exigir a permission `ai:chat` do JWT em `POST /v1/chat/completions`, e o Worker `auth` passa a exigir `auth:stats` em `GET /stats`. Ambos fecham a lacuna deixada intencionalmente aberta pelo [ADR 0013](0013-jwt-permission-enforcement.md), que tratou "adicionar auth a uma rota antes pública" como uma decisão de acesso distinta de "aplicar permissions que já existiam" e por isso não cobriu esses dois casos.

## Motivação

- `ai-worker` era inteiramente público, incluindo `chat completions`, que consome inferência de Workers AI sem controle de acesso algum.
- `GET /stats` do `auth-worker` também era público, expondo dados agregados de usuários sem checagem nenhuma.
- O ADR 0013 aplicou `requirePermission` em `api`/`graph`/`rag`, mas registrou explicitamente esses dois pontos em "Próximos Passos" como decisões de acesso pendentes — ver [spec](../specs/ai-chat-and-auth-stats-permissions.md).

## Implementação

- `ai-worker` ganha `lib/jwt.mjs` + `lib/auth.mjs` (não tinha nenhum dos dois), replicando o mesmo padrão por worker já usado em `api-worker`/`graph-worker` desde o ADR 0013 (cópia própria, dado o bundling isolado do esbuild). `requirePermission(request, env, "ai:chat")` é a primeira linha do handler de `POST /v1/chat/completions`, antes do check de `env.AI`. `GET /health`, `GET /`, `GET /v1/models` continuam públicos.
- `auth-worker` ganha `lib/auth.mjs` novo, reaproveitando o `verifyToken` já existente em `lib/jwt.mjs` (usado antes só por `/verify` e `/refresh`). `requirePermission(request, env, "auth:stats")` é a primeira linha do handler de `GET /stats`. `POST /login`, `/signup`, `/verify`, `/refresh`, `GET /health`, `GET /` continuam sem mudança — `/verify` e `/refresh` validam um token recebido no corpo da requisição, não no header `Authorization`, então não fazem sentido como rota "protegida" no mesmo sentido das outras.
- Ambos falham fechado (`500`, `"JWT_SECRET not configured"`) quando a env var não está setada, igual `api-worker`/`graph-worker` — não seguem o skip-when-missing legado do `rag-worker`, já que nenhum dos dois tinha checagem nenhuma antes (sem legado a preservar).

## Novas permissions e profiles

Duas migrations novas (não aplicadas ainda em nenhum D1 remoto — aplicação continua manual e gated):

- **`0011_seed_ai_permissions.sql`**: permission `ai:chat` ("Use AI chat completions"), atribuída só a `profile-admin`.
- **`0012_seed_auth_stats_permission.sql`**: permission `auth:stats` ("Read aggregate user statistics"), atribuída só a `profile-admin`.

## Mapeamento de rotas → permission

| Worker | Rota | Antes | Depois |
|---|---|---|---|
| ai | `GET /health`, `GET /`, `GET /v1/models` | público | público (sem mudança) |
| ai | `POST /v1/chat/completions` | público | `ai:chat` (só Admin) |
| auth | `POST /login`, `/signup`, `/verify`, `/refresh` | público | público (sem mudança) |
| auth | `GET /stats` | público | `auth:stats` (só Admin) |

## Por que nenhum profile dedicado

Decisão deliberada contra criar um profile tipo "AI User": `ai:chat` é uma ação única, sem divisão leitura/escrita como `graph:*`/`ingredient:*`, o que tornaria um profile exclusivo para uma única permission um exagero. Da mesma forma, nenhuma permission existente (ex: `user:read`, já no profile `User` básico) era semanticamente adequada para dados agregados administrativos de `auth:stats` — ficaria ampla demais.

## Trade-offs

| Abordagem | Vantagens | Desvantagens |
|---|---|---|
| **Restringir a Admin via permission dedicada (escolhida)** | Consistente com o padrão `requirePermission`/`AuthError` já estabelecido no ADR 0013; nenhuma infraestrutura nova; erro `403` explícito | Qualquer usuário não-Admin que precise de chat/stats exige promoção manual a Admin — sem meio-termo hoje |
| Criar profile "AI User" dedicado | Não obriga promover usuário a Admin só para liberar o chat | Profile inteiro para uma única permission é overhead desproporcional ao ganho |
| Deixar público (não fazer nada) | Zero esforço | Mantém a lacuna já identificada pelo ADR 0013; inferência e dados agregados sem controle nenhum |

**Decisão**: seguir o padrão de `requirePermission` por rota já estabelecido no ADR 0013, atribuindo as novas permissions só a `profile-admin` por ora — mesma filosofia de fail-closed por padrão, abrindo depois se necessário.

## Testes

`tests/ai-worker.test.mjs` e `tests/auth-worker.test.mjs` cobrem: `401` sem token, `403` com token válido mas sem a permission (ex: profile `User`), `200` com Admin, e não regressão nas rotas que continuam públicas. Suite completa: 84 testes.

## Próximos Passos

- [ ] Rodar `terraform apply` para aplicar as migrations 0011 e 0012 em `dev-auth` (pendente de confirmação explícita)
- [ ] Reconsiderar se `/v1/models` ou os endpoints públicos do `auth-worker` devem ganhar proteção no futuro (fora de escopo aqui, já registrado no spec)

## Referências

- [[0013-jwt-permission-enforcement|ADR 0013: Enforcement de Permissões do JWT nos Workers]]
- [[0007-rbac-jwt-permissions|ADR 0007: RBAC + JWT authentication]]
- [[0008-openai-compatible-ai-api|ADR 0008: AI Worker com OpenAI Compatibility]]
- `docs/specs/ai-chat-and-auth-stats-permissions.md` — spec completo desta mudança
