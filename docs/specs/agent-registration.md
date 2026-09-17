# Spec: Cadastro de Agents

## Contexto

O `ai-worker` hoje expõe chat completions OpenAI-compatíveis ([ADR 0008](../decisions/0008-openai-compatible-ai-api.md)) e sessões de chat persistentes com compartilhamento e paginação ([ADR 0019](../decisions/0019-ai-worker-chat-sessions.md), [ADR 0020](../decisions/0020-chat-session-sharing-and-pagination.md)). Não existe hoje nenhum conceito de configuração de IA reutilizável: cada chamada a `/v1/chat/completions` ou `/v1/sessions/:id/messages` usa o `model`/mensagens passados naquele momento, sem persistir uma "persona" (system prompt + parâmetros de geração) que possa ser reaproveitada entre sessões.

Esta spec introduz **agents**: uma configuração nomeada e reutilizável (system prompt, modelo, parâmetros de geração) que um usuário cadastra uma vez e pode referenciar ao criar sessões de chat.

## Decisão

### Onde vive: dentro do `ai-worker`, D1 dedicado (`dev-agents`)

Mesmo padrão de domínio isolado já usado para `dev-chat` (ADR 0019): novo D1 `dev-agents`, endpoints `/v1/agents*` ao lado de `/v1/sessions*` no mesmo worker. Não justifica um worker dedicado — agents são metadados consumidos diretamente pelo `ai-worker` ao criar sessões.

**Trade-off aceito**: como `dev-agents` é um D1 separado de `dev-chat`, não há (nem pode haver) FK entre `chat_sessions.agent_id` e `agents.id` — D1/SQLite não suporta FK cross-database. A integridade referencial nesse ponto é responsabilidade da aplicação, não do banco. Isso importa menos do que pareceria porque a config é **congelada por snapshot** (ver abaixo): uma vez copiada para a sessão, ela não depende mais do agent continuar existindo.

### Schema

**`agents`** (D1 `dev-agents`, migration `0016_create_agents.sql`):

| Campo | Tipo | Notas |
|---|---|---|
| `id` | TEXT (PK) | UUID |
| `name` | TEXT NOT NULL | |
| `system_prompt` | TEXT NOT NULL | |
| `model` | TEXT NOT NULL | Mesmo catálogo de `/v1/models` |
| `temperature` | REAL | Nullable — ausente usa default da Workers AI |
| `max_tokens` | INTEGER | Nullable |
| `top_p` | REAL | Nullable |
| `created_at` | DATETIME | Default `CURRENT_TIMESTAMP` |
| `updated_at` | DATETIME | Default `CURRENT_TIMESTAMP`, atualizado em todo `PATCH` |

**`agent_access`** (mesmo D1, mesma migration) — mesmo modelo de `chat_access`/`graph_access`:

| Campo | Tipo | Notas |
|---|---|---|
| `id` | TEXT (PK) | UUID |
| `agent_id` | TEXT | FK `agents(id)` `ON DELETE CASCADE` |
| `user_id` | TEXT | Quem tem acesso |
| `role` | TEXT | `CHECK (role IN ('owner', 'editor', 'viewer'))` |
| `created_at` | DATETIME | Default `CURRENT_TIMESTAMP` |

`UNIQUE(agent_id, user_id)`, índice `idx_agent_access_user_id` em `user_id` (listar "meus agents" via join).

### Semântica dos papéis

- **`owner`**: lê, edita campos, gerencia colaboradores (`PUT`/`DELETE .../access/:userId`), apaga o agent.
- **`editor`**: lê, edita campos (`name`, `system_prompt`, `model`, `temperature`, `max_tokens`, `top_p`). Não gerencia colaboradores nem apaga.
- **`viewer`**: só lê — e pode **referenciar** o agent ao criar uma sessão (é uma leitura/snapshot, não uma escrita no agent).

Invariante idêntica a `chat_access`/`graph_access`: toda linha em `agents` sempre tem ≥1 `owner` — `PUT`/`DELETE` que deixaria 0 owners retorna `409`.

### Rotas novas

```
POST   /v1/agents                       Criar agent (criador vira owner automaticamente)
GET    /v1/agents                       Listar agents com acesso, paginado (mesmo padrão de /v1/sessions)
GET    /v1/agents/:id                   Detalhe (qualquer papel; 404 se sem acesso)
PATCH  /v1/agents/:id                   Editar campos (owner ou editor; 403 para viewer)
DELETE /v1/agents/:id                   Apagar (owner; 403 para editor/viewer)
PUT    /v1/agents/:id/access/:userId    Conceder/atualizar papel (owner)
DELETE /v1/agents/:id/access/:userId    Revogar acesso, ou auto-remoção (owner sobre qualquer um; qualquer papel sobre si mesmo)
GET    /v1/agents/:id/access            Listar colaboradores (qualquer papel)
```

