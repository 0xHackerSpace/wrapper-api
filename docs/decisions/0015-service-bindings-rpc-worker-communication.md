# ADR 0015: Service Bindings + RPC (`WorkerEntrypoint`) como comunicação interna entre Workers

Workers que precisam chamar outro Worker da mesma conta Cloudflare passam a usar **Service Bindings + RPC** (`WorkerEntrypoint`, de `cloudflare:workers`), não HTTP fetch com um token auto-assinado. `ai-worker` é o primeiro Worker convertido, expondo um método RPC `chat(messages, options)` além do `fetch()` HTTP já existente.

## Motivação

O roadmap de integração RAG + Graph + AI + API (`rag-worker` chamando `ai-worker` para extração de entidades, `api-worker` sincronizando o grafo de ingredientes via `graph-worker`, um futuro `graphrag-worker` orquestrando os três) exige que Workers chamem uns aos outros internamente. Duas opções foram avaliadas:

- **HTTP fetch entre Workers**, autenticado com um JWT/token auto-assinado.
- **Service Bindings + RPC**, nativo da plataforma Cloudflare.

Service Bindings evitam o hop de rede/serialização HTTP, não exigem mintar/rotacionar uma credencial de serviço, e a própria plataforma restringe o acesso: só um Worker da mesma conta com o binding configurado alcança o método RPC — diferente de um endpoint HTTP, que qualquer portador de token válido acessa.

## Decisão

Adotar Service Bindings (bindings `type = "service"` no Terraform) + métodos RPC em subclasses de `WorkerEntrypoint` como mecanismo padrão de chamadas Worker-a-Worker. `fetch()` continua reservado para tráfego externo/client-facing, protegido por JWT + RBAC (ADRs 0007/0013/0014). Métodos RPC alcançados via Service Binding **não** repetem `requirePermission`/checagem de JWT — a fronteira de confiança já é "só é alcançável via Service Binding"; cada Worker decide, na sua própria superfície RPC, se precisa de alguma checagem adicional mais fina (ex.: ACL por recurso), mas não RBAC/JWT de novo.

### Terraform

- `terraform/variables.tf`: novo campo opcional `service_bindings` em `workers` e `rag_stacks` — lista de `{name, target_worker?, target_rag?, entrypoint?}` (`target_worker`/`target_rag` referenciam uma chave em `var.workers`/`var.rag_stacks`; `entrypoint` só é necessário quando o export não é a classe default).
- `terraform/locals.tf` / `terraform/rag.tf`: `worker_script_names` e `rag_script_names` são locals **puros** (`coalesce(script_name, "${environment}-${key}")`), resolvidos sem ler outputs de `module.worker`/`module.rag` — evita um ciclo no grafo de dependências do Terraform (um Worker referenciando o nome do script de outro antes de ele ser aplicado). Cada entrada de `service_bindings` é traduzida num binding `{name, type = "service", service = <script_name>, entrypoint?}`, concatenado aos demais bindings já existentes (`worker_bindings` / `rag_service_bindings`).
- Nenhuma mudança em `terraform/main.tf` nem nos módulos `worker`/`rag` — ambos já fazem passthrough genérico de `bindings`/`additional_bindings`.

### ai-worker (primeira conversão)

`export default { async fetch(request, env, ctx) {...} }` vira `export default class extends WorkerEntrypoint { async fetch(request) {...} }`, com `this.env`/`this.ctx` no lugar dos parâmetros `env`/`ctx`. O roteamento HTTP e `requirePermission(request, env, "ai:chat")` ([ADR 0014](0014-ai-chat-and-auth-stats-permission-enforcement.md)) permanecem idênticos. Novo método RPC:

```javascript
async chat(messages, options = {}) {
  const validated = validateChatCompletionRequest({ messages, ...options });
  return chatCompletion(this.env.AI, validated.messages, {
    model: validated.model, temperature: validated.temperature,
    max_tokens: validated.max_tokens, top_p: validated.top_p,
  });
}
```

