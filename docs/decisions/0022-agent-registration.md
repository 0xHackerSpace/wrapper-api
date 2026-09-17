# ADR 0022: Cadastro de Agents no `ai-worker`

Adiciona **agents** ao `ai-worker`: uma configuração de IA nomeada e reutilizável (system prompt + parâmetros de geração) que um usuário cadastra uma vez e pode referenciar ao criar sessões de chat, em vez de repetir `model`/system prompt a cada chamada.

## Contexto

O `ai-worker` expõe chat completions OpenAI-compatíveis ([ADR 0008](0008-openai-compatible-ai-api.md)) e sessões de chat persistentes com compartilhamento e paginação ([ADR 0019](0019-ai-worker-chat-sessions.md), [ADR 0020](0020-chat-session-sharing-and-pagination.md)). Não existia nenhum conceito de configuração de IA reutilizável: cada chamada a `/v1/chat/completions` ou `/v1/sessions/:id/messages` usava o `model`/mensagens passados naquele momento, sem persistir uma "persona" que pudesse ser reaproveitada entre sessões.

A spec completa está em [`docs/specs/agent-registration.md`](../specs/agent-registration.md), com os gaps deliberadamente adiados documentados em [`docs/specs/agent-registration-out-of-scope.md`](../specs/agent-registration-out-of-scope.md).

## Decisão

### Onde vive: dentro do `ai-worker`, D1 dedicado (`dev-agents`)

Mesmo padrão de domínio isolado já usado para `dev-chat` ([ADR 0019](0019-ai-worker-chat-sessions.md), [ADR 0004](0004-d1-multiple-databases.md)): novo D1 `dev-agents` (binding `AGENTS_DB`), endpoints `/v1/agents*` ao lado de `/v1/sessions*` no mesmo worker. Não justifica um worker dedicado — agents são metadados consumidos diretamente pelo `ai-worker` ao criar sessões, sem necessidade de exposição a outros Workers.

**Trade-off aceito**: como `dev-agents` é um D1 separado de `dev-chat`, não há (nem pode haver) `FOREIGN KEY` entre `chat_sessions.agent_id` e `agents.id` — D1/SQLite não suporta FK cross-database. A integridade referencial nesse ponto é responsabilidade da aplicação, não do banco. Isso importa menos do que pareceria porque a config é **congelada por snapshot**: uma vez copiada para a sessão, ela não depende mais do agent continuar existindo.

### Schema: `agents` + `agent_access`, mesmo modelo de ACL já usado no projeto

`agents` (`id`, `name`, `system_prompt`, `model`, `temperature`/`max_tokens`/`top_p` nullable, timestamps) guarda a configuração. `agent_access` espelha `chat_access`/`graph_access`: `id`, `agent_id` FK `ON DELETE CASCADE`, `user_id`, `role` `CHECK (role IN ('owner', 'editor', 'viewer'))`, `UNIQUE(agent_id, user_id)`, índice em `user_id`. Reaproveitar esse modelo pela terceira vez (grafo → chat → agents) evita reinventar o raciocínio de papéis, upsert, auto-remoção e invariante de owner para um terceiro domínio — mesma decisão já tomada na [ADR 0020](0020-chat-session-sharing-and-pagination.md).

Papéis: `owner` (lê, edita, gerencia colaboradores, apaga), `editor` (lê, edita campos, não gerencia colaboradores nem apaga), `viewer` (só lê — e pode referenciar o agent ao criar uma sessão, por ser uma leitura/snapshot, não uma escrita no agent). Invariante idêntica às demais ACLs do projeto: todo agent sempre tem ≥1 `owner` (`409` ao tentar remover o último).

### Rotas novas, paginação keyset idêntica à de `/v1/sessions`

```
POST   /v1/agents                       Criar agent (criador vira owner automaticamente)
GET    /v1/agents                       Listar agents com acesso, paginado (limit default 20, máx 100, cursor opaco base64)
GET    /v1/agents/:id                   Detalhe (qualquer papel; 404 se sem acesso)
PATCH  /v1/agents/:id                   Editar campos (owner ou editor; 403 para viewer)
DELETE /v1/agents/:id                   Apagar (owner; 403 para editor/viewer)
PUT    /v1/agents/:id/access/:userId    Conceder/atualizar papel (owner)
DELETE /v1/agents/:id/access/:userId    Revogar acesso, ou auto-remoção (owner sobre qualquer um; qualquer papel sobre si mesmo)
GET    /v1/agents/:id/access            Listar colaboradores (qualquer papel)
```

Paginação keyset ordenada por `updated_at DESC, id DESC`, cursor opaco em base64 (`"<updated_at>|<id>"`) — mesma implementação de `listSessionsForUser()`, reaproveitada em `listAgentsForUser()` (`terraform/workers/ai/src/lib/agent-db.mjs`).

### Permission RBAC dedicada: `ai:agents`, separada de `ai:chat`

