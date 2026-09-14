# Spec: Streaming para Chat Completions e Sessões

## Contexto

Hoje `POST /v1/chat/completions` e `POST /v1/sessions/:id/messages` sempre aguardam a resposta completa da Workers AI antes de retornar (`chatCompletion()`, `terraform/workers/ai/src/lib/ai.mjs`, chama `ai.run(model, {...})` sem `stream`, e o resultado é serializado de uma vez via `json()` em `lib/response.mjs`). Streaming já era um item listado como "próximo passo" desde a ADR 0008 (AI Worker OpenAI compatibility) e reafirmado como gap conhecido nas ADRs 0019/0020.

`json()` (`response.mjs`) constrói a `Response` com `JSON.stringify` completo — não há caminho hoje para retornar um corpo `ReadableStream`. O RPC `chat()` (`WorkerEntrypoint`, usado via Service Binding por outros workers, ver ADR 0015) retorna o mesmo objeto plano de `chatCompletion()`; a própria ADR 0015 já registra incerteza sobre limites de serialização desse canal.

## Fora de escopo

- **Streaming via RPC/Service Binding** (`chat()` entrypoint) — sem suporte documentado a `ReadableStream` nesse canal (ADR 0015), e nenhum worker consumidor pede isso hoje. Continua retornando o objeto completo de uma vez, como já funciona.
- **`stream_options.include_usage` configurável pelo client** — diferente da API OpenAI real, aqui o chunk de `usage` final é sempre incluído quando `stream: true`, sem opção de desativar.
- **Persistir resposta parcial** em `POST /v1/sessions/:id/messages` quando o stream é interrompido no meio — a mensagem do assistente só é persistida se o stream terminar com sucesso.

## Decisão

### Gatilho: `stream: true` no corpo, mesmo endpoint

Ambos os endpoints (`POST /v1/chat/completions`, `POST /v1/sessions/:id/messages`) passam a aceitar um campo opcional `stream` no corpo. `stream` ausente ou `false` mantém o comportamento atual (JSON completo, sem mudança de contrato). `stream: true` retorna `Content-Type: text/event-stream` com o corpo em SSE.

### Protocolo: SSE estilo OpenAI

Cada chunk segue o formato `chat.completion.chunk` da API OpenAI:

```
data: {"id":"...","object":"chat.completion.chunk","created":...,"model":"...","choices":[{"index":0,"delta":{"content":"token..."},"finish_reason":null}]}

data: {"id":"...","object":"chat.completion.chunk","created":...,"model":"...","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: {"id":"...","object":"chat.completion.chunk","created":...,"model":"...","usage":{"prompt_tokens":N,"completion_tokens":M,"total_tokens":N+M}}

data: [DONE]

```

- Primeiro(s) chunk(s): `delta.content` com o texto incremental gerado.
- Chunk penúltimo: `delta: {}`, `finish_reason: "stop"` (sinaliza fim da geração de conteúdo).
- Chunk de `usage`: enviado sempre, logo após o `finish_reason: "stop"` — só é possível calcular depois que o stream termina (Workers AI não expõe uso parcial de tokens).
- Última linha: `data: [DONE]`, mesmo marcador de fim usado pela API OpenAI.

Reaproveita o binding `env.AI` com `stream: true` — a Workers AI retorna um `ReadableStream` de eventos SSE (`data: {"response": "token..."}`) que o worker re-emite já no formato `chat.completion.chunk` acima (tradução de formato, não repasse bruto).

### Erro no meio do stream

Se a geração falhar depois que os headers (`200`, `text/event-stream`) já foram enviados, o worker emite um chunk final:

```
data: {"error":{"message":"...","type":"internal_error"}}

data: [DONE]

```

e fecha a conexão. O status HTTP permanece `200` (já foi enviado antes do erro ocorrer) — o client precisa inspecionar o conteúdo dos chunks, não o status, para detectar falha parcial.

### `POST /v1/sessions/:id/messages`: buffer + forward via `TransformStream`

Fluxo com `stream: true`:

