# ADR 0021: Streaming (SSE) para Chat Completions e Sessões

Adiciona suporte a `stream: true` em `POST /v1/chat/completions` e `POST /v1/sessions/:id/messages` no `ai-worker`, retornando a resposta como Server-Sent Events (`chat.completion.chunk`, formato OpenAI) em vez de um JSON único.

## Contexto

Ambos os endpoints sempre aguardavam a resposta completa da Workers AI antes de responder (`chatCompletion()`, `terraform/workers/ai/src/lib/ai.mjs`, chamava `ai.run(model, {...})` sem `stream`, serializado de uma vez via `json()` em `lib/response.mjs`). Streaming era um "próximo passo" desde a [ADR 0008](0008-openai-compatible-ai-api.md) e reafirmado como gap conhecido nas ADRs 0019/0020 (ver [`docs/specs/chat-sessions-out-of-scope.md`](../specs/chat-sessions-out-of-scope.md)).

A spec completa está em [`docs/specs/chat-streaming.md`](../specs/chat-streaming.md).

## Decisão

### Gatilho: `stream: true` no corpo, mesmo endpoint

Ambos os endpoints passam a aceitar um campo opcional `stream` no corpo. Ausente ou `false` mantém o comportamento atual (JSON completo, sem quebra de contrato). `stream: true` retorna `Content-Type: text/event-stream`.

### Protocolo: SSE estilo OpenAI (`chat.completion.chunk`)

Escolhido por compatibilidade direta com o formato já adotado na [ADR 0008](0008-openai-compatible-ai-api.md) para o restante da API (clients OpenAI-compatíveis já sabem consumir esse formato de chunk). Cada chunk de conteúdo carrega `delta.content`; o penúltimo chunk carrega `delta: {}` com `finish_reason: "stop"`; o último chunk carrega `usage` (sempre incluído, sem opção de desativar — Workers AI só expõe uso de tokens depois que o stream termina); a mensagem final é `data: [DONE]`.

### RPC `chat()` fica fora de escopo

O método RPC `chat()` (`WorkerEntrypoint`, consumido via Service Binding conforme [ADR 0015](0015-service-bindings-rpc-worker-communication.md)) não ganha suporte a streaming. Motivos: (1) a própria ADR 0015 já registra incerteza sobre limites de serialização desse canal, sem suporte documentado a `ReadableStream` entre Workers via RPC; (2) nenhum worker consumidor (`graph-worker`, `rag-worker`, `graphrag-worker`) pede isso hoje — adicionar seria especulativo (YAGNI). `chat()` continua retornando o objeto completo, sem mudança.

### `POST /v1/sessions/:id/messages`: buffer + forward, persiste só após sucesso

A mensagem do assistente só é persistida (`addMessage` + `touchSession`, via callback `onComplete` passado a `createChatCompletionChunkStream`) depois que todos os eventos de conteúdo do stream terminam com sucesso — antes dos chunks finais (`finish_reason`/`usage`/`[DONE]`) serem emitidos ao client. Se o stream falhar no meio, `onComplete` nunca roda: nada do assistente é persistido (a mensagem do usuário, já persistida antes de chamar a Workers AI, permanece). Isso preserva a mesma garantia do caminho não-streaming: o histórico em `chat_messages` nunca contém uma resposta parcial/truncada do assistente.

A checagem `requireRole` (editor+) roda antes do corpo ser lido e antes de `stream` ser avaliado, então um `viewer` recebe `403` sem que qualquer stream chegue a iniciar — igual ao caminho não-streaming.

### `POST /v1/chat/completions`: apenas tradução de formato

Sem sessão envolvida e nada para persistir, o worker só traduz cada evento SSE bruto da Workers AI (`data: {"response": "token"}`) para o formato `chat.completion.chunk`, sem buffer server-side.

### Erro no meio do stream: chunk de erro, status HTTP permanece 200

Se a geração falhar depois que os headers (`200`, `text/event-stream`) já foram enviados, o status não pode mais mudar — o worker emite um chunk de erro (`{"error": {"message": "...", "type": "internal_error"}}`, mesmo formato usado nas respostas de erro não-streaming) seguido de `data: [DONE]`, e fecha a conexão. O client precisa inspecionar o conteúdo dos chunks, não o status HTTP, para detectar falha parcial.

