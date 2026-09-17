# ADR 0023: Tool Calling para Agents no `ai-worker`

Adiciona a capacidade de um agent invocar uma **tool** (RPC de outro worker) durante o processamento de `POST /v1/sessions/:id/messages`, usando function calling nativo da Cloudflare Workers AI.

## Contexto

Agents ([ADR 0022](0022-agent-registration.md)) hoje são só `system_prompt` + parâmetros de geração — não podem consultar nada durante a conversa além do que está no snapshot da sessão. Esta ADR resolve o item "Tool calling / function calling" deixado como gap conhecido naquela ADR, seguindo o modelo de function calling estilo OpenAI já usado como referência em todo o `ai-worker` ([ADR 0008](0008-openai-compatible-ai-api.md)).

A spec completa está em [`docs/specs/agent-tool-calling.md`](../specs/agent-tool-calling.md), com os gaps deliberadamente adiados documentados em [`docs/specs/agent-tool-calling-out-of-scope.md`](../specs/agent-tool-calling-out-of-scope.md).

## Decisão

### Function calling nativo da Workers AI, novo modelo no catálogo

`ai.run(model, { tools: [...] })` é usado diretamente — a resposta do modelo já vem estruturada (`tool_calls`), sem depender de parsing manual de um JSON dentro do texto. Nenhum modelo do catálogo anterior (`@cf/meta/llama-2-7b-chat-int8`, `@cf/mistral/mistral-7b-instruct-v0.1`) tem suporte confirmado a `tools`. `@cf/meta/llama-3.1-8b-instruct` foi adicionado a `getAvailableModels()` (`terraform/workers/ai/src/lib/ai.mjs`) como o modelo com esse suporte; agents que queiram declarar `tools` precisam usar esse `model` (ou outro que venha a ser adicionado com o mesmo suporte).

Um caminho novo, `chatCompletionWithTools()` (`ai.mjs`), foi criado para isso em vez de reusar `chatCompletion()`: `normalizeMessages()` concatena a mensagem `system` na primeira mensagem `user` ([ADR 0009](0009-system-message-normalization-in-cloudflare-workers-ai.md)), necessário para os modelos antigos sem suporte a `tools`, mas incompatível com o formato de mensagens `role: "system"`/`role: "tool"` nativo que o function calling exige. `chatCompletionWithTools()` passa as mensagens verbatim e é sempre não-streaming (ver seção de streaming abaixo).

### Tool única inicial: `query_knowledge_base` (RAG)

Catálogo fixo de tools em `terraform/workers/ai/src/lib/tools.mjs` (`TOOL_CATALOG`), hoje com uma única entrada: `query_knowledge_base`, que executa `env.RAG_WORKER.query(question, {})` (RPC já existente no `rag-worker`, sem ACL por usuário/grafo — um índice Vectorize único). O resultado devolvido ao modelo como mensagem `role: "tool"` é `JSON.stringify({ answer, sources })`.

`find_node`/qualquer método do `graph-worker` fica de fora desta ADR — exigiria decidir um modelo de "qual grafo pertence a qual agent" e "de quem é o `actorSub`" usado na checagem de ACL do grafo, decisão de design própria (ver gaps conhecidos).

### Novo Service Binding: `ai-worker` → `rag-worker`

`terraform/environments/dev/terraform.tfvars`: `workers.ai.service_bindings` ganha `{ name = "RAG_WORKER", target_rag = "rag" }` — primeiro Service Binding do `ai-worker` (mesmo padrão já usado por `graphrag-worker`, ver [ADR 0015](0015-service-bindings-rpc-worker-communication.md)/[ADR 0017](0017-graphrag-worker-hybrid-qa-orchestrator.md)).

### Schema: `tools` e `max_tool_iterations` no agent, validados contra catálogo fixo em código

Migration `0019_add_tools_to_agents.sql` (D1 `dev-agents`), `ALTER TABLE agents`:
- `tools TEXT` — nullable, JSON serializado de um array de nomes de tools habilitadas (ex. `["query_knowledge_base"]`).
- `max_tool_iterations INTEGER NOT NULL DEFAULT 5` — teto de ciclos modelo→tool→modelo antes de forçar uma resposta final.

Cada nome em `tools` é validado contra `isKnownTool()` (`lib/tools.mjs`) em `validateAgentFields()` (`agent-db.mjs`) — nome desconhecido é rejeitado com `400` na criação/edição do agent, mesmo padrão de validação já usado para os demais campos. O catálogo vive no código do `ai-worker`, não em D1: o conjunto de tools é pequeno e parte do próprio deploy do worker, não dado gerenciado pelo usuário — mesmo raciocínio da ADR 0022 para não versionar/tabelar `agent_access` além do necessário.

`AgentInput`/`AgentUpdateInput` ganham os dois campos opcionais. Ambos fazem parte do snapshot copiado para a sessão em `POST /v1/sessions`: migration `0020_add_agent_tools_snapshot_to_chat_sessions.sql` (D1 `dev-chat`) adiciona `agent_tools TEXT` e `agent_max_tool_iterations INTEGER` (nullable, sem `DEFAULT` — `NULL` significa "sessão sem agent, ou agent sem tools"; o default 5 só existe do lado do agent). `createSession()`/`getSessionAgentConfig()` (`chat-db.mjs`) leem/gravam essas colunas do mesmo jeito que os demais campos do snapshot da ADR 0022.

