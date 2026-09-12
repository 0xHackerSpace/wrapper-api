# ADR 0011: Estratégia de Testes Unitários para Workers

Cada Worker (`api`, `auth`, `ai`, `rag`) passa a ter uma suíte de testes em `tests/{worker}-worker.test.mjs`, executada pelo **Node.js test runner nativo** (`node --test`), sem dependências externas de framework de testes.

## Motivação

O projeto não tinha testes automatizados além de um arquivo isolado (`tests/rag-worker.test.mjs`), que estava com o import path quebrado (`../workers/rag/index.mjs` em vez de `../terraform/workers/rag/index.mjs`) e um teste de autenticação desatualizado (assumia um `AUTH_TOKEN` estático que a implementação já não usa — o worker migrou para JWT via `JWT_SECRET`).

Sem testes, mudanças nos workers dependiam de teste manual via `requests/call.http` contra o ambiente `dev` real. Isso não pega regressões antes do deploy. De fato, ao escrever a suíte, os testes expuseram **3 bugs de produção reais** que teste manual não havia detectado:

1. **api-worker**: rotas `/protected` e `/profile` faziam `return handleX(request, env)` sem `await` dentro do bloco `try`. Uma Promise retornada (mas não aguardada) de dentro de um `try` não tem sua rejeição capturada pelo `catch` — erros de `AuthError` (ex: token ausente) viravam unhandled rejection em vez de `401 JSON`.
2. **ai-worker**: `chatCompletion()` calculava `normalizedMessages` (que remove/mescla mensagens `role: "system"`) mas enviava o array `messages` original para `ai.run()`, revertendo silenciosamente a correção do [[0009-system-message-normalization-in-cloudflare-workers-ai|ADR 0009]] e reintroduzindo o erro `3030: Roles must alternate`.
3. **ai-worker**: `validateChatCompletionRequest()` lança 4 mensagens de erro de validação distintas, mas o handler só reconhecia a substring `"required"` para mapear para `400` — as outras 3 caíam em `500`.

## Implementação

### Padrão de Teste

Sem framework externo (Jest, Vitest, etc). Cada arquivo:

```javascript
import assert from "node:assert/strict";
import test from "node:test";
import worker from "../terraform/workers/{name}/src/index.mjs";

function harness(overrides = {}) {
  const env = { /* bindings mockados */ ...overrides };
  const call = async (path, init) => {
    const response = await worker.fetch(new Request(`https://x.test${path}`, init), env, {});
    return { status: response.status, body: await response.json() };
  };
  return { call, /* get, post, etc */ };
}

test("descrição do comportamento", async () => {
  const { call } = harness();
  const { status, body } = await call("/rota", { method: "GET" });
  assert.equal(status, 200);
});
```

### Mocks de Binding

- **D1 (`env.DB` / `env.INGREDIENTS_DB`)**: fake em memória que interpreta `prepare(sql).bind(...).all()/.first()/.run()` reconhecendo substrings da query (ex: `"WHERE id = ?"`, `"INSERT INTO ingredients"`).
- **Workers AI (`env.AI`)**: `{ async run(model, input) { return mockResponse } }`, com `runCalls` opcional para inspecionar o que foi realmente enviado ao modelo (usado para provar a normalização de `system` messages).
- **JWT**: tokens reais gerados com `generateToken()` do próprio worker (não mockado) para testar o fluxo de autenticação de ponta a ponta.

### Cobertura por Worker

| Worker | Arquivo | Testes | Cobre |
|---|---|---|---|
| api | `tests/api-worker.test.mjs` | 13 | health/info, JWT auth, CRUD de ingredientes, slug duplicado, fail-closed sem DB |
| auth | `tests/auth-worker.test.mjs` | 17 | signup/login, senha (PBKDF2), conta inativa, verify/refresh, stats |
| ai | `tests/ai-worker.test.mjs` | 8 | formato OpenAI, listagem de modelos, validação, binding ausente, normalização de system message |
| rag | `tests/rag-worker.test.mjs` | 7 | ingest/query, chunking, JWT auth, binding ausente |

**Total: 45 testes.**

### Execução

```bash
npm test                              # node --test tests/*.test.mjs
node --test tests/ai-worker.test.mjs  # arquivo único
```

## Trade-offs

| Abordagem | Vantagens | Desvantagens |
|-----------|-----------|--------------|
| **Node test runner nativo (escolhida)** | ✅ Zero dependências; ✅ Já incluso no Node 22; ✅ Rápido (~400ms para 45 testes) | ⚠️ Menos recursos que Jest/Vitest (sem snapshot testing, coverage nativo limitado) |
| Jest/Vitest | ✅ Ecossistema maduro, mocking avançado | ❌ Nova dependência; ❌ Configuração adicional (transform ESM, etc) |
| Miniflare / wrangler test | ✅ Ambiente Cloudflare mais fiel | ❌ Mais pesado; ❌ Overhead de setup para testes unitários simples |
| Apenas teste manual (`call.http`) | ✅ Sem código extra | ❌ Não pega regressões; ❌ Requer deploy prévio; ❌ Foi o que permitiu os 3 bugs acima passarem despercebidos |

**Decisão**: workers já são funções puras `fetch(request, env, ctx) → Response` — não precisam de um ambiente Cloudflare real para testes unitários de lógica de rota/validação. O Node test runner cobre isso sem custo de dependência.

## Próximos Passos

- [ ] Adicionar teste ao CI (GitHub Actions) rodando `npm test` em cada PR
- [ ] Medir cobertura com `node --test --experimental-test-coverage`
- [ ] Considerar Miniflare para testes de integração que precisem simular Durable Objects/Queues reais
- [ ] Exigir teste novo para toda rota nova adicionada a um worker

## Referências

- [[0008-openai-compatible-ai-api|ADR 0008: AI Worker com OpenAI Compatibility]]
- [[0009-system-message-normalization-in-cloudflare-workers-ai|ADR 0009: System message normalization]]
- [[0010-claude-code-integration-guidelines|ADR 0010: Claude Code Integration Guidelines]]
- `CLAUDE.md` — seção "Testing"