## Implementação

- `terraform/workers/ai/src/lib/ai.mjs`: `chatCompletionStream(ai, messages, options)` chama `ai.run(model, { ..., stream: true })` e retorna `{ id, created, model, events }`, onde `events` é um async generator (`streamChatEvents`, sobre `parseRawAiStream`) que traduz o SSE bruto da Workers AI para um vocabulário interno `{ type: "content" | "usage", ... }`. `createChatCompletionChunkStream(events, meta, { onComplete })` constrói o `ReadableStream` de `chat.completion.chunk` SSE devolvido ao client, roda `onComplete(content, usage)` (se fornecido) depois que o conteúdo termina e antes dos chunks finais, e emite um chunk de erro (mantendo status 200) se o stream falhar no meio.
- `terraform/workers/ai/src/index.mjs`: `POST /v1/chat/completions` aceita `stream: true` no corpo → `streamChatCompletionResponse()` (só tradução de formato). `POST /v1/sessions/:id/messages` aceita `stream: true` → `streamSendMessageResponse()`, que usa `onComplete` para persistir a mensagem do assistente só depois que o stream termina com sucesso. RPC `chat()` não muda.
- Testes em `tests/ai-worker.test.mjs`: mock de `AI.run()` com `stream: true` retornando um `ReadableStream` simulado, e parser de SSE para os testes consumirem os chunks emitidos.

## Trade-offs

| Abordagem | Vantagens | Desvantagens |
|---|---|---|
| **SSE `chat.completion.chunk`, gatilho `stream: true` no mesmo endpoint (escolhida)** | Compatível com clients OpenAI existentes; sem endpoint novo; sem quebra do caminho não-streaming | Client precisa inspecionar conteúdo dos chunks para detectar erro parcial (status HTTP fica 200) |
| Endpoint separado para streaming (ex.: `/v1/chat/completions/stream`) | Contrato explícito por URL | Duplicaria validação/roteamento; diverge do padrão OpenAI, que usa o mesmo endpoint com `stream: true` |
| Streaming também no RPC `chat()` | Simetria entre caminho HTTP e RPC | Sem suporte documentado a `ReadableStream` em Service Bindings (ADR 0015); nenhum consumidor real hoje (YAGNI) |
| Persistir resposta parcial em caso de falha mid-stream | Não perde o que já foi gerado | Introduziria mensagens truncadas/inconsistentes no histórico; complexidade extra sem requisito real |

**Decisão**: SSE estilo OpenAI acionado por `stream: true` no corpo dos dois endpoints existentes, buffer+forward com persistência condicionada ao sucesso do stream em `/v1/sessions/:id/messages`, chunk de erro com status HTTP inalterado (200), e RPC `chat()` fora de escopo.

## Gaps conhecidos / Próximos passos

- Sem streaming no caminho RPC (`chat()`) — ver seção acima.
- Sem controle client-side sobre incluir/excluir `usage` no stream (sempre incluído).
- CPU time do Workers pode cortar streams muito longos antes do fim — risco conhecido da plataforma, sem mitigação implementada.
- Sem cancelamento explícito client-side propagado ao `ai.run()` — se o client fechar a conexão, não foi investigado como o worker/runtime reage a um `ReadableStream` sem leitor.

## Referências

- `docs/specs/chat-streaming.md` — spec completa desta feature
- `docs/specs/chat-sessions-out-of-scope.md` — gap original de streaming, atualizado por esta ADR
- [[0008-openai-compatible-ai-api|ADR 0008: AI Worker com OpenAI compatibility]]
- [[0015-service-bindings-rpc-worker-communication|ADR 0015: Service Bindings + RPC (WorkerEntrypoint)]]
- [[0019-ai-worker-chat-sessions|ADR 0019: Sessões de Chat no ai-worker]]
- [[0020-chat-session-sharing-and-pagination|ADR 0020: Compartilhamento, paginação e renomear de sessões de chat]]