### Onde roda: só `POST /v1/sessions/:id/messages`

`/v1/chat/completions` não muda — permanece stateless, sem conceito de agent ([ADR 0008](0008-openai-compatible-ai-api.md)). Uma sessão sem `agent_id`, ou com um agent sem `tools` (ou `tools: []`), processa a mensagem exatamente como antes desta ADR — `tools` nem é passado para `ai.run()`. Sem nova permission RBAC: o loop roda dentro do fluxo já gated por `ai:chat` + papel `editor`+ na sessão.

### Loop de tool calling e teto de iterações

`runToolCallingLoop()` (`index.mjs`), acionado por `handleSendMessage` quando `agentConfig.tools` não é vazio:

1. Chama `chatCompletionWithTools()` (não-streaming) com `tools` sempre que `cycle < maxIterations`.
2. Resposta com `tool_calls`: para cada chamada, resolve o nome contra `TOOL_CATALOG`, executa `tool.execute(env, args)`, adiciona uma mensagem `role: "tool"` com o resultado. Repete o ciclo.
3. Resposta sem `tool_calls` (texto final): sai do loop, essa é a resposta final.
4. Ao atingir `maxIterations` ciclos: a última chamada ao modelo é feita **sem** `tools`, forçando uma resposta em texto — tratada como final incondicionalmente, mesmo que o modelo ainda tente chamar uma tool (comportamento da Workers AI nesse caso não é conhecido, ver spec).

### Erro de tool: vira resultado de erro, loop continua

Falha ao executar uma tool (RPC lança exceção, `RAG_WORKER` ausente, timeout) é capturada dentro do loop e devolvida ao modelo como `JSON.stringify({ error: error.message })` na mensagem `role: "tool"` — não aborta a request. O modelo decide como reagir dentro do orçamento de iterações restante.

### Persistência: histórico completo de tool calls

Cada ciclo persiste via `addMessage()` (`chat-db.mjs`), sem migration de schema em `chat_messages` (coluna `role` é texto livre, sem `CHECK`):
- `role: "assistant"` com o pedido de tool call (`content: JSON.stringify({ tool_calls: [...] })`).
- `role: "tool"` com o resultado (ou erro) de cada tool executada.
- Ao final, `role: "assistant"` com o texto de resposta final, como já acontecia antes desta ADR.

Essas mensagens extras contam para a janela de contexto de 20 mensagens ([ADR 0019](0019-ai-worker-chat-sessions.md)) como qualquer outra.

### Streaming: só a resposta final é re-executada com `stream: true`

O loop inteiro roda de forma não-streaming (precisa inspecionar `tool_calls` estruturado a cada rodada). Quando o loop termina e o client pediu `stream: true`, `handleToolCallingSendMessage()` refaz a **última** chamada ao modelo com `stream: true` (sem `tools`, já que é resposta final), reaproveitando `streamSendMessageResponse()`/`createChatCompletionChunkStream()` existentes (ADR 0021). Sem `stream: true`, a resposta final do loop é devolvida como JSON, sem chamada extra.

**Trade-off aceito**: com tools habilitadas e `stream: true`, isso custa uma chamada a mais ao modelo (a rodada final roda uma vez sem stream para decidir se é resposta final, e de novo com stream para produzir o texto ao client). Sem tools, o caminho de streaming existente não muda em nada.

## Implementação

- `terraform/migrations/0019_add_tools_to_agents.sql`: `ALTER TABLE agents` (D1 `dev-agents`), colunas `tools`/`max_tool_iterations`.
- `terraform/migrations/0020_add_agent_tools_snapshot_to_chat_sessions.sql`: `ALTER TABLE chat_sessions` (D1 `dev-chat`), colunas `agent_tools`/`agent_max_tool_iterations`.
- `terraform/environments/dev/terraform.tfvars`: `d1_databases.chat.migrations`/`d1_databases.agents.migrations` ganham as novas migrations; `workers.ai.service_bindings` ganha `{ name = "RAG_WORKER", target_rag = "rag" }`.
- `terraform/workers/ai/src/lib/tools.mjs` (novo): `TOOL_CATALOG` (hoje só `query_knowledge_base`), `isKnownTool()`, `getToolDefinitions()`.
- `terraform/workers/ai/src/lib/ai.mjs`: novo `chatCompletionWithTools()` (não-streaming, preserva roles `system`/`tool` nativos); `@cf/meta/llama-3.1-8b-instruct` adicionado a `getAvailableModels()`.
- `terraform/workers/ai/src/lib/agent-db.mjs`: `tools`/`max_tool_iterations` em `createAgent()`/`updateAgent()`/`mapAgentRow()`; `validateOptionalTools()` (rejeita nomes fora de `isKnownTool()`) e `validateOptionalMaxToolIterations()` em `validateAgentFields()`.
- `terraform/workers/ai/src/lib/chat-db.mjs`: `createSession()` grava `agent_tools`/`agent_max_tool_iterations` a partir do `agentSnapshot`; `getSessionAgentConfig()` devolve `tools`/`maxToolIterations`.
- `terraform/workers/ai/src/index.mjs`: `handleSendMessage` desvia para `handleToolCallingSendMessage()` quando o snapshot da sessão tem `tools` não-vazio; `runToolCallingLoop()` implementa o ciclo modelo→tool→modelo e a persistência das mensagens intermediárias.
- Testes em `tests/ai-worker.test.mjs`: cobrem validação de `tools`/`max_tool_iterations` no agent, snapshot na criação da sessão, o loop de tool calling (sucesso, erro de tool, teto de iterações) e o caminho de streaming da resposta final.

