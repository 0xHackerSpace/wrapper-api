# ADR 0016: Grafos fixos por domínio, sincronização best-effort via `ctx.waitUntil()` e extração de entidades por LLM

Duas features consomem o `graph-worker` via RPC ([ADR 0015](0015-service-bindings-rpc-worker-communication.md)) sem intervenção humana: o `api-worker` sincroniza ingredientes com um grafo de recomendação (Fase 2 do roadmap GraphRAG), e o `rag-worker` enriquece um grafo com entidades/relações extraídas de documentos ingeridos (Fase 3). Ambas levantam a mesma pergunta de design — qual grafo usar, quem escreve nele, e o que fazer quando a escrita falha — respondida aqui de forma consistente para as duas.

## Contexto

O `graph-worker` ([ADR 0012](0012-graph-worker-knowledge-graph.md)) já isola grafos por `graphs.id`, com acesso controlado por `graph_access` (`owner`/`editor`/`viewer`). Até agora todo grafo era criado e populado por um usuário humano via `POST /v1/graphs` + JWT. As Fases 2 e 3 introduzem o primeiro caso de escrita **automática**, feita por outro Worker em nome do sistema, não de um usuário autenticado — e o caminho RPC do `graph-worker` (`upsertNode`, `updateNode`, `deleteNode`, `createEdge`, `getNeighbors`, `findPaths`, `findNodeByLabel`) exige um `actorSub` explícito para checar `graph_access`, mas não exige um JWT.

Três decisões de design precisavam de uma resposta:
1. Qual `graphId` cada Worker automático usa, e como ele resolve nodes já existentes (dedup).
2. O que fazer quando `GRAPH_WORKER` está indisponível ou a chamada RPC falha.
3. Como transformar texto livre (documentos do RAG) em nodes/edges do grafo.

## Decisão

### Um grafo fixo por domínio, com um service account fixo

Em vez de um grafo único compartilhado ou de deixar o `graphId`/ator variável, cada domínio de escrita automática usa um `graphId` e um `actorSub` fixos, hardcoded no Worker que escreve:

| Domínio | Worker | `graphId` | `actorSub` |
|---|---|---|---|
| Recomendação de ingredientes | `api-worker` | `ingredients` | `svc-api-ingredients` |
| Enriquecimento via RAG | `rag-worker` | `rag-documents` (default; `POST /ingest` aceita `graphId` opcional no payload para sobrescrever) | `svc-rag-enrichment` |

Cada `actorSub` precisa de uma entrada em `graph_access` com papel `editor` para o grafo correspondente — a mesma ACL fina que já existe para usuários humanos, sem nenhum caminho especial de bypass. Um grafo por domínio (em vez de um grafo único) evita que recomendações de ingredientes e entidades de documentos RAG colidam em nodes/edges com significados diferentes sob o mesmo namespace.

Dedup de node é feito por `(graphId, type, label)`, via o método RPC `findNodeByLabel` (adicionado no Fase 1). O `api-worker` guarda a referência de volta em `properties.ingredientId`; ao editar um ingrediente (rename), a resolução do node usa o `label` **anterior** (snapshot pré-update), já que o label é justamente o campo que muda. Se o node esperado não existe (ex: predates o binding, ou uma sincronização anterior falhou), o Worker se autocura fazendo um `upsertNode` em vez de decidir que não há nada a fazer.

### Sincronização best-effort via `ctx.waitUntil()`, sem Cloudflare Queues

Toda escrita automática no grafo roda depois que a resposta HTTP principal já foi enviada ao cliente (`ctx.waitUntil()`), e uma falha nela nunca propaga para a resposta:
- `api-worker`: `syncIngredientCreated`/`Updated`/`Deleted` (`terraform/workers/api/src/lib/graph-sync.mjs`) só agendam a chamada RPC se `env.GRAPH_WORKER` existir; qualquer rejeição é capturada e logada (`console.error`), nunca lançada.
- `rag-worker`: `scheduleGraphEnrichment` (`terraform/workers/rag/index.mjs`) só agenda se **ambos** `env.AI_WORKER` e `env.GRAPH_WORKER` estiverem configurados; a extração + sync completas (`lib/entity-extraction.mjs` + `lib/graph-sync.mjs`) rodam dentro do mesmo `ctx.waitUntil()`, também com captura e log de erro no topo.

Cloudflare Queues foi avaliado e descartado para este caso: o módulo `queues` do projeto hoje só cria a queue, sem consumer, e adicionar um consumer só para estas duas sincronizações seria overhead de infraestrutura para uma chamada request/response que já é rápida o bastante para caber num `waitUntil()` (a resposta ao cliente não espera por ela de qualquer forma). Fica registrado como possível evolução se o volume de escritas justificar retry/DLQ mais robusto que "logar e seguir".

Consequência aceita: perda silenciosa de sincronização é possível (grafo indisponível, RPC falha, etc). Isso é compensado pelo padrão de "auto-cura" no update (recria o node se não achar) e pelo `GET /ingredients/:id/recommendations` tratando "ingrediente sem node ainda" como lista vazia, não como erro.

### Extração de entidades via LLM, com parsing defensivo