`ai:agents` (migration `0017_seed_agent_permissions.sql`, seed inicial só para `profile-admin` — mesmo rollout inicial de `ai:chat`, migration `0011_seed_ai_permissions.sql`) é exigida em todas as rotas `/v1/agents*`, checada antes de qualquer consulta ao D1 (`requirePermission(request, env, "ai:agents")`, igual ao padrão de `ai:chat`). Separada de `ai:chat` porque gerenciar agents é uma capacidade administrativa/de configuração distinta de simplesmente conversar — mesmo raciocínio de "feature × recurso" já usado para justificar (ou descartar) permissions dedicadas nas ADRs 0019/0020. Paridade inicial (mesmo profile recebe as duas), mas são permissions independentes a partir daqui e podem divergir por role no futuro.

### Vínculo com sessão: opcional, snapshot congelado na criação

`chat_sessions` (D1 `dev-chat`, migration `0018_add_agent_snapshot_to_chat_sessions.sql`) ganha seis colunas nullable sem FK: `agent_id`, `agent_system_prompt`, `agent_model`, `agent_temperature`, `agent_max_tokens`, `agent_top_p`.

Em `POST /v1/sessions` com `agent_id` no corpo (`handleCreateSession`, `terraform/workers/ai/src/index.mjs`):

1. Verifica `viewer`+ em `agent_access` (D1 `dev-agents`) para aquele `agent_id` via `requireRole` de `agent-db.mjs`. Sem `AGENTS_DB` configurado: `500`. Sem acesso ou agent inexistente: `404` em ambos os casos — mesma semântica de não vazar existência já usada em `chat_access`/`agent_access`.
2. Copia `system_prompt`/`model`/`temperature`/`max_tokens`/`top_p` do agent para as colunas snapshot da sessão (`createSession()` de `chat-db.mjs`, parâmetro `agentSnapshot`).
3. Sessão criada sem `agent_id`: colunas snapshot ficam `null`, comportamento anterior do `ai-worker` continua sem mudança.

`POST /v1/sessions/:id/messages` (`handleSendMessage`) nunca volta a consultar `dev-agents`: lê o snapshot da própria sessão via `getSessionAgentConfig()`, concatena `agent_system_prompt` como mensagem `system` (normalização da [ADR 0009](0009-system-message-normalization-in-cloudflare-workers-ai.md)) e monta as opções da chamada à Workers AI via `buildAiOptions()` — um `model` explícito no corpo da request sempre vence o snapshot; `temperature`/`max_tokens`/`top_p` só vêm do snapshot, sem equivalente por request hoje.

**Editar ou apagar o agent depois não afeta sessões já criadas** — elas já têm sua cópia. Só sessões novas que referenciem o mesmo `agent_id` (se ele ainda existir) veem a config atualizada.

### `ConflictError` movido para `auth.mjs`, compartilhado entre domínios

`ConflictError` (mapeado para `409`, usado pela invariante de "sempre ≥1 owner") deixou de ser declarado localmente em `chat-db.mjs` e passou a viver em `auth.mjs`, reexportado tanto por `chat-db.mjs` quanto por `agent-db.mjs` — mesmo padrão que `ValidationError` já seguia (declarada em `ai.mjs`, reexportada por todo módulo de domínio). Isso mantém o único `catch` de `index.mjs` (`error instanceof ConflictError`) funcionando não importa qual módulo de domínio lançou o erro.

## Implementação

- `terraform/migrations/0016_create_agents.sql`: cria `agents` e `agent_access` (D1 `dev-agents`, novo).
- `terraform/migrations/0017_seed_agent_permissions.sql`: adiciona `ai:agents` a `permissions`, seed só para `profile-admin` (D1 `dev-auth`).
- `terraform/migrations/0018_add_agent_snapshot_to_chat_sessions.sql`: `ALTER TABLE` em `chat_sessions` (D1 `dev-chat`), seis colunas nullable, sem FK cross-database.
- `terraform/environments/dev/terraform.tfvars`: novo bloco `d1_databases.agents` (`dev-agents`), binding `AGENTS_DB` (tipo `d1`, `resource_key = "agents"`) adicionado ao `ai-worker`.
- `terraform/workers/ai/src/lib/agent-db.mjs` (novo): CRUD de `agents`, `ROLE_RANK`/`requireRole`/`listAgentAccess`/`upsertAgentAccess`/`deleteAgentAccess` (ACL, mesmo shape de `chat-db.mjs`), `listAgentsForUser` (paginação keyset), `encodeCursor`/`decodeCursor` próprios (mesmo formato de `chat-db.mjs`, sem módulo compartilhado entre os dois).
- `terraform/workers/ai/src/lib/chat-db.mjs`: `createSession()` ganha o parâmetro opcional `agentSnapshot`, gravado nas novas colunas; `getSessionAgentConfig()` (novo) lê o snapshot de uma sessão, usado só por `handleSendMessage`. `ConflictError` deixou de ser declarado aqui, passa a ser importado/reexportado de `auth.mjs`.
- `terraform/workers/ai/src/lib/auth.mjs`: `ConflictError` declarado aqui (movido de `chat-db.mjs`), para ser compartilhado por `chat-db.mjs` e `agent-db.mjs`.
- `terraform/workers/ai/src/index.mjs`: rotas `POST/GET /v1/agents`, `GET/PATCH/DELETE /v1/agents/:id`, `PUT/DELETE/GET /v1/agents/:id/access[/:userId]` (handlers `handleCreateAgent`/`handleListAgents`/`handleGetAgent`/`handlePatchAgent`/`handleDeleteAgent`/`handleGrantAgentAccess`/`handleRevokeAgentAccess`/`handleListAgentAccess`). `handleCreateSession` resolve e autoriza um `agent_id` opcional no corpo antes de chamar `createSession()`. `handleSendMessage` lê o snapshot via `getSessionAgentConfig()` e monta as opções via `buildAiOptions()` (nova função, merge model explícito + snapshot).
- Testes em `tests/ai-worker.test.mjs`: cobrem CRUD de agents, ACL/invariante de owner, permission `ai:agents`, criação de sessão com/sem `agent_id` (incluindo 404 para agent inexistente/sem acesso) e envio de mensagem usando os campos snapshot.

