# ADR 0019: Sessões de Chat no `ai-worker`

Adiciona um conceito de sessão de chat persistida (`chat_sessions`/`chat_messages`, D1 dedicado `dev-chat`) ao `ai-worker`, com cinco endpoints novos sob `/v1/sessions`. `POST /v1/chat/completions` permanece stateless e inalterado.

## Contexto

`POST /v1/chat/completions` sempre foi totalmente stateless: o client reenvia o array `messages` inteiro a cada request, sem nenhuma persistência no servidor. Não havia no repositório qualquer noção de "sessão", "conversa" ou "histórico".

`ai-worker` já enforce JWT via `requirePermission(request, env, "ai:chat")` ([ADR 0014](0014-ai-chat-and-auth-stats-permission-enforcement.md)), com o payload trazendo `sub`, `username` e `permissions`. O `graph-worker` já resolve um problema parecido de propriedade de dado por usuário via `graph_access` (owner/editor/viewer, [ADR 0012](0012-graph-worker-knowledge-graph.md)), mas esse nível de compartilhamento não é necessário para sessões de chat — sessão é sempre privada ao dono.

Especificação completa em [`docs/specs/chat-sessions.md`](../specs/chat-sessions.md); itens deliberadamente adiados em [`docs/specs/chat-sessions-out-of-scope.md`](../specs/chat-sessions-out-of-scope.md).

## Decisão

### Dentro do `ai-worker` existente, não um worker novo

Sessão de chat é conceitualmente parte do mesmo domínio de "conversas com IA" que o `ai-worker` já possui. Um worker dedicado (como `graphrag-worker`, [ADR 0017](0017-graphrag-worker-hybrid-qa-orchestrator.md)) só se justifica quando outro worker precisa consumir a feature via RPC — não é o caso aqui: nenhum outro worker cria ou lê sessões (ver Fora de escopo).

### D1 dedicado (`dev-chat`), não reaproveitar `dev-auth`

Segue o padrão de "múltiplos D1 por domínio" já estabelecido ([ADR 0004](0004-d1-multiple-databases.md)): sessões de chat são um domínio próprio e não devem se misturar com identidade/autorização (`dev-auth`). Bindado só no `ai-worker` como `CHAT_DB`, mesmo padrão de `graph-worker`↔`GRAPH_DB`.

### Endpoint dedicado (`/v1/sessions/*`), não estender `/v1/chat/completions`

`/v1/chat/completions` mantém compatibilidade OpenAI e uso stateless — adicionar um modo "com sessão" ali exigiria um campo opcional de correlação (`session_id`) e branches condicionais que quebrariam a simplicidade do contrato OpenAI-compatível ([ADR 0008](0008-openai-compatible-ai-api.md)). Sessões viram um caminho HTTP totalmente separado, sem nenhuma mudança no endpoint existente.

### Dono único, sem ACL compartilhável

Diferente do `graph-worker`, não existe modelo de ACL (`owner`/`editor`/`viewer`) para sessão de chat: toda operação valida `user_id == sub` do JWT da request, e não há nenhum caso de uso de "chat compartilhado" — é um assistente pessoal por usuário. Adicionar ACL agora seria complexidade sem requisito real por trás (ver [chat-sessions-out-of-scope.md](../specs/chat-sessions-out-of-scope.md)).

### Reaproveitar a permission `ai:chat`, nenhuma nova

Todos os 5 endpoints exigem a mesma permission `ai:chat` já usada por `/v1/chat/completions`. Diferente do `graphrag-worker`, que criou `graphrag:query` por ser uma feature de custo/superfície distintos ([ADR 0017](0017-graphrag-worker-hybrid-qa-orchestrator.md)), sessão de chat é sempre operação do próprio dono sobre os próprios dados — não há ação administrativa de terceiro sobre sessão alheia que justifique uma permission mais granular.

### 404 (não 403) para sessão inexistente ou de outro usuário

`getSessionForUser`/`deleteSession` (`terraform/workers/ai/src/lib/chat-db.mjs`) filtram por `id AND user_id` na própria query SQL, nunca checando ownership depois de buscar por `id` sozinho. Isso garante que a resposta seja idêntica (`404`) tanto para uma sessão que não existe quanto para uma sessão de outro usuário, sem vazar a existência de sessões alheias.

### Janela de contexto de 20 mensagens

Histórico completo é sempre persistido no D1 — nada é descartado. Mas `POST /v1/sessions/:id/messages` só envia as últimas 20 mensagens (10 trocas) da sessão para `AI.run()`, evitando estourar o limite de contexto do modelo em sessões longas. `GET /v1/sessions/:id` continua retornando o histórico completo. O número (20) foi escolhido como ponto de partida razoável, sem embasamento em teste de carga — é lógica de query (`listRecentMessages`), não schema, então pode ser ajustado sem migration.

## Implementação