`rag-worker`'s `lib/entity-extraction.mjs` chama `env.AI_WORKER.chat(...)` (RPC, [ADR 0015](0015-service-bindings-rpc-worker-communication.md)) com um prompt pedindo um JSON estrito `{"entities":[...], "relations":[...]}`, `temperature: 0`. Nada nesse caminho garante que o modelo obedeça ao formato — a função nunca lança: JSON malformado, chaves ausentes, ou uma chamada RPC que falha todos degradam para `{entities: [], relations: []}`, com o motivo logado via `console.error`. A extração roda sobre o texto completo do documento (limitado a 8000 caracteres via `ENTITY_EXTRACTION_TEXT_LIMIT`), não por chunk, para não multiplicar chamadas pequenas ao LLM por ingestão.

Conflito de aresta duplicada (reingestão do mesmo documento) é tratado como sucesso silencioso em `lib/graph-sync.mjs`, via `isConflictError()` — um match textual em `error.message` (`/already exists/i`), não `instanceof`/`.status`. Essa escolha é uma incerteza herdada da [ADR 0015](0015-service-bindings-rpc-worker-communication.md): não foi possível confirmar sem um deploy real se erros customizados do `graph-worker` (`ConflictError`) preservam identidade ao atravessar a serialização RPC do `workerd`. O match textual é o sinal mais plausível disponível hoje; se um deploy real confirmar que `instanceof`/`.name` sobrevivem, vale substituir.

## Consequências

- Toda escrita automática no grafo passa pela mesma ACL fina (`graph_access`) que usuários humanos — nenhum bypass RBAC/JWT novo foi introduzido.
- Falha de sincronização é sempre não-fatal e não-bloqueante para o Worker que a dispara; o custo é dado potencialmente desatualizado no grafo até a próxima escrita bem-sucedida (sem retry automático).
- Extração de entidades depende da qualidade do LLM (`@cf/mistral/mistral-7b-instruct-v0.1` ou o modelo de geração configurado); falhas de parsing resultam em nenhum enriquecimento naquele ingest, silenciosamente — visível apenas via logs (`wrangler tail dev-rag`).
- Detecção de conflito de aresta por texto de mensagem é frágil a mudanças de wording no `graph-worker`; deve ser revisitada quando o comportamento real de erros via RPC for validado.

## Trade-offs

| Abordagem | Vantagens | Desvantagens |
|---|---|---|
| **Grafo fixo por domínio + service account fixo (escolhida)** | Isolamento claro entre domínios; ACL reaproveitada sem exceções; dedup previsível por `(type, label)` | `graphId` hardcoded no Worker de origem — trocar de grafo exige mudança de código, não config |
| Um grafo único compartilhado entre domínios | Um só grafo para consultar tudo | Nodes/edges de domínios diferentes (ingredientes vs. entidades de documentos) colidiriam em significado sob o mesmo namespace de `(type, label)` |
| Sincronização síncrona (bloqueando a resposta HTTP) | Garantia de consistência imediata | Acopla a latência/disponibilidade do `graph-worker` (ou do `AI_WORKER`, na extração) à resposta do `api-worker`/`rag-worker`, contrariando o objetivo de manter esses Workers utilizáveis mesmo com o grafo fora do ar |
| Cloudflare Queues para a sincronização | Retry/DLQ nativos, desacopla completamente produtor/consumidor | Overhead de infraestrutura (consumer, DLQ) para uma chamada request/response já rápida o bastante para um `waitUntil()`; o módulo `queues` hoje não tem consumer nenhum |

**Decisão**: grafo fixo + service account fixo por domínio, sincronização best-effort via `ctx.waitUntil()` sem Queues, e extração de entidades por LLM com parsing 100% defensivo (nunca lança).

## Próximos Passos

- [ ] Criar o grafo `ingredients` (`POST /v1/graphs`) e inserir manualmente `INSERT INTO graph_access (graph_id, user_id, role) VALUES ('ingredients', 'svc-api-ingredients', 'editor')` via `wrangler d1 execute dev-graph --remote` — seed de dado, não de schema, mesmo padrão da ADR 0012 (não automatizado; requer `terraform apply` prévio do binding `GRAPH_WORKER` no `api-worker`)
- [ ] Criar o grafo `rag-documents` e inserir `graph_access` para `svc-rag-enrichment` role `editor`, mesmo procedimento manual acima
- [ ] Validar contra um deploy real do `workerd` se `ConflictError` sobrevive à serialização RPC (ver risco já registrado na [ADR 0015](0015-service-bindings-rpc-worker-communication.md)); se sim, trocar `isConflictError()` de match textual para `instanceof`/`.name`
- [ ] Fase 4 do roadmap GraphRAG (`graphrag-worker`) reaproveita `entity-extraction.mjs` e o método RPC `query()` do `rag-worker` para o Q&A híbrido

## Referências

- [[0004-d1-multiple-databases|ADR 0004: Múltiplos D1s]]
- [[0012-graph-worker-knowledge-graph|ADR 0012: Graph Worker — grafo de conhecimento]]
- [[0015-service-bindings-rpc-worker-communication|ADR 0015: Service Bindings + RPC entre Workers]]
