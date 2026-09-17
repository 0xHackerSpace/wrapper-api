# Spec: Tool Calling para Agents

Gerado via interview (`/grilling`). Complementa [agent-registration.md](agent-registration.md); resolve o item "Tool calling / function calling" de [agent-registration-out-of-scope.md](agent-registration-out-of-scope.md).

## Contexto

Agents (ADR 0022) hoje são só `system_prompt` + parâmetros de geração — não podem consultar nada durante a conversa além do que está no snapshot da sessão. Esta spec adiciona a capacidade de um agent invocar uma **tool** (uma RPC de outro worker) durante o processamento de `POST /v1/sessions/:id/messages`, seguindo o modelo de function calling estilo OpenAI já usado como referência em todo o `ai-worker` (ADR 0008).

## Decisão

### Function calling nativo da Workers AI, não parsing manual

`ai.run(model, { tools: [...] })` — a resposta do modelo já vem estruturada (`tool_calls`), sem depender de o modelo formatar corretamente um JSON dentro do texto. Isso exige um modelo com suporte confirmado ao parâmetro `tools`, o que nenhum modelo do catálogo atual (`@cf/meta/llama-2-7b-chat-int8`, `@cf/mistral/mistral-7b-instruct-v0.1`) tem.

**Novo modelo no catálogo**: `@cf/meta/llama-3.1-8b-instruct` adicionado a `getAvailableModels()` (`terraform/workers/ai/src/lib/ai.mjs`) como o modelo com suporte a tools. Agents que queiram usar `tools` precisam usar esse `model` (ou outro que venha a ser adicionado com o mesmo suporte); agents com modelo sem suporte a tools simplesmente não conseguem declarar `tools` (validado na criação/edição do agent, ver Casos a verificar).

**Importante para a implementação**: `chatCompletion()`/`normalizeMessages()` hoje concatenam a mensagem `system` dentro da primeira mensagem `user` (ADR 0009, necessário para os modelos antigos do catálogo). O caminho de tool calling **não deve** reusar essa normalização — precisa preservar o `role: "system"` nativo e o formato de mensagens `tool` que o function calling exige. Implementação usa um caminho novo (`chatCompletionWithTools()` ou equivalente em `ai.mjs`), não `chatCompletion()`.

### Tool inicial: só `query_knowledge_base` (RAG)

Único candidato viável sem trabalho de design adicional: `rag-worker.query(question, { topK, filter })` (RPC já existe, `terraform/workers/rag/index.mjs:425`) não tem ACL por usuário/grafo — um índice Vectorize único, sem multi-tenancy. Retorna `{ question, answer, sources }` (o `answer` já é gerado pelo próprio `rag-worker` via seu `GENERATION_MODEL`; `sources` é a lista de trechos usados).

Definição da tool (formato OpenAI):
```json
{
  "type": "function",
  "function": {
    "name": "query_knowledge_base",
    "description": "Busca informação relevante na base de conhecimento (RAG) para responder a uma pergunta.",
    "parameters": {
      "type": "object",
      "properties": {
        "question": { "type": "string", "description": "A pergunta a ser respondida usando a base de conhecimento." }
      },
      "required": ["question"]
    }
  }
}
```

Resultado devolvido ao modelo (mensagem `role: "tool"`): `JSON.stringify({ answer, sources })` (o `question` é omitido do resultado, já que o modelo o forneceu).

**`find_node` (grafo) fica de fora** desta spec: `graph-worker.findNodeByLabel(graphId, actorSub, type, label)` exige um `graphId` específico e ACL por grafo (`graph_access`) — não há hoje um modelo de "qual grafo pertence a qual agent" nem de "de quem é o `actorSub` usado na checagem". Fica registrado em [agent-tool-calling-out-of-scope.md](agent-tool-calling-out-of-scope.md).

### Schema: `tools` e `max_tool_iterations` no agent

Migration `0019_add_tools_to_agents.sql` (D1 `dev-agents`), `ALTER TABLE agents`:
- `tools TEXT` — nullable, JSON serializado de um array de nomes de tools habilitadas (ex.: `["query_knowledge_base"]`). Nomes validados contra um catálogo fixo de tools conhecidas no código (não uma tabela — a lista de tools existentes é pequena e faz parte do deploy do `ai-worker`, não um dado de usuário).
- `max_tool_iterations INTEGER NOT NULL DEFAULT 5` — teto de ciclos modelo→tool→modelo antes de forçar uma resposta final.

`AgentInput`/`AgentUpdateInput` (código, não มenos o schema OpenAI) ganham os campos opcionais `tools` (array de strings) e `max_tool_iterations` (integer). Ambos fazem parte do snapshot copiado para a sessão em `POST /v1/sessions` (mais duas colunas em `chat_sessions`: `agent_tools`, `agent_max_tool_iterations` — mesma migration `0019` ou uma companion `0020`, a decidir na implementação conforme o D1 alvo de cada `ALTER`).

### Novo Service Binding: `ai-worker` → `rag-worker`

`terraform/environments/dev/terraform.tfvars`: `workers.ai.service_bindings` ganha `{ name = "RAG_WORKER", target_rag = "rag" }` (mesmo padrão já usado por `graphrag-worker`, ver ADR 0015/0017). Hoje o `ai-worker` não tem nenhum service binding — este é o primeiro.

### Onde roda: só `POST /v1/sessions/:id/messages`, sessão com agent + `tools`

`/v1/chat/completions` não muda (stateless, sem agent, ADR 0008). Uma sessão sem `agent_id`, ou com um agent sem `tools` (ou `tools: []`), processa a mensagem exatamente como hoje — o parâmetro `tools` nem é passado para `ai.run()`.