Paginação keyset idêntica à de `/v1/sessions` (ADR 0020): `limit` (default 20, máx 100) + `cursor` opaco (base64 de `"<updated_at>|<id>"`), resposta `{ "object": "list", "data": [...], "next_cursor": "..." | null }`.

### Permission RBAC dedicada: `ai:agents`

Separada de `ai:chat` (decisão explícita: gerenciar agents é uma capacidade administrativa/de configuração distinta de simplesmente conversar). Exigida em todas as rotas `/v1/agents*`, além do papel na `agent_access` correspondente.

Seed inicial (migration `0017_seed_agent_permissions.sql`, dev-auth, mesmo padrão de `0011_seed_ai_permissions.sql`): as roles que hoje têm `ai:chat` também recebem `ai:agents` no seed — paridade inicial, mas são permissions independentes a partir daí (podem divergir por role no futuro).

### Vínculo com sessão: opcional, snapshot na criação

`chat_sessions` (D1 `dev-chat`, migration `0018_add_agent_snapshot_to_chat_sessions.sql`) ganha colunas nullable:

| Campo | Tipo |
|---|---|
| `agent_id` | TEXT (sem FK — cross-database) |
| `agent_system_prompt` | TEXT |
| `agent_model` | TEXT |
| `agent_temperature` | REAL |
| `agent_max_tokens` | INTEGER |
| `agent_top_p` | REAL |

Ao criar uma sessão (`POST /v1/sessions`) com `agent_id` no corpo:

1. `ai-worker` verifica que o usuário tem ao menos `viewer` em `agent_access` para aquele `agent_id` (D1 `dev-agents`) — sem acesso, `404` (mesma semântica de não vazar existência já usada em `chat_access`/`graph_access`).
2. Copia `system_prompt`/`model`/`temperature`/`max_tokens`/`top_p` do agent para as colunas snapshot da sessão.
3. Sessão criada sem `agent_id`: colunas snapshot ficam `null`, comportamento atual do `ai-worker` (sem system prompt fixo, `model` explícito por chamada) continua sem mudança.

`POST /v1/sessions/:id/messages` passa a montar a chamada à Workers AI usando os campos snapshot da própria sessão (nunca consulta `dev-agents` de novo) — concatenando `agent_system_prompt` conforme a normalização da [ADR 0009](../decisions/0009-system-message-normalization-in-cloudflare-workers-ai.md), e aplicando `agent_temperature`/`agent_max_tokens`/`agent_top_p` quando presentes.

**Editar ou apagar o agent depois não afeta sessões já criadas** — elas já têm sua cópia. Só sessões novas (que referenciem o mesmo `agent_id`, se ele ainda existir) veem a config atualizada.

## Decisões de baixo nível (sem necessidade de validação)

- **Hard delete** em `agents` (mesma decisão já tomada para `chat_sessions` na ADR 0019) — sem soft-delete/tombstone.
- **Sem tabela de histórico/versionamento** de edições do agent — a única "versão congelada" que existe é a snapshot dentro de cada sessão; o registro do agent em si não guarda histórico de mudanças.
- **Sem "re-snapshot"**: não há endpoint para atualizar uma sessão existente para a config atual do agent. Quem quiser a versão nova cria uma sessão nova.
- **Sem noção de agent público/template compartilhado entre todos os usuários** — acesso é sempre via `agent_access` explícita, igual a `chat_access`/`graph_access`.
- **Numeração de migrations**: `0016` (dev-agents: `agents` + `agent_access`), `0017` (dev-auth: seed `ai:agents`), `0018` (dev-chat: colunas snapshot em `chat_sessions`).

## Casos a verificar

- Criar sessão com `agent_id` de um agent ao qual o usuário não tem acesso retorna `404` (não `403`) — mesma semântica de não vazar existência.
- Criar sessão com `agent_id` inexistente retorna `404`.
- Editar ou apagar um agent depois de criar uma sessão com ele não muda os campos snapshot da sessão já existente.
- `viewer` em um agent consegue criar uma sessão referenciando-o, mas não consegue `PATCH`/`DELETE` o agent.
- Invariante de ≥1 owner em `agent_access` é respeitada nos mesmos moldes de `chat_access`/`graph_access` (`409` ao tentar remover o último owner).
- Rotas `/v1/agents*` exigem a permission `ai:agents` no JWT, independente do papel em `agent_access` (falta de permission → `403` antes mesmo de consultar o D1).
- `POST /v1/sessions/:id/messages` numa sessão com agent aplica `temperature`/`max_tokens`/`top_p` snapshot corretamente na chamada à Workers AI.

## Fora de escopo

Ver [agent-registration-out-of-scope.md](agent-registration-out-of-scope.md).