1. Persiste a mensagem do usuário (igual ao caminho não-streaming hoje).
2. Monta o contexto (últimas 20 mensagens, igual hoje).
3. Chama `ai.run(model, { messages, stream: true })`.
4. Um `TransformStream` traduz cada evento SSE bruto da Workers AI em um chunk `chat.completion.chunk`, repassando ao client **e simultaneamente acumulando** o texto completo (`delta.content` concatenado) numa variável no worker.
5. Quando o stream da Workers AI termina: se terminou com sucesso, persiste a mensagem completa do assistente acumulada (`addMessage`) e atualiza `updated_at`/`title` (`touchSession`) — igual ao caminho não-streaming, só que depois do fim do stream em vez de antes de responder. Se terminou com erro, **não persiste nada do assistente** (mensagem do usuário already persisted permanece; ver Fora de escopo).
6. Emite os chunks finais (`finish_reason: "stop"` + `usage` + `[DONE]`) só depois que a persistência (passo 5) já rodou — client só vê `[DONE]` depois que a mensagem já está gravada, então uma leitura subsequente via `GET /v1/sessions/:id/messages` já reflete o histórico atualizado.

### `POST /v1/chat/completions`: apenas tradução de formato

Sem sessão envolvida, o caminho é mais simples: chama `ai.run(model, { messages, stream: true })`, traduz cada evento SSE em `chat.completion.chunk` e repassa direto ao client, sem buffer server-side (nada precisa ser persistido).

## Decisões de baixo nível (sem necessidade de validação)

- **RPC `chat()` inalterado**: continua sem `stream`, retornando o objeto completo — nenhuma mudança nesse método.
- **Modelo de erro parcial**: o chunk de erro usa o mesmo formato `{ error: { message, type } }` já usado nas respostas de erro não-streaming (`lib/response.mjs`), por consistência.
- **CPU time do Workers**: streams muito longos podem ser cortados pelo limite de CPU time da plataforma Cloudflare Workers antes de terminar — risco conhecido da plataforma, não mitigado por este spec (documentado como gap).
- **Testes**: o harness de teste atual mocka `env.AI.run()` de forma síncrona (retorna um objeto, não um stream); o worker precisa de um segundo modo de mock (`AI.run` retornando um `ReadableStream`/async iterator) para cobrir os testes de streaming — detalhe de implementação do `worker-dev`, não requer nova decisão do usuário.

## Casos a verificar

- `POST /v1/chat/completions` com `stream: true` → `Content-Type: text/event-stream`, chunks de `delta.content` seguidos por `finish_reason: "stop"`, `usage`, `[DONE]`.
- `POST /v1/chat/completions` sem `stream` (ou `stream: false`) → comportamento idêntico ao atual (JSON completo), sem regressão.
- `POST /v1/sessions/:id/messages` com `stream: true` → mensagem do assistente aparece completa em `GET /v1/sessions/:id/messages` **depois** que o client recebe `[DONE]`.
- Falha simulada da Workers AI no meio do stream (em `/v1/chat/completions`) → chunk de erro + `[DONE]`, conexão fecha, status HTTP continua `200`.
- Falha simulada no meio do stream em `/v1/sessions/:id/messages` → mensagem do assistente **não** aparece em `chat_messages`; a mensagem do usuário (persistida antes) continua lá.
- `stream: true` numa sessão onde o chamador só tem papel `viewer` → 403, igual ao caminho não-streaming (checagem de `requireRole` roda antes de iniciar o stream).

## Gaps conhecidos / próximos passos

- Sem streaming no caminho RPC (`chat()`) — ver Fora de escopo.
- Sem controle client-side sobre incluir/excluir `usage` no stream (sempre incluído).
- CPU time do Workers pode cortar streams muito longos antes do fim — sem mitigação (retry, chunking adicional) implementada por este spec.
- Sem cancelamento explícito client-side propagado ao `ai.run()` — se o client fechar a conexão, o worker pode continuar consumindo o stream da Workers AI até o fim antes de perceber que ninguém está mais lendo (depende de como o runtime trata um `ReadableStream` sem leitor — não investigado neste spec).