### Loop de tool calling

Quando a sessão tem `agent_tools` não-vazio no snapshot:

1. Chama `ai.run(model, { messages, tools })` (não-streaming, mesmo com `stream: true` na request — ver seção de streaming abaixo).
2. Se a resposta tem `tool_calls`: para cada chamada, resolve o nome da tool contra o catálogo fixo do código, executa a RPC correspondente (`env.RAG_WORKER.query(...)` para `query_knowledge_base`), e adiciona ao array de mensagens uma entrada `role: "tool"` com o resultado (ou erro, ver abaixo). Volta ao passo 1.
3. Se a resposta não tem `tool_calls` (conteúdo final de texto): sai do loop, essa é a resposta a ser persistida/devolvida.
4. Ao atingir `agent_max_tool_iterations` ciclos sem resposta final: última chamada ao modelo é feita **sem** o parâmetro `tools` (força o modelo a responder em texto com o que já tem).

### Streaming: só a resposta final

Todo o loop acima roda de forma não-streaming internamente (precisa inspecionar `tool_calls` estruturado a cada rodada, incompatível com consumir a resposta como stream de tokens). Quando o loop termina (passo 3 ou 4) e o client pediu `stream: true`, a **última** chamada ao modelo é refeita com `stream: true` (sem `tools`, já que nesse ponto é resposta final) e streamada como hoje (`createChatCompletionChunkStream`). Sem `stream: true`, a resposta final do loop é devolvida como JSON, sem chamada extra.

**Trade-off aceito**: isso custa uma chamada a mais ao modelo (a última rodada roda uma vez sem stream para decidir se é resposta final, e de novo com stream para produzir o texto ao client) só quando há tools habilitadas e `stream: true`. Sem tools, o caminho de streaming existente (ADR 0021) não muda em nada.

### Erro de tool: vira resultado de erro, loop continua

Falha ao executar uma tool (RPC lança exceção, binding ausente, timeout) não aborta a resposta — é capturada e o resultado devolvido ao modelo é `JSON.stringify({ error: "<mensagem>" })` como conteúdo da mensagem `role: "tool"`. O modelo decide como reagir (tentar de novo dentro do limite de iterações, avisar o usuário, seguir sem esse dado).

### Persistência: histórico completo de tool calls

Cada ciclo do loop persiste (via `addMessage`, `chat-db.mjs`) mensagens adicionais em `chat_messages`, sem migration de schema (coluna `role` já é texto livre, sem `CHECK`):
- `role: "assistant"` com o pedido de tool call (conteúdo: `JSON.stringify({ tool_calls: [...] })`, já que o schema atual de `chat_messages` só tem `content` texto, sem coluna estruturada para tool calls).
- `role: "tool"` com o resultado (ou erro) de cada tool executada.
- Ao final, a mensagem `role: "assistant"` com o texto de resposta final, exatamente como hoje.

Essas mensagens extras contam para a janela de contexto de 20 mensagens (ADR 0019) como qualquer outra — uma conversa com muitos ciclos de tool consome a janela mais rápido, comportamento aceito sem tratamento especial.

## Decisões de baixo nível (sem necessidade de validação)

- Catálogo fixo de tools conhecidas vive no código do `ai-worker` (ex.: um objeto `{ query_knowledge_base: { definition, execute } }` em um novo `lib/tools.mjs`), não em D1 — evita uma tabela para um conjunto de poucas tools controladas pelo deploy.
- Nome de tool inválido em `agent.tools` (não existe no catálogo fixo) é rejeitado na validação de `POST`/`PATCH /v1/agents` com `400`, mesmo padrão de validação já usado para os demais campos do agent.
- Numeração de migration: `0019_add_tools_to_agents.sql` (dev-agents) e, se necessário separar por D1 conforme decidido na implementação, `0020_add_agent_tools_snapshot_to_chat_sessions.sql` (dev-chat).
- Sem nova permission RBAC — tool calling roda dentro do fluxo já gated por `ai:chat` + papel `editor`+ na sessão (`POST /v1/sessions/:id/messages`); não é uma capacidade gerenciada via `ai:agents` porque não altera nada no agent em si, só como a mensagem é processada.

## Casos a verificar

- Confirmar contra a documentação/comportamento real da Workers AI que `@cf/meta/llama-3.1-8b-instruct` aceita `tools` no formato assumido acima (nome exato do parâmetro, forma de `tool_calls` na resposta, forma esperada de mensagem `role: "tool"` de volta) — não verificado com uma chamada real antes de escrever esta spec.
- `POST`/`PATCH /v1/agents` com `tools` não-vazio e um `model` sem suporte a tools: decidir se isso é rejeitado na validação (recomendado) ou aceito silenciosamente e ignorado em runtime.
- Loop atinge `max_tool_iterations` e a chamada final "sem tools" ainda assim tenta chamar uma tool (o modelo ignora a ausência do parâmetro) — comportamento da Workers AI nesse caso não é conhecido, tratar como resposta final de qualquer forma.
- `RAG_WORKER` binding ausente (ambiente sem o binding configurado): tool falha como qualquer outro erro de tool (mensagem de erro pro modelo), não crasha a request.
- Mensagens `role: "tool"`/pedido de tool call persistidas corretamente contam para a janela de 20 mensagens e não quebram `listRecentMessages`/`listMessagesPage` (que hoje só esperam `user`/`assistant`).
- Streaming com tools: a resposta final streamada é idêntica (mesmo conteúdo) à que seria devolvida como JSON não-streaming, só a forma de entrega muda.

## Fora de escopo

Ver [agent-tool-calling-out-of-scope.md](agent-tool-calling-out-of-scope.md).
