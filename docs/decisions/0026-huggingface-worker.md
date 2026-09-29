# ADR 0026: Huggingface Worker — Proxy Autenticado para Hugging Face Inference Providers

Adiciona **`huggingface-worker`**, um worker novo e stateless dedicado à API de **Inference Providers** da Hugging Face (https://huggingface.co/docs/inference-providers/tasks/index), cobrindo 19 tasks de ML via 19 rotas explícitas. Totalmente segmentado do `ai-worker` — não o consome, não é consumido por ele.

## Contexto

O projeto já tem `ai-worker` (chat completions via Cloudflare Workers AI, [ADR 0008](0008-openai-compatible-ai-api.md)) e `rag-worker` (embeddings via BGE, também Cloudflare Workers AI). A Hugging Face expõe uma superfície de API bem mais ampla via **Inference Providers**: um proxy unificado da HF que roteia chamadas para dezenas de providers de infraestrutura (Cerebras, Together, Fireworks, Groq, Replicate, fal.ai, a própria HF via `hf-inference`, etc.), cobrindo ~19 tasks de ML diferentes.

A spec completa está em [`docs/specs/huggingface-worker.md`](../specs/huggingface-worker.md) (itens deliberadamente fora de escopo em [`docs/specs/huggingface-worker-out-of-scope.md`](../specs/huggingface-worker-out-of-scope.md)). Ela documenta em detalhe os fatos confirmados via fetch da documentação oficial e via leitura do código-fonte do SDK oficial (`@huggingface/inference`); esta ADR foca nas decisões de arquitetura e no que foi de fato implementado.

## Decisão

### Worker novo, stateless, segmentado do `ai-worker`

`terraform/workers/huggingface/src/index.mjs`, mesma estrutura de todo worker do projeto (`src/index.mjs`, `src/lib/`, `dist/` gerado por esbuild, entrada em `scripts/build-workers.mjs`). **Sem D1 próprio** — nenhuma das 19 tasks tem razão para persistir estado; o worker é essencialmente um proxy autenticado e validado entre o cliente e a HF. Diferente de `ai`/`graph`/`rag` ([ADR 0015](0015-service-bindings-rpc-worker-communication.md)), não é `WorkerEntrypoint` e não expõe nem consome nenhum Service Binding — não é uma tool de agent (ADR 0023), não é uma opção de `model` em `agent-db.mjs`, não aparece no diagrama de RPC entre workers. Decisão explícita da spec (Q1 da entrevista): um worker especializado e separado, não um backend alternativo plugado no que já existe.

### 19 rotas, uma por task, despachadas por três categorias de handler

Todas exigem `model` (JSON ou query string, conforme a categoria) e aceitam `provider` opcional. `terraform/workers/huggingface/src/index.mjs` mantém três tabelas de lookup (`JSON_TASK_ROUTES`, `BINARY_OUTPUT_TASK_ROUTES`, `BINARY_INPUT_TASK_ROUTES`) que despacham cada path para um dos quatro handlers de `lib/hf-client.mjs` (`chatCompletion`, `runJsonTask`, `runBinaryOutputTask`, `runBinaryInputTask`) — mantém o espírito de "uma rota por task" da spec (nenhum dispatcher genérico baseado em path dinâmico) sem duplicar lógica idêntica 10+ vezes.

| Rota | Task | Entrada | Saída |
|---|---|---|---|
| `POST /v1/chat/completions` | chat-completion | JSON `{ model, messages, provider?, stream? }` | JSON, ou SSE se `stream: true` |
| `POST /v1/text-generation` | text-generation | JSON `{ model, inputs, parameters?, provider? }` | JSON |
| `POST /v1/feature-extraction` | feature-extraction | JSON `{ model, inputs, provider? }` | JSON |
| `POST /v1/fill-mask` | fill-mask | JSON `{ model, inputs, provider? }` | JSON |
| `POST /v1/question-answering` | question-answering | JSON `{ model, inputs: { question, context }, provider? }` | JSON |
| `POST /v1/summarization` | summarization | JSON `{ model, inputs, parameters?, provider? }` | JSON |
| `POST /v1/table-question-answering` | table-question-answering | JSON `{ model, inputs: { query, table }, provider? }` | JSON |
| `POST /v1/text-classification` | text-classification | JSON `{ model, inputs, provider? }` | JSON |
| `POST /v1/token-classification` | token-classification | JSON `{ model, inputs, provider? }` | JSON |
| `POST /v1/translation` | translation | JSON `{ model, inputs, parameters?, provider? }` | JSON |
| `POST /v1/zero-shot-classification` | zero-shot-classification | JSON `{ model, inputs, parameters: { candidate_labels }, provider? }` | JSON |
| `POST /v1/text-to-image` | text-to-image | JSON `{ model, inputs, parameters?, provider? }` | Binário `image/*` |
| `POST /v1/text-to-video` | text-to-video | JSON `{ model, inputs, parameters?, provider? }` | Binário `video/*` |
| `POST /v1/image-to-image` | image-to-image | Binário `image/*` + `model`/`provider`/params via query string | Binário `image/*` |
| `POST /v1/image-classification` | image-classification | Binário `image/*` + `model`/`provider` via query string | JSON |
| `POST /v1/image-segmentation` | image-segmentation | Binário `image/*` + `model`/`provider` via query string | JSON |
| `POST /v1/object-detection` | object-detection | Binário `image/*` + `model`/`provider` via query string | JSON |
| `POST /v1/automatic-speech-recognition` | automatic-speech-recognition | Binário `audio/*` + `model`/`provider` via query string | JSON |
| `POST /v1/audio-classification` | audio-classification | Binário `audio/*` + `model`/`provider` via query string | JSON |

### Multi-provider, não fixo em `hf-inference`

Toda rota aceita `provider` opcional, repassado como está para a HF. Em `POST /v1/chat/completions`, `provider` (incluindo `"auto"`/omitido) é sempre repassado verbatim, sem default local. Nas 18 tasks não-chat, quando `provider` é omitido, `runJsonTask`/`runBinaryOutputTask`/`runBinaryInputTask` aplicam `DEFAULT_PROVIDER = "hf-inference"` — o único provider cujo formato de URL (`{router}/{provider}/models/{model}`, com `/pipeline/feature-extraction` como exceção) foi de fato inspecionado no código-fonte do SDK oficial; para qualquer outro provider explícito, o mesmo formato de URL é assumido sem validação adicional. O worker não interpreta nem reescreve `model` — sufixos nativos da HF (`:fastest`, `:cheapest`, `:preferred`, nome do provider) passam direto.

### Sem dependency nova — fetch cru contra `router.huggingface.co`

`lib/hf-client.mjs` implementa tudo com `fetch()` puro (`HF_ROUTER_URL = "https://router.huggingface.co"`), mantendo o padrão de zero dependencies de produção do projeto (só `esbuild` como devDependency). Nenhuma chamada a `@huggingface/inference`.

### Binário puro nas tasks de entrada binária — confirmado no código-fonte do SDK, não assumido

A documentação pública da HF não expõe o endpoint HTTP literal das 18 tasks não-chat (só exemplos via SDK). A spec registra a inspeção direta do código-fonte de `@huggingface/inference` (`providerHelper.ts`, classe base `TaskProviderHelper.makeBody`): quando o corpo é binário (`params.args.data`), ele é enviado como está (`BodyInit` cru, sem `JSON.stringify`), e `prepareHeaders` não força `Content-Type: application/json` nesse caso. `runBinaryInputTask()` implementa exatamente isso: `body: request.body` com `duplex: "half"`, `Content-Type` repassado verbatim do request original (fallback `application/octet-stream`) — sem base64, sem multipart. `model`/`provider` (e, só em `image-to-image`, parâmetros extras como `prompt`) vão via query string, já que o corpo da request é binário puro e não pode carregar metadados num envelope JSON.

### Autenticação: JWT + permission dedicada `huggingface:use`

Mesmo padrão RBAC do resto do projeto ([ADR 0007](0007-rbac-jwt-permissions.md)) — `lib/auth.mjs`/`lib/jwt.mjs` são cópias do padrão já usado nos outros workers. Todas as 19 rotas chamam `requirePermission(request, env, "huggingface:use")` antes de qualquer chamada à HF. Uma única permission cobre todas as 19 tasks — diferente do split `ai:chat`/`ai:agents`/`ai:teams` do `ai-worker`, aqui todas as rotas são a mesma capacidade conceitual: "usar a API de inference da HF". Seedada em `terraform/migrations/0026_seed_huggingface_permission.sql`, com a mesma paridade inicial de `ai:agents`/`ai:teams`/`graphrag:query`: só o profile `profile-admin`.

### `HF_TOKEN`: secret dedicado, escopado só a este worker — diferente de `JWT_SECRET`

Nova variável Terraform sensível `hf_token` (`terraform/variables.tf`, mesmo padrão de `jwt_secret`: `type = string`, `sensitive = true`, `default = ""`). A diferença estrutural relevante: `JWT_SECRET` é injetado em **todo** worker via `local.jwt_secret_binding`, concatenado incondicionalmente em `worker_bindings` (`terraform/locals.tf`); `HF_TOKEN` só é concatenado quando `key == "huggingface"` — `key == "huggingface" ? local.hf_token_binding : []` — nenhum outro worker recebe esse binding. Definido via `export TF_VAR_hf_token="hf_..."` antes de `terraform apply`, mesmo fluxo de `TF_VAR_jwt_secret` ([ADR 0005](0005-jwt-secret-management.md)). `terraform/environments/dev/terraform.tfvars` não referencia o secret diretamente no bloco `workers.huggingface` — ele chega via o mecanismo do `locals.tf`, não via `additional_bindings` inline no tfvars.

### Streaming: passthrough puro em `POST /v1/chat/completions`

Quando `body.stream === true`, `chatCompletion()` repassa o `ReadableStream` da resposta da HF direto ao cliente (`proxyResponse()`, sem parsing/tradução no meio) — diferente do `ai-worker`, que precisa traduzir o SSE bruto da Workers AI para o formato `chat.completion.chunk` ([ADR 0009](0009-system-message-normalization-in-cloudflare-workers-ai.md)); aqui a HF já entrega esse formato pronto.

### Erros: formato nested, mesmo padrão de `ai-worker`/`graph-worker`/`graphrag-worker`

```json
{ "error": { "message": "...", "type": "invalid_request_error" } }
```

`HfError` (`lib/hf-client.mjs`) unifica falhas de validação local (400/500) e erros traduzidos da HF (`toHfError()`, que extrai `body.error.message`/`body.error`/`body.message` da resposta da HF quando presente, preservando o status HTTP original — 4xx da HF vira o mesmo 4xx). Falha de rede/timeout ao alcançar a HF vira `502`. `index.mjs` trata `AuthError` e `HfError` no mesmo bloco `catch`, cada um mapeado para `{error:{message,type:"invalid_request_error"}}` com o status apropriado.

## Implementação

- `terraform/workers/huggingface/src/index.mjs`: roteamento das 19 rotas + `/health` + `/`/`/v1` (info, públicas, sem auth).
- `terraform/workers/huggingface/src/lib/hf-client.mjs`: `chatCompletion()`, `runJsonTask()`, `runBinaryOutputTask()`, `runBinaryInputTask()`, `buildModelUrl()`, `HfError`.
- `terraform/workers/huggingface/src/lib/auth.mjs`, `jwt.mjs`, `response.mjs`: mesmo padrão JWT + RBAC + CORS já usado em todos os outros workers.
- `terraform/migrations/0026_seed_huggingface_permission.sql` (D1 `dev-auth`): permission `huggingface:use`, atribuída a `profile-admin`.
- `terraform/variables.tf`: `hf_token` (sensível, default `""`).
- `terraform/locals.tf`: `hf_token_binding`, concatenado só para `key == "huggingface"`.
- `terraform/environments/dev/terraform.tfvars`: bloco `workers.huggingface` (`script_path`, `compatibility_date`), sem secret inline.
- `scripts/build-workers.mjs`: entrada `huggingface`.
- `.github/workflows/ci.yml`/`deploy.yml`: `TF_VAR_hf_token: ${{ secrets.HF_TOKEN }}` — necessário porque o workspace HCP Terraform roda em modo local nos runners do GitHub Actions (mesmo padrão de `TF_VAR_jwt_secret`).
- `tests/huggingface-worker.test.mjs`: cobre as 19 rotas, health/info públicos, CORS preflight, enforcement de `huggingface:use`, streaming SSE passthrough, default de `provider`, proxy binário verbatim (entrada e saída), tradução de erro 4xx/5xx/rede, `HF_TOKEN` ausente (fecha com 500).

## Trade-offs

| Abordagem | Vantagens | Desvantagens |
|---|---|---|
| **Worker separado, sem integração com `ai-worker` (escolhida)** | Superfície de API isolada e testável independentemente; não acopla o catálogo de tools/agents do `ai-worker` a um espaço de modelos externo grande e dinâmico | Cliente que quer usar HF a partir de um agent precisa de uma tool/Service Binding novos no futuro (fora de escopo hoje) |
| Tool nova em `lib/tools.mjs` do `ai-worker` (ADR 0023) | Reaproveita o loop de tool calling já existente | Aumenta o acoplamento do `ai-worker` a um provider externo antes de haver demanda concreta |
| **Fetch cru, sem `@huggingface/inference` (escolhida)** | Mantém zero dependencies de produção; controle total sobre headers/streaming/binário | Nuances por provider (`together`, `replicate`, etc.) não documentadas para chamada HTTP direta precisam ser descobertas manualmente, uma task por vez |
| Adotar `@huggingface/inference` | Nuances por provider resolvidas pelo SDK; menos código para manter | Quebra o padrão de zero dependencies já estabelecido; menos controle sobre streaming/binário puro |
| **`HF_TOKEN` escopado só ao `huggingface-worker` (escolhida)** | Superfície de exposição mínima — nenhum outro worker consegue ler o token mesmo que seu código seja comprometido | Padrão diferente de `JWT_SECRET` (global); um binding condicional a mais em `locals.tf` para lembrar ao adicionar workers futuros que também precisem de secrets escopados |
| `HF_TOKEN` global, como `JWT_SECRET` | Um único padrão de binding para todo secret do projeto | Token da HF exposto a 6 workers que não têm nenhuma razão de negócio para vê-lo |
| **Permission única `huggingface:use` para as 19 rotas (escolhida)** | Simples — todas as rotas são a mesma capacidade conceitual; uma migration, um `requirePermission()` por rota | Não permite RBAC granular por task (ex.: liberar só `feature-extraction` para um profile) sem uma spec nova |
| Permission por task ou por categoria (JSON/binário) | RBAC mais fino | 19 (ou 3) permissions para um caso de uso onde a spec não identificou necessidade de granularidade — overengineering sem demanda concreta |
| **`hf-inference` como default de provider (escolhida)** | Único provider cujo formato de URL foi de fato confirmado no código-fonte do SDK | Providers explícitos além de `hf-inference` usam o mesmo formato de URL por suposição, não por confirmação — risco documentado na spec ("Casos a verificar") |

## Gaps conhecidos

Detalhados em [`docs/specs/huggingface-worker-out-of-scope.md`](../specs/huggingface-worker-out-of-scope.md):

- **Sem integração com `ai-worker`/agents/teams**: não é Service Binding, não é tool, não é opção de `model` em `agent-db.mjs` — revisitar só se surgir demanda concreta de um agent precisar rodar inference via HF.
- **Sem cache, rate limiting ou controle de custo**: nenhuma chamada é cacheada, sem limite de requests por usuário além do all-or-nothing da permission RBAC, sem visibilidade de custo por chamada na conta HF por trás.
- **Sem `GET /v1/models`**: diferente do `ai-worker`, não existe um catálogo de modelos disponíveis por task/provider — `model` é sempre passado como está, sem validação/catálogo local.
- **Sem fallback próprio entre providers**: o worker repassa `provider` como veio (incluindo `"auto"`), sem lógica própria de retry entre providers além do "Automatic Failover" que a própria HF já oferece.
- **Sem validação/normalização de `parameters` por task**: os 19 schemas de parâmetros específicos (ex.: `width`/`height` de `text-to-image`, `candidate_labels` não-vazio de `zero-shot-classification`) não são validados localmente — a HF já valida e o worker só traduz o erro para o formato do projeto.
- **URL por provider assumida, não confirmada, para providers além de `hf-inference`**: a spec identifica isso explicitamente em "Casos a verificar" — só o formato de `hf-inference` foi inspecionado no código-fonte do SDK; `provider: "auto"` via HTTP direto (sem SDK) também não foi confirmado como equivalente ao comportamento do SDK.

## Referências

- `docs/specs/huggingface-worker.md` — spec completa desta feature
- `docs/specs/huggingface-worker-out-of-scope.md` — itens deliberadamente fora de escopo
- [ADR 0004: Múltiplos D1s por domínio](0004-d1-multiple-databases.md)
- [ADR 0005: JWT secret management](0005-jwt-secret-management.md)
- [ADR 0007: RBAC + JWT permissions](0007-rbac-jwt-permissions.md)
- [ADR 0008: API de IA com OpenAI compatibility](0008-openai-compatible-ai-api.md)
- [ADR 0009: System message normalization (Cloudflare Workers AI)](0009-system-message-normalization-in-cloudflare-workers-ai.md)
- [ADR 0011: Estratégia de testes unitários para workers](0011-unit-testing-strategy-for-workers.md)
- [ADR 0015: Service Bindings + RPC (WorkerEntrypoint)](0015-service-bindings-rpc-worker-communication.md)
- [ADR 0017: GraphRAG Worker — orquestrador dedicado](0017-graphrag-worker-hybrid-qa-orchestrator.md)
- [ADR 0025: Teams de agents no ai-worker](0025-agent-teams.md)
