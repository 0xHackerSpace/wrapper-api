# Spec: Worker Hugging Face (`huggingface-worker`)

Gerado via interview (`/grilling`). Introduz um worker novo, `huggingface-worker`, dedicado à API de **Inference Providers** da Hugging Face (https://huggingface.co/docs/inference-providers/tasks/index) — totalmente segmentado do `ai-worker` (não o consome, não é consumido por ele nesta spec).

## Contexto

O projeto já tem `ai-worker` (chat completions via Cloudflare Workers AI) e `rag-worker` (embeddings via BGE, também Cloudflare Workers AI). A Hugging Face expõe uma superfície de API bem mais ampla via **Inference Providers**: um proxy unificado da HF que roteia chamadas pra dezenas de providers de infraestrutura (Cerebras, Together, Fireworks, Groq, Replicate, fal.ai, a própria HF via `hf-inference`, etc.), cobrindo ~19 tasks de ML diferentes.

Fatos confirmados via fetch da documentação oficial (não assumidos de memória):

- **Chat completion** tem um endpoint único, simples, 100% compatível com OpenAI: `POST https://router.huggingface.co/v1/chat/completions`. A HF escolhe o provider por trás (`provider: "auto"` = política `:fastest` por padrão). Confirmado com exemplo `curl` real na doc.
- **Autenticação contra a HF**: header `Authorization: Bearer hf_****` (token pessoal com permission "Inference Providers", gerado em `huggingface.co/settings/tokens`).
- **As outras 18 tasks não têm esse mesmo endpoint unificado** — a doc é explícita: "this OpenAI-compatible endpoint is currently available for chat completion tasks only. For other tasks... use the Hugging Face inference clients". Cada uma tem seu próprio formato de payload (`inputs`/`parameters`, não `messages`), e a doc recomenda os SDKs oficiais (`@huggingface/inference`, `huggingface_hub`) justamente porque nuances entre providers não são 100% documentadas para chamada HTTP direta.
- Seleção de provider: `provider: "auto"` (padrão, mais rápido disponível) ou nome específico (`"together"`, `"replicate"`, etc.); via sufixo no `model` também funciona: `:fastest`, `:cheapest`, `:preferred`, ou nome do provider (ex.: `"openai/gpt-oss-120b:groq"`).
- Existe um provider `hf-inference` (o antigo "Inference API (serverless)" da própria HF) que sozinho cobre quase todas as 19 tasks num formato consistente, mas essa spec não fixa nele — suporta seleção multi-provider (decisão explícita, ver abaixo).

## Decisão

### Worker novo, `huggingface-worker`, stateless

`terraform/workers/huggingface/src/index.mjs`, seguindo a mesma estrutura de todo worker do projeto (`src/index.mjs`, `src/lib/`, `dist/` gerado por esbuild — adicionar entrada em `scripts/build-workers.mjs`). **Sem D1 próprio** — nenhuma das 19 tasks tem razão para persistir estado; o worker é essencialmente um proxy autenticado e validado entre o cliente e a HF.

### Sem dependency nova — fetch cru contra `router.huggingface.co`

Mantém o padrão de zero dependencies de produção já estabelecido em todo o projeto (só `esbuild` como devDependency). Implementa `POST https://router.huggingface.co/v1/chat/completions` diretamente (formato confirmado). Para as outras 18 tasks, monta a URL/payload a partir do padrão documentado (`inputs`/`parameters`), tratando o formato exato por task/provider como **verificar durante implementação** (ver seção própria) em vez de importar `@huggingface/inference`.

### Multi-provider, não fixo em `hf-inference`

Toda rota aceita um campo opcional `provider` no corpo (repassado como está para a HF — `"auto"` se omitido) e o `model` aceita os sufixos nativos da HF (`:fastest`, `:cheapest`, `:preferred`, nome do provider) sem processamento local — o worker não interpreta nem reescreve o `model`, só repassa.

### Autenticação: JWT + permission dedicada `huggingface:use`

Mesmo padrão RBAC do resto do projeto. Todas as 19 rotas exigem `Authorization: Bearer <JWT>` com a permission `huggingface:use` no token — uma permission só, cobrindo todas as tasks (diferente do split `ai:chat`/`ai:agents`/`ai:teams`, aqui todas as 19 rotas são a mesma capacidade conceitual: "usar a API de inference da HF").

### Token da HF: secret dedicado, não reaproveita nada existente

Nova variável Terraform sensível `hf_token` (`terraform/variables.tf`, mesmo padrão de `jwt_secret`: `type = string`, `sensitive = true`, `default = ""`), injetada como binding `HF_TOKEN` **só no `huggingface-worker`** (diferente de `JWT_SECRET`, que é global a todos os workers via `local.jwt_secret_binding` em `terraform/locals.tf`) — usando o mecanismo já existente `worker.additional_bindings` (já concatenado em `locals.tf`, hoje vazio em todo worker): `additional_bindings = [{ name = "HF_TOKEN", type = "secret_text", text = var.hf_token }]` no bloco `workers.huggingface` do `tfvars`. Definido via `export TF_VAR_hf_token="hf_..."` antes de `terraform apply`, mesmo fluxo de `TF_VAR_jwt_secret` hoje.

### Uma rota HTTP por task (19 rotas), não um dispatcher genérico

Mesmo padrão de rotas explícitas já usado em todo o projeto. Todas exigem a permission `huggingface:use`; todas aceitam `model` (obrigatório) e `provider` (opcional).

| Rota | Task HF | Shape de entrada | Shape de saída |
|---|---|---|---|
| `POST /v1/chat/completions` | chat-completion | JSON `{ model, messages, provider?, stream?, ... }` | JSON (ou SSE se `stream: true`) — passthrough do formato OpenAI |
| `POST /v1/text-generation` | text-generation | JSON `{ model, inputs, parameters?, provider? }` | JSON |
| `POST /v1/feature-extraction` | feature-extraction | JSON `{ model, inputs, provider? }` | JSON (array de arrays — embeddings) |
| `POST /v1/fill-mask` | fill-mask | JSON `{ model, inputs, provider? }` | JSON |
| `POST /v1/question-answering` | question-answering | JSON `{ model, inputs: { question, context }, provider? }` | JSON |
| `POST /v1/summarization` | summarization | JSON `{ model, inputs, parameters?, provider? }` | JSON |
| `POST /v1/table-question-answering` | table-question-answering | JSON `{ model, inputs: { query, table }, provider? }` | JSON |
| `POST /v1/text-classification` | text-classification | JSON `{ model, inputs, provider? }` | JSON |
| `POST /v1/token-classification` | token-classification | JSON `{ model, inputs, provider? }` | JSON |
| `POST /v1/translation` | translation | JSON `{ model, inputs, parameters?, provider? }` | JSON |
| `POST /v1/zero-shot-classification` | zero-shot-classification | JSON `{ model, inputs, parameters: { candidate_labels }, provider? }` | JSON |
| `POST /v1/text-to-image` | text-to-image | JSON `{ model, inputs (prompt), parameters?, provider? }` | Binário (`image/*`) |
| `POST /v1/text-to-video` | text-to-video | JSON `{ model, inputs (prompt), parameters?, provider? }` | Binário (`video/*`) |
| `POST /v1/image-to-image` | image-to-image | Binário (`image/*`) + `model`/`provider`/params via query string (ver Casos a verificar) | Binário (`image/*`) |
| `POST /v1/image-classification` | image-classification | Binário (`image/*`) + `model`/`provider` via query string | JSON |
| `POST /v1/image-segmentation` | image-segmentation | Binário (`image/*`) + `model`/`provider` via query string | JSON |
| `POST /v1/object-detection` | object-detection | Binário (`image/*`) + `model`/`provider` via query string | JSON |
| `POST /v1/automatic-speech-recognition` | automatic-speech-recognition | Binário (`audio/*`) + `model`/`provider` via query string | JSON |
| `POST /v1/audio-classification` | audio-classification | Binário (`audio/*`) + `model`/`provider` via query string | JSON |

**`model`/`provider` via query string nas rotas binárias**: como o corpo dessas rotas é binário puro (não JSON — decisão já tomada), `model` (obrigatório) e `provider` (opcional) vão como query params (`?model=...&provider=...`), não no corpo. É a única forma de "metadados + binário" caber numa request `Content-Type: image/*`/`audio/*` sem envelope JSON nem multipart.

### Streaming: `POST /v1/chat/completions` com `stream: true`

Passthrough direto do SSE da HF ao client — sem parsing/tradução no meio (diferente do `ai-worker`, que precisa traduzir o SSE bruto da Workers AI pro formato `chat.completion.chunk`; aqui a HF já entrega exatamente esse formato). O worker só repassa `Content-Type: text/event-stream` e o corpo do `ReadableStream` como está.

### Erros: formato nested, mesmo padrão de `ai-worker`/`graph-worker`/`graphrag-worker`

```json
{ "error": { "message": "...", "type": "invalid_request_error" } }
```

Erros da própria HF (401, 404 modelo inexistente, 429 rate limit, 5xx do provider) são traduzidos para esse formato, preservando o `status` HTTP original quando fizer sentido (4xx da HF vira o mesmo 4xx; erros de rede/timeout viram `502`/`504`).

## Decisões de baixo nível (sem necessidade de validação)

- Nome do worker: `huggingface` (pasta `terraform/workers/huggingface/`), entrada em `scripts/build-workers.mjs` e em `terraform/environments/dev/terraform.tfvars` (`workers.huggingface`), mesmo padrão dos demais.
- `model` é sempre passado como está para a HF, sem catálogo/validação local (diferente do `ai-worker`, que tem um catálogo pequeno e fixo — o espaço de modelos da HF é grande demais pra replicar isso aqui).
- Sem rotas públicas (`/health`, `/`) fora do padrão — seguem existindo sem autenticação, mesmo padrão de todo worker do projeto.
- Content negotiation nas rotas binárias: `Content-Type` da request determina o tipo (`image/png`, `image/jpeg`, `audio/wav`, `audio/mpeg`, etc.) — repassado verbatim ao provider.

## Fatos adicionais confirmados (código-fonte do SDK oficial, `huggingface.js`)

A documentação renderizada não expõe o endpoint HTTP literal das tasks não-chat (só exemplos via SDK), mas o **código-fonte** do pacote `@huggingface/inference` (`packages/inference/src/providers/`, `providerHelper.ts`, `config.ts`) confirma o mecanismo real por trás do SDK:

- **Router base**: `HF_ROUTER_URL = "https://router.huggingface.co"` (constante literal em `config.ts`).
- **Base por provider**: `{HF_ROUTER_URL}/{provider}` (ex.: `https://router.huggingface.co/hf-inference` pro provider `hf-inference`) — cada provider (`baseten.ts`, `cerebras.ts`, `together.ts`, etc.) implementa seu próprio `makeUrl`/`makeRoute`, então o padrão pode variar por provider (arquivo próprio por provider é exatamente por isso).
- **Rota padrão** (`hf-inference`, `makeRoute`): `models/{model}` pra a maioria das tasks; `models/{model}/pipeline/{task}` especificamente pra `feature-extraction`/`sentence-similarity`. URL final: `{base}/{route}`.
- **Chat/text-generation**: override específico que aponta pro sufixo OpenAI-compatible (`/v1/chat/completions`, `/v1/completions`) em vez do padrão `models/{model}` — consistente com o que já foi confirmado via doc pública pra chat completion.
- **Corpo da request** (`providerHelper.ts`, classe base `TaskProviderHelper.makeBody`): se `params.args.data` estiver presente (binário), o corpo é enviado **como está** (`BodyInit` cru, sem `JSON.stringify`); senão, o corpo é `JSON.stringify(preparePayload(params))`. `prepareHeaders` **não** define `Content-Type: application/json` quando o corpo é binário (deixa o runtime inferir do próprio corpo, ex. de um `Blob`).
- Isso **confirma a decisão de binário puro** (Q9) como o caminho correto pro corpo da request nas tasks de entrada binária — não base64/multipart.

## Casos a verificar

Apesar do código-fonte confirmar o mecanismo geral, ainda vale testar com uma chamada real (usando um token HF de teste) antes de considerar as 18 rotas não-chat prontas — a implementação de cada provider (`hf-inference.ts` vs `together.ts` vs `replicate.ts` etc.) tem particularidades próprias que só o `hf-inference.ts` foi inspecionado diretamente:

- Confirmar que `{base}/models/{model}` (com `/pipeline/{task}` só pra feature-extraction/sentence-similarity) funciona de fato pra cada task via `provider=hf-inference`, e entender como o padrão muda pros outros providers suportados (`together`, `replicate`, `fal-ai`, etc.) — a spec já decidiu suportar multi-provider (Q4/Q5), então o worker precisa saber montar a URL certa pra qualquer provider selecionado, não só `hf-inference`.
- Se `provider: "auto"`/sem `provider` funciona via HTTP direto (sem SDK) — o SDK parece resolver isso client-side antes de montar a URL (escolhendo um provider concreto), então "auto" via HTTP cru pode não ter um endpoint equivalente direto; precisa confirmar.
- `image-to-image` (única task que mistura imagem de entrada + texto/parâmetros): como o prompt/parâmetros chegam junto com o binário — via query string (assumido nesta spec) precisa de confirmação real, já que o SDK constrói isso internamente de um jeito que não foi inspecionado em detalhe.
- Erros 429 (rate limit) da HF: confirmar se inclui `Retry-After` no header, pra decidir se o worker repassa esse header também.
- Tamanho máximo de payload binário que o runtime de Cloudflare Workers aceita, comparado ao limite da própria HF.

Tratar as 18 rotas não-chat como um catálogo incremental (mesma filosofia de `lib/tools.mjs` no `ai-worker`, ADR 0023): implementar e testar uma de cada vez, priorizando as mais simples/JSON primeiro (`feature-extraction`, `text-classification`, `summarization`, etc.) antes das binárias, que têm mais incerteza residual.

## Fora de escopo

Ver [huggingface-worker-out-of-scope.md](huggingface-worker-out-of-scope.md).