- Migration `terraform/migrations/0014_create_chat_sessions.sql`: tabelas `chat_sessions` (`id`, `user_id`, `title`, `created_at`, `updated_at`) e `chat_messages` (`id`, `session_id` FK `ON DELETE CASCADE`, `role`, `content`, `created_at`), com índices em `chat_sessions.user_id` e `chat_messages.session_id`.
- `terraform/environments/dev/terraform.tfvars`: novo `d1_databases.chat` (`dev-chat`) e binding `CHAT_DB` (`type = "d1"`, `resource_key = "chat"`) só no worker `ai`.
- `terraform/workers/ai/src/lib/chat-db.mjs`: acesso a D1 (`createSession`, `listSessionsForUser`, `getSessionForUser`, `listMessages`, `listRecentMessages`, `addMessage`, `touchSession`, `deleteSession`). Reaproveita `ValidationError` de `lib/ai.mjs` em vez de declarar uma segunda classe de erro.
- `terraform/workers/ai/src/index.mjs`: 5 rotas novas (`POST/GET /v1/sessions`, `GET/DELETE /v1/sessions/:id`, `POST /v1/sessions/:id/messages`), todas atrás de `requirePermission(request, env, "ai:chat")`. `POST /v1/sessions/:id/messages` persiste a mensagem do usuário, monta o contexto (últimas 20 mensagens via `listRecentMessages`), chama `chatCompletion` (mesmo caminho interno de `/v1/chat/completions`), persiste a resposta do assistente e atualiza `updated_at`/`title` via `touchSession` (título auto-gerado por truncamento das primeiras `TITLE_MAX_LENGTH` = 50 caracteres da primeira mensagem, só quando ainda nulo).
- Método RPC `chat()` do `ai-worker` (Service Binding, [ADR 0015](0015-service-bindings-rpc-worker-communication.md)) não foi alterado — sessões são exclusivamente um caminho HTTP.
- Testes novos em `tests/ai-worker.test.mjs`, com D1 mockado em memória, seguindo o padrão de [ADR 0011](0011-unit-testing-strategy-for-workers.md).

## Trade-offs

| Abordagem | Vantagens | Desvantagens |
|---|---|---|
| **Sessões dentro do `ai-worker` (escolhida)** | Reaproveita `chatCompletion`/`requirePermission` já existentes; sem novo worker para operar/monitorar; sem novo Service Binding | `ai-worker` acumula responsabilidade de persistência, além de ser uma capability atômica de chat |
| Worker novo dedicado (`chat-worker`) | Isolamento total de ciclo de deploy | Nenhum consumidor RPC concreto hoje justificaria o overhead operacional de um worker a mais (YAGNI) |
| Estender `/v1/chat/completions` com `session_id` opcional | Um único endpoint para os dois modos | Quebra a simplicidade do contrato OpenAI-compatível; branch condicional bagunça um endpoint que hoje é 100% stateless |
| ACL compartilhável (`graph_access`-like) para sessões | Suportaria caso de uso de "chat compartilhado" futuro | Complexidade sem requisito real hoje; nenhum caso de uso de colaboração em sessão foi levantado |
| Nova permission dedicada (ex.: `chat:sessions`) | Granularidade RBAC mais fina | Sessão é sempre operação do próprio dono — não há ação de terceiro a segregar; `ai:chat` já cobre o caso de uso |

**Decisão**: sessões dentro do `ai-worker`, dono único sem ACL, permission `ai:chat` reaproveitada, 404 uniforme para sessão inexistente/alheia, janela de contexto fixa de 20 mensagens.

## Gaps conhecidos / Próximos passos

- Sem paginação em `GET /v1/sessions` nem no histórico de `GET /v1/sessions/:id` — mesmo gap já aceito em `GET /ingredients`.
- Janela de contexto fixa em 20 mensagens não é configurável por request.
- Sem streaming (SSE/chunked) em `POST /v1/sessions/:id/messages` — herda a mesma limitação já conhecida de `/v1/chat/completions` desde a [ADR 0008](0008-openai-compatible-ai-api.md).
- Sem compartilhamento de sessão entre usuários e sem exposição via RPC/Service Binding para outros workers — ambos deliberadamente fora de escopo, ver [chat-sessions-out-of-scope.md](../specs/chat-sessions-out-of-scope.md).
- Sem endpoint para renomear sessão manualmente (`title` é só auto-gerado).
- Seed do `d1_databases.chat` (migration `0014_create_chat_sessions.sql`) precisa ser rodado manualmente (`wrangler d1 execute dev-chat --remote < ...`), mesmo padrão dos demais D1s do projeto.

## Referências

- `docs/specs/chat-sessions.md` — spec completa desta feature
- `docs/specs/chat-sessions-out-of-scope.md` — itens deliberadamente adiados (streaming, compartilhamento, RPC)
- [[0004-d1-multiple-databases|ADR 0004: Múltiplos D1s por domínio]]
- [[0008-openai-compatible-ai-api|ADR 0008: AI Worker com OpenAI compatibility]]
- [[0011-unit-testing-strategy-for-workers|ADR 0011: Estratégia de testes unitários para workers]]
- [[0012-graph-worker-knowledge-graph|ADR 0012: Graph Worker — grafo de conhecimento]]
- [[0014-ai-chat-and-auth-stats-permission-enforcement|ADR 0014: Enforcement de permissões no AI Worker e no /stats do Auth Worker]]
- [[0015-service-bindings-rpc-worker-communication|ADR 0015: Service Bindings + RPC entre Workers]]
- [[0017-graphrag-worker-hybrid-qa-orchestrator|ADR 0017: GraphRAG Worker — orquestrador dedicado para Q&A híbrido]]
