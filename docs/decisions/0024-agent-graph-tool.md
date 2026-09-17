# ADR 0024: Tool `find_node` (Grafo) para Agents

Adiciona `find_node` ao catálogo de tools de agents no `ai-worker` — busca exata de um node no grafo de conhecimento (`graph-worker`), primeira tool a consumir dados fora do RAG desde a [ADR 0023](0023-agent-tool-calling.md).

## Contexto

A [ADR 0023](0023-agent-tool-calling.md) introduziu tool calling para agents com uma única tool, `query_knowledge_base` (via `rag-worker`), que não tem problema de multi-tenancy (índice Vectorize único). `graph-worker.findNodeByLabel(graphId, actorSub, type, label)` (RPC já existente, `terraform/workers/graph/src/index.mjs`) é diferente: grafos são isolados por `graph_id`, com ACL própria (`graph_access`, [ADR 0012](0012-graph-worker-knowledge-graph.md)), então virar tool exige decidir **qual grafo** e **de quem é o acesso** checado a cada chamada — isso ficou registrado como gap na ADR 0023 e é resolvido aqui.

A spec completa está em [`docs/specs/agent-graph-tool.md`](../specs/agent-graph-tool.md), que resolve o item "Tool `find_node` / escrita no grafo" de [`docs/specs/agent-tool-calling-out-of-scope.md`](../specs/agent-tool-calling-out-of-scope.md) — só a parte de leitura.

## Decisão

### Escopo: só leitura (`find_node`)

Escrita no grafo (`upsertNode`, `createEdge`, etc.) via tool calling não é resolvida nesta ADR — um modelo decidindo mutar dados do grafo sozinho é um risco de escopo maior, que merece sua própria validação de segurança depois que o mecanismo de "qual grafo/actorSub" (resolvido aqui) estiver rodando em produção.

### `graph_id` fixo no agent, sem validação no cadastro

Novo campo `graph_id` (opcional, string) no agent — o dono escolhe, ao cadastrar/editar, a qual grafo a tool `find_node` desse agent se conecta. Não é um parâmetro que o modelo escolhe a cada chamada: um agent só consulta um grafo fixo, snapshotado na sessão como os demais campos.

`POST`/`PATCH /v1/agents` aceita qualquer string não-vazia em `graph_id` (`validateOptionalGraphId()`, `agent-db.mjs`), sem checar se o grafo existe ou se quem está criando/editando o agent tem acesso a ele. A validação real acontece em runtime — porque o agent pode ser compartilhado (`agent_access`, ADR 0022) e usado por pessoas diferentes de quem o cadastrou; validar no cadastro só garantiria acesso de quem criou, não de quem for efetivamente conversar com o agent depois.

### `actorSub` da checagem de acesso: o usuário da sessão

Cada chamada da tool usa `payload.sub` (o usuário autenticado enviando a mensagem na sessão) como `actorSub` para `graph-worker.findNodeByLabel(graphId, actorSub, type, label)` — não um service account fixo. Reflete o acesso real de quem está conversando: um agent nunca dá acesso a um grafo que o usuário não teria diretamente. Consistente com o resto do projeto, onde ACL é sempre avaliada pelo usuário real, nunca por uma identidade compartilhada.

Sem acesso, `findNodeByLabel` (que já chama `requireRole(GRAPH_DB, graphId, actorSub, "viewer")` internamente) lança `AuthError(403)`, que propaga até o `try/catch` já existente em `runToolCallingLoop()` (`index.mjs`) e vira `{ error: message }` na mensagem `role: "tool"` — mesmo padrão de erro-de-tool da ADR 0023, nenhum tratamento especial necessário.

### Parâmetros: `type` + `label`, match exato

`find_node` expõe `findNodeByLabel` como está — lookup exato (case-insensitive só no `label`) por `type`/`label`, sem busca difusa/semântica. Resultado devolvido ao modelo: o node encontrado (mesmo shape de `mapNodeRow`) ou `{ found: false }` quando não há correspondência.

### Contexto extra em `execute()`: `tool.execute(env, args, context)`