Reaproveita a lógica pura já existente em `lib/ai.mjs` (já desacoplada de `Request`), sem checagem de permissão — quem chama via Service Binding já é outro Worker da mesma conta.

### Build e testes

- `scripts/build-workers.mjs`: `external: ["cloudflare:workers"]` na config do esbuild — é um builtin do runtime `workerd`, não deve ser bundlado.
- `cloudflare:workers` não existe fora do runtime `workerd`, o que quebraria `node --test` ao importar um Worker `WorkerEntrypoint`. `tests/support/cloudflare-workers-hooks.mjs` usa ESM loader hooks (`node:module`'s `register()`) para resolver `cloudflare:workers` para um shim mínimo (`class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }`) só durante os testes; `tests/support/register.mjs` registra esse hook. `package.json` `test` agora roda `node --import ./tests/support/register.mjs --test tests/*.test.mjs`. Esse padrão será reaproveitado pelas próximas conversões (`graph-worker` na Fase 1, `rag-worker` na Fase 3 do roadmap GraphRAG).
- `tests/ai-worker.test.mjs`: o harness passa a instanciar `new AiWorker({}, env)` e chamar `worker.fetch(request)` (sem `env`/`ctx` como argumentos separados de `fetch`). Novos testes cobrem `chat()` diretamente, sem HTTP, incluindo a mesma validação usada pelo endpoint `/v1/chat/completions`.

## Trade-offs

| Abordagem | Vantagens | Desvantagens |
|---|---|---|
| **Service Bindings + RPC (escolhida)** | Sem hop de rede/serialização HTTP; sem credencial extra para gerenciar/rotacionar; superfície RPC só alcançável por outros Workers da mesma conta (isolamento pela própria plataforma); erros propagam como exceções JS nativas | Acopla Workers na topologia de deploy do Terraform (um precisa referenciar o script name do outro); não é possível confirmar sem deploy real se erros customizados (`instanceof AuthError`) sobrevivem à serialização RPC do `workerd` |
| HTTP fetch entre Workers com token de serviço auto-assinado | Reaproveita a stack de auth já existente (JWT) | Exige mintar/rotacionar um "service token"; overhead de rede/serialização desnecessário para chamadas internas; superfície HTTP adicional a proteger |
| Cloudflare Queues para toda comunicação inter-worker | Desacopla completamente produtor/consumidor | Overhead de infra (consumer, DLQ, latência assíncrona) desnecessário para chamadas request/response síncronas como `chat()` |

**Decisão**: Service Bindings + RPC para chamadas síncronas request/response entre Workers da mesma conta; HTTP + JWT continua exclusivo para tráfego externo/client-facing.

## Próximos Passos

- [ ] Validar, ao implementar a Fase 1 do roadmap (conversão do `graph-worker`), se erros customizados sobrevivem à serialização RPC do `workerd`; se não, adotar checagem por `error.message`/`.name` em vez de `instanceof` nos Workers chamadores.
- [ ] Converter `graph-worker` (Fase 1) e `rag-worker` (Fase 3) para `WorkerEntrypoint`, reaproveitando o mesmo padrão de teste (`tests/support/`).
- [ ] Criar `graphrag-worker` (Fase 4), primeiro Worker a consumir Service Bindings para múltiplos alvos (`rag`, `graph`, `ai`) simultaneamente.

## Referências

- [[0002-workers-es-modules|ADR 0002: Workers em ES Modules]]
- [[0008-openai-compatible-ai-api|ADR 0008: AI Worker com OpenAI Compatibility]]
- [[0011-unit-testing-strategy-for-workers|ADR 0011: Estratégia de Testes Unitários para Workers]]
- [[0012-graph-worker-knowledge-graph|ADR 0012: Graph Worker — grafo de conhecimento]]
- [[0014-ai-chat-and-auth-stats-permission-enforcement|ADR 0014: Enforcement de permissões no AI Worker e auth stats]]