## Trade-offs

| Abordagem | Vantagens | Desvantagens |
|---|---|---|
| **D1 dedicado (`dev-agents`) + snapshot congelado na sessão (escolhida)** | Reaproveita o padrão já validado de domínio isolado (ADR 0004) e de ACL (owner/editor/viewer); conversa nunca muda de comportamento no meio por causa de uma edição externa do agent | Sem FK cross-database entre `chat_sessions.agent_id` e `agents.id`; integridade referencial fica só na aplicação |
| Guardar agents como linhas em `dev-chat` (mesmo D1 das sessões) | FK real entre `chat_sessions.agent_id` e `agents.id` | Misturaria dois domínios conceitualmente distintos (config reutilizável vs. histórico de conversa) no mesmo D1, na contramão da ADR 0004 |
| Re-consultar `dev-agents` a cada mensagem em vez de snapshot | Sessão sempre usa a config mais recente do agent | Reintroduziria acoplamento entre os dois D1 em tempo de request; conversa poderia mudar de comportamento no meio sem o usuário pedir — trade-off que a spec rejeita explicitamente |
| Permission única `ai:chat` cobrindo também agents | Menos permissions para gerenciar | Mistura "conversar" com "administrar configuração reutilizável", capacidades de natureza diferente; não permite as duas divergirem por role no futuro |
| Worker dedicado para agents | Isolamento total de deploy | Agents são metadados triviais consumidos só pelo `ai-worker` hoje — worker novo seria overhead sem um consumidor externo real |

**Decisão**: D1 dedicado `dev-agents`, ACL `agent_access` reaproveitando o modelo owner/editor/viewer já validado, permission `ai:agents` separada de `ai:chat`, e vínculo opcional agent→sessão resolvido e congelado em snapshot no momento da criação da sessão.

## Gaps conhecidos

Detalhados em [`docs/specs/agent-registration-out-of-scope.md`](../specs/agent-registration-out-of-scope.md):

- **Tool calling / function calling**: agent é só `system_prompt` + parâmetros de geração, sem declarar acesso a ferramentas/RPCs de outros workers. Sem suporte maduro confirmado a function calling nos modelos da Workers AI hoje.
- **Versionamento/histórico de edições do agent**: `PATCH` sobrescreve direto, sem guardar versões anteriores — a única cópia congelada é o snapshot dentro de cada sessão.
- **Re-snapshot de sessão existente**: sem endpoint para atualizar os campos snapshot de uma sessão já criada para a config atual do agent; quem quiser a versão nova cria uma sessão nova.
- **Agents públicos / templates compartilhados**: sem conceito de agent visível para todos os usuários por padrão — acesso sempre via `agent_access` explícita, um usuário de cada vez.
- **Exposição via RPC (Service Binding)**: nenhum outro worker pode criar, ler ou usar agents via RPC — exclusivo do caminho HTTP do `ai-worker`, mesma decisão já tomada para sessões de chat.

## Referências

- `docs/specs/agent-registration.md` — spec completa desta feature
- `docs/specs/agent-registration-out-of-scope.md` — gaps deliberadamente adiados
- [[0004-d1-multiple-databases|ADR 0004: Múltiplos D1s por domínio]]
- [[0008-openai-compatible-ai-api|ADR 0008: AI Worker com OpenAI compatibility]]
- [[0009-system-message-normalization-in-cloudflare-workers-ai|ADR 0009: System message normalization (Cloudflare Workers AI)]]
- [[0015-service-bindings-rpc-worker-communication|ADR 0015: Service Bindings + RPC (WorkerEntrypoint)]]
- [[0019-ai-worker-chat-sessions|ADR 0019: Sessões de Chat no `ai-worker`]]
- [[0020-chat-session-sharing-and-pagination|ADR 0020: Compartilhamento, paginação e renomear de sessões de chat]]