`find_node` precisa de `graph_id` (do snapshot da sessão) e `actorSub` (usuário da sessão) — nenhum dos dois vem do modelo. A assinatura de `execute()` em `lib/tools.mjs` passa a ser `execute(env, args, context)`: `context` é montado **uma vez por chamada de `runToolCallingLoop()`** (não por tool call individual), `{ actorSub, graphId }`, a partir da sessão/usuário atuais — nunca dos argumentos do modelo. `query_knowledge_base.execute()` continua ignorando o terceiro parâmetro, sem quebrar.

### Schema: `graph_id` no agent + snapshot na sessão

- `terraform/migrations/0021_add_graph_id_to_agents.sql` (D1 `dev-agents`): `ALTER TABLE agents ADD COLUMN graph_id TEXT` (nullable, sem validação de existência).
- `terraform/migrations/0022_add_agent_graph_id_snapshot_to_chat_sessions.sql` (D1 `dev-chat`): `ALTER TABLE chat_sessions ADD COLUMN agent_graph_id TEXT` (nullable, sem FK — mesmo raciocínio cross-database já usado para as demais colunas `agent_*`, migrations 0018/0020).

`AgentInput`/`AgentUpdateInput` ganham o campo opcional `graph_id`. Faz parte do snapshot copiado em `POST /v1/sessions` junto com os demais campos do agent (ADR 0022/0023): `createSession()` grava `agent_graph_id` a partir de `agentSnapshot.graphId`, e `getSessionAgentConfig()` devolve `graphId` junto com `tools`/`maxToolIterations`.

### Novo Service Binding: `ai-worker` → `graph-worker`

`terraform/environments/dev/terraform.tfvars`: `workers.ai.service_bindings` ganha `{ name = "GRAPH_WORKER", target_worker = "graph" }`, ao lado do `RAG_WORKER` já adicionado pela ADR 0023.

### Habilitação: `find_node` entra no catálogo fixo de tools

`find_node` é adicionado a `TOOL_CATALOG` (`lib/tools.mjs`), igual a `query_knowledge_base`. Um agent habilita via `tools: ["find_node"]` (ou junto com outras), mesmo mecanismo de opt-in já existente — nenhuma mudança no formato do campo `tools`, nenhuma mudança em `isKnownTool()`/`getToolDefinitions()`.

Agent com `find_node` habilitada mas sem `graph_id` configurado: `find_node.execute()` lança `Error("Agent has no graph_id configured")` antes de chamar `GRAPH_WORKER`, tratado como erro-de-tool de sempre — não é validado no cadastro, mesmo raciocínio da "sem validação no cadastro" acima.

## Implementação

- `terraform/migrations/0021_add_graph_id_to_agents.sql`: `ALTER TABLE agents` (D1 `dev-agents`), coluna `graph_id`.
- `terraform/migrations/0022_add_agent_graph_id_snapshot_to_chat_sessions.sql`: `ALTER TABLE chat_sessions` (D1 `dev-chat`), coluna `agent_graph_id`.
- `terraform/environments/dev/terraform.tfvars`: `workers.ai.service_bindings` ganha `{ name = "GRAPH_WORKER", target_worker = "graph" }`.
- `terraform/workers/ai/src/lib/tools.mjs`: nova entrada `find_node` em `TOOL_CATALOG`, chamando `env.GRAPH_WORKER.findNodeByLabel(context.graphId, context.actorSub, type, label)`; `execute()` de todas as entradas do catálogo agora recebe `(env, args, context)`.
- `terraform/workers/ai/src/lib/agent-db.mjs`: `graph_id` em `createAgent()`/`updateAgent()`/`mapAgentRow()`; `validateOptionalGraphId()` (só checa string não-vazia) em `validateAgentFields()`.
- `terraform/workers/ai/src/lib/chat-db.mjs`: `createSession()` grava `agent_graph_id` a partir do `agentSnapshot`; `getSessionAgentConfig()` devolve `graphId`.
- `terraform/workers/ai/src/index.mjs`: `handleSendMessage`/`handleToolCallingSendMessage()` passam `actorSub: payload.sub` e `graphId: agentConfig.graphId` para `runToolCallingLoop()`, que monta `context = { actorSub, graphId }` uma vez por chamada e o repassa a cada `tool.execute(env, args, context)`.
- Testes em `tests/ai-worker.test.mjs`: cobrem validação de `graph_id` no agent, snapshot na criação da sessão, `find_node` com sucesso/node não encontrado/sem acesso (403 do `graph-worker` virando erro de tool)/agent sem `graph_id` configurado.

