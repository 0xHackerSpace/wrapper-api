# ADR 0008: AI Worker com API OpenAI-compatível

O novo **AI Worker** (`https://dev-ai.0xhackerspace.workers.dev`) oferece uma API compatível com OpenAI usando modelos de IA do Cloudflare Workers AI, permitindo integração fácil com ferramentas e bibliotecas OpenAI-padrão.

## Motivação

Prover uma interface OpenAI-compatível para IA generativa sem adicionar dependências externas. Cloudflare Workers AI oferece modelos pré-treinados com baixa latência.

## Endpoints

- `GET /health` - Health check da IA
- `GET /` - Service info e documentação
- `GET /v1/models` - Lista modelos disponíveis
- `POST /v1/chat/completions` - Cria chat completion (compatível com OpenAI)

## Modelos Suportados

- `@cf/meta/llama-2-7b-chat-int8` (padrão) - Llama 2 7B quantizado
- `@cf/mistral/mistral-7b-instruct-v0.1` - Mistral 7B instruct
- `@cf/baai/bge-base-en-v1.5` - Embeddings BGE

## Request/Response (Chat Completions)

**Request:**

```json
{
  "model": "@cf/meta/llama-2-7b-chat-int8",
  "messages": [
    {
      "role": "system|user|assistant",
      "content": "string"
    }
  ],
  "temperature": 0.7,
  "max_tokens": 1024,
  "top_p": 1
}
```

**Response:**

```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "created": 1234567890,
  "model": "@cf/meta/llama-2-7b-chat-int8",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "..."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 0,
    "completion_tokens": 0,
    "total_tokens": 0
  }
}
```

## Implementação

- **Worker**: `terraform/workers/ai/src/index.mjs`
- **Helpers**: 
  - `terraform/workers/ai/src/lib/response.mjs` - HTTP responses
  - `terraform/workers/ai/src/lib/ai.mjs` - AI integration & validation
- **Binding**: `AI` (Cloudflare Workers AI)
- **Build**: Incluído no script `npm run build:workers`
- **Deploy**: Terraform configura o worker com binding AI

## Validação de Requests

- `messages` é obrigatório e deve ser um array não-vazio
- Cada mensagem deve ter `role` (user/assistant/system) e `content`
- `temperature`, `max_tokens`, `top_p` são opcionais com defaults sensatos
- `model` é opcional; usa Llama 2 como padrão

## Respostas de Erro

- `400 Bad Request`: Campos obrigatórios faltando ou inválidos
- `404 Not Found`: Endpoint não existe
- `500 Internal Server Error`: Erro no processamento ou binding não configurado

## Integração com OpenAI SDKs

O AI Worker pode ser usado como drop-in replacement com ajustes de URL:

```python
from openai import OpenAI

client = OpenAI(
    api_key="unused",
    base_url="https://dev-ai.0xhackerspace.workers.dev/v1"
)

response = client.chat.completions.create(
    model="@cf/meta/llama-2-7b-chat-int8",
    messages=[{"role": "user", "content": "Hello"}]
)
```

## Próximos Passos

- [ ] Adicionar autenticação JWT opcional
- [ ] Implementar streaming responses
- [ ] Suportar embeddings endpoint (`/v1/embeddings`)
- [ ] Cache de modelos para melhor performance
- [ ] Rate limiting e quota management