## Trade-offs

| Abordagem | Vantagens | Desvantagens |
|---|---|---|
| **Function calling nativo da Workers AI + catálogo fixo em código (escolhida)** | `tool_calls` estruturado, sem parsing manual de texto; catálogo pequeno não justifica uma tabela D1; loop simples de implementar e testar | Restrito a modelos com suporte confirmado a `tools` (hoje só `@cf/meta/llama-3.1-8b-instruct`); tools limitadas ao que o `ai-worker` já sabe executar |
| Parsing manual de um formato de function-call no texto do modelo | Funcionaria com qualquer modelo do catálogo, sem exigir suporte nativo | Frágil (depende do modelo formatar corretamente um JSON dentro do texto), maior superfície de bugs, não é o que a spec quis evitar |
| Loop sempre não-streaming, resposta final re-executada com `stream: true` (escolhida) | Streaming existente (ADR 0021) reaproveitado sem modificação; código do loop não precisa lidar com tokens parciais | Uma chamada extra ao modelo quando há tools + `stream: true` |
| Vocabulário de evento SSE novo para os ciclos intermediários de tool calling | Cliente veria progresso ("consultando a base de conhecimento...") durante o loop | Formato de evento novo fora do padrão `chat.completion.chunk` já usado; nenhum client hoje consumiria isso — adiado (ver gaps) |
| Tool `find_node`/grafo incluída já nesta ADR | Cobriria mais casos de uso de agent | Exige resolver vínculo agent↔grafo e modelo de `actorSub` para ACL — decisão de design própria, não extensão mecânica do mecanismo de tools |

**Decisão**: function calling nativo via novo modelo `@cf/meta/llama-3.1-8b-instruct`, tool única `query_knowledge_base` via novo Service Binding `RAG_WORKER`, catálogo fixo em código validado na criação/edição do agent, loop sempre não-streaming com replay da resposta final quando `stream: true` é pedido, e erro de tool tratado como resultado (não aborta).

## Gaps conhecidos

Detalhados em [`docs/specs/agent-tool-calling-out-of-scope.md`](../specs/agent-tool-calling-out-of-scope.md):

- **Tool `find_node`/escrita no grafo (`graph-worker`)**: nenhum método RPC do `graph-worker` vira tool nesta ADR — grafos são multi-tenant com ACL por grafo, e não existe hoje um modelo de "qual grafo pertence a qual agent" nem de "de quem é o `actorSub`" usado numa tool call.
- **Streaming dos ciclos intermediários de tool calling**: só a resposta final é streamada; pedido de tool, execução e resultado ficam invisíveis ao client durante o loop.
- **Tools customizadas/definidas pelo usuário**: só tools pré-cadastradas no código do `ai-worker` podem ser habilitadas — sem suporte a tools apontando para webhooks externos ou definidas por um usuário.
- **Tool calling em `/v1/chat/completions`**: o endpoint stateless não ganha suporte a `tools`/`agent_id` — tools vivem no agent, e só sessões referenciam agents.
- **Limite de iterações compartilhado/global**: `max_tool_iterations` é só por agent, sem um teto rígido global independente que sobreponha o valor configurado.

## Referências

- `docs/specs/agent-tool-calling.md` — spec completa desta feature
- `docs/specs/agent-tool-calling-out-of-scope.md` — gaps deliberadamente adiados
- [ADR 0008: AI Worker com OpenAI compatibility](0008-openai-compatible-ai-api.md)
- [ADR 0009: System message normalization (Cloudflare Workers AI)](0009-system-message-normalization-in-cloudflare-workers-ai.md)
- [ADR 0015: Service Bindings + RPC (WorkerEntrypoint)](0015-service-bindings-rpc-worker-communication.md)
- [ADR 0017: GraphRAG Worker — orquestrador dedicado para Q&A híbrido](0017-graphrag-worker-hybrid-qa-orchestrator.md)
- [ADR 0019: Sessões de Chat no `ai-worker`](0019-ai-worker-chat-sessions.md)
- [ADR 0021: Streaming (SSE) para chat completions e sessões de chat](0021-chat-streaming.md)
- [ADR 0022: Cadastro de Agents no `ai-worker`](0022-agent-registration.md)