## Trade-offs

| Abordagem | Vantagens | Desvantagens |
|---|---|---|
| **`graph_id` fixo no agent, escolhido pelo dono, sem validação no cadastro (escolhida)** | Sem tool extra para "listar grafos"; snapshot simples, mesmo padrão dos demais campos do agent | Agent com `graph_id` inválido/inacessível só falha em runtime, não no cadastro |
| Validar `graph_id` (existência + acesso do criador) no `POST`/`PATCH /v1/agents` | Erro mais cedo, na hora de configurar o agent | Não garante nada sobre quem efetivamente usa o agent depois (agents são compartilháveis via `agent_access`) — validação enganosa |
| `actorSub` = usuário real da sessão (escolhida) | ACL do grafo (`graph_access`) respeitada por quem está de fato conversando; consistente com o resto do projeto (nunca identidade compartilhada) | Um mesmo agent pode responder de forma diferente (ou negar acesso) dependendo de quem está na sessão |
| `actorSub` = service account fixo por agent | Comportamento uniforme independente de quem está na sessão | Daria a qualquer usuário com acesso ao agent acesso indireto ao grafo, mesmo sem `graph_access` — vazamento de ACL |
| Match exato (`type` + `label`, reaproveitando `findNodeByLabel` como está) (escolhida) | Zero mudança no `graph-worker`; escopo mínimo para validar o mecanismo de grafo fixo + `actorSub` | Modelo precisa "acertar" `type`/`label` exatos; sem fuzzy matching, resultado mais comum é "não encontrado" quando o modelo não sabe o rótulo preciso |
| Escrita no grafo (`upsertNode`/`createEdge`) incluída já nesta ADR | Cobriria mais casos de uso de agent | Risco de um modelo mutar o grafo sozinho é qualitativamente diferente de leitura — merece spec própria (confirmação do usuário? rate limiting? role mínimo `editor`?) |

**Decisão**: `find_node` no catálogo fixo de tools, `graph_id` snapshotado no agent/sessão sem validação de existência/acesso no cadastro, `actorSub` sempre o usuário real da sessão, match exato via `findNodeByLabel` sem alteração no `graph-worker`, erro de acesso negado reaproveitando o padrão de erro-de-tool da ADR 0023, e novo Service Binding `GRAPH_WORKER` no `ai-worker`.

## Gaps conhecidos

Detalhados em [`docs/specs/agent-graph-tool.md`](../specs/agent-graph-tool.md) ("Fora de escopo"):

- **Escrita no grafo via tool calling**: `upsertNode`, `updateNode`, `deleteNode`, `createEdge` continuam fora do catálogo de tools — exige sua própria validação de segurança (confirmação do usuário, rate limiting, role mínimo do `actorSub`).
- **Busca difusa/semântica de nodes**: `find_node` é só o match exato que `findNodeByLabel` já oferece — sem normalização de texto, fuzzy matching ou busca por similaridade; `graph-worker` não expõe hoje nenhuma RPC de busca difusa por node.
- **Outras RPCs de leitura do grafo (`getNeighbors`, `findPaths`)**: só `findNodeByLabel` vira tool nesta ADR; extensão mecânica quando houver interesse, já que reusariam o mesmo `graph_id`/`context` resolvido aqui.

## Referências

- `docs/specs/agent-graph-tool.md` — spec completa desta feature
- `docs/specs/agent-tool-calling-out-of-scope.md` — gap original ("Tool `find_node`/escrita no grafo") que esta ADR resolve
- [ADR 0012: Graph Worker — grafo de conhecimento](0012-graph-worker-knowledge-graph.md)
- [ADR 0015: Service Bindings + RPC (WorkerEntrypoint)](0015-service-bindings-rpc-worker-communication.md)
- [ADR 0016: Grafos por domínio, service accounts e enriquecimento fire-and-forget](0016-domain-graph-service-accounts-and-fire-and-forget-enrichment.md)
- [ADR 0022: Cadastro de Agents no `ai-worker`](0022-agent-registration.md)
- [ADR 0023: Tool Calling para Agents no `ai-worker`](0023-agent-tool-calling.md)
