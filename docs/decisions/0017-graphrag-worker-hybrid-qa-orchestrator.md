# ADR 0017: `graphrag-worker` como orquestrador dedicado para Q&A híbrido (RAG + Graph)

Introduz um sexto Worker, `graphrag-worker`, que combina busca vetorial (`rag-worker`) e travessia estrutural (`graph-worker`) para responder perguntas via `POST /v1/graphrag/query`, gerando a resposta final através do `ai-worker`. Fecha a Fase 4 do roadmap GraphRAG.

## Contexto

Com `ai-worker`, `graph-worker` e `rag-worker` já expondo RPC via Service Bindings ([ADR 0015](0015-service-bindings-rpc-worker-communication.md)) e com o `graph-worker` mantendo grafos isolados por domínio com ACL fina ([ADR 0012](0012-graph-worker-knowledge-graph.md), [ADR 0016](0016-domain-graph-service-accounts-and-fire-and-forget-enrichment.md)), faltava só compor as duas fontes de contexto (vetorial + estrutural) numa única resposta. Três decisões precisavam de resposta:

1. Onde o orquestrador do Q&A híbrido deve viver — dentro de um Worker existente ou num Worker novo.
2. Com qual identidade ele consulta o `graph-worker`, já que o traversal precisa respeitar `graph_access`.
3. Como reaproveitar (ou não) a extração de entidades já existente no `rag-worker` ([ADR 0016](0016-domain-graph-service-accounts-and-fire-and-forget-enrichment.md)).

## Decisão

### Worker novo e dedicado, não uma extensão de `rag-worker`/`ai-worker`

`graphrag-worker` é criado como o sexto Worker do projeto, HTTP-only: expõe `GET /health` e `POST /v1/graphrag/query`, mas não é ele próprio um `WorkerEntrypoint` — nenhum outro Worker o chama via RPC, ele está no topo da cadeia de Service Bindings, apenas consumindo `RAG_WORKER`, `GRAPH_WORKER` e `AI_WORKER`. Colocar essa lógica dentro do `rag-worker` (que já expõe `query()`) ou do `ai-worker` (que já expõe `chat()`) acoplaria um Worker de responsabilidade única a uma orquestração de três dependências, misturando o ciclo de vida/deploy de uma feature composta com o de uma capability atômica. Um Worker dedicado mantém `rag-worker` e `ai-worker` como blocos reaproveitáveis por qualquer orquestrador futuro, não só por este.

Nova permissão dedicada `graphrag:query` (migration `terraform/migrations/0013_add_graphrag_permission.sql`), não reaproveitando `rag:query` — o Q&A híbrido é uma feature distinta, com custo (três RPCs em cadeia) e superfície de dados (contexto de grafo) diferentes de uma consulta RAG pura. Atribuída aos profiles `Admin` e `RAG User` (quem já consulta RAG diretamente ganha a variante híbrida).

### `sub` do usuário autenticado nas chamadas ao `graph-worker`, nunca um service account

Diferente do `svc-api-ingredients`/`svc-rag-enrichment` da [ADR 0016](0016-domain-graph-service-accounts-and-fire-and-forget-enrichment.md) — que escrevem no grafo em nome do sistema, fire-and-forget —, o `graphrag-worker` **lê** o grafo em nome de quem está perguntando: `findNodeByLabel`/`findPaths` recebem `payload.sub`, extraído do JWT do próprio request. Isso garante que a ACL fina por grafo (`graph_access`) seja respeitada por usuário: alguém sem acesso a um grafo específico não recebe contexto estrutural dele através do endpoint híbrido, mesmo que o `graphId` seja aceito como parâmetro no body. Usar um `actorSub` de serviço fixo (como as duas escritas automáticas) quebraria esse isolamento, vazando dados de grafos privados de outros usuários.

### Degradação graciosa por etapa, não tudo-ou-nada

Das quatro chamadas RPC do fluxo, só duas são essenciais e podem propagar erro como `500`: `RAG_WORKER.query()` (contexto vetorial) e `AI_WORKER.chat()` (geração final). As chamadas de contexto estrutural — `GRAPH_WORKER.findNodeByLabel()` e `GRAPH_WORKER.findPaths()`, por entidade candidata — degradam individualmente: falha de uma (node não encontrado, sem acesso ao grafo, erro de RPC) descarta só aquela entidade, sem falhar a pergunta inteira. Se nenhuma entidade resolver, a resposta ainda é gerada normalmente usando só o contexto vetorial — o comportamento converge para o de um `/query` puro do `rag-worker`. A extração de entidades (`extractEntitiesFromQuestion`, via `AI_WORKER.chat()`) também nunca lança, seguindo o mesmo padrão defensivo do `lib/entity-extraction.mjs` do `rag-worker` ([ADR 0016](0016-domain-graph-service-accounts-and-fire-and-forget-enrichment.md)): JSON malformado ou falha de RPC degrada para `{entities: []}`.

### Extração de entidades duplicada, não compartilhada entre Workers

`terraform/workers/graphrag/src/lib/entity-extraction.mjs` é uma variante enxuta do `terraform/workers/rag/lib/entity-extraction.mjs` — extrai só `entities` (sem `relations`, que não fazem sentido para uma pergunta curta) via um prompt próprio. O código foi deliberadamente duplicado, não importado entre as árvores dos dois Workers: `scripts/build-workers.mjs` compila cada Worker isoladamente a partir do seu próprio `src/index.mjs` via esbuild, e cada Worker é um deploy Cloudflare independente. Fazer `graphrag-worker` importar de `terraform/workers/rag/lib/` acoplaria o build e o versionamento de dois Workers deployados separadamente por um módulo que, na prática, já diverge em propósito (documento inteiro vs. pergunta curta, com/sem `relations`). O custo aceito é manter os dois prompts/parsers sincronizados manualmente se a estratégia de extração mudar.

## Fluxo de `POST /v1/graphrag/query`

Body: `{ question, graphId="rag-documents", topK?, maxDepth?=2 }`, permissão `graphrag:query`.

1. `env.RAG_WORKER.query(question, {topK})` — contexto vetorial (essencial, erro propaga como `500`).
2. `extractEntitiesFromQuestion(env.AI_WORKER, question)` — entidades candidatas na pergunta (nunca lança).
3. Para cada candidata: `env.GRAPH_WORKER.findNodeByLabel(graphId, payload.sub, type, label)` seguido de `env.GRAPH_WORKER.findPaths(graphId, payload.sub, nodeId, {maxDepth})` — degrada por entidade.
4. Prompt combinando `ragResult.answer` + contexto do grafo formatado como texto (`Alho -[combines_with]-> Cebola (distance 1)`), enviado a `env.AI_WORKER.chat(...)` — resposta final (essencial, erro propaga como `500`).
5. Resposta: `{ question, answer, sources, graphContext }`.

## Consequências

- `graphrag-worker` é o quarto consumidor de Service Bindings (ADR 0015) e o primeiro a depender de três alvos simultaneamente (`rag`, `graph`, `ai`), mas o único que não expõe superfície RPC própria — fica no topo da topologia, nada é acoplado a ele em tempo de build/deploy além do Terraform que resolve seus três bindings.
- A ACL por grafo continua sendo a fonte de verdade de acesso a contexto estrutural, mesmo num fluxo de leitura combinada — nenhum bypass RBAC/JWT foi introduzido para essa feature.
- Falha de contexto estrutural nunca impede uma resposta; na pior hipótese (grafo indisponível, nenhuma entidade resolvida) o endpoint se comporta como um `/query` do `rag-worker`.
- Duplicar `entity-extraction.mjs` entre `rag-worker` e `graphrag-worker` é uma decisão consciente de isolamento de deploy sobre DRY; os dois arquivos podem divergir e exigem atualização manual coordenada se o formato do prompt/JSON mudar.

## Trade-offs

| Abordagem | Vantagens | Desvantagens |
|---|---|---|
| **Worker dedicado (`graphrag-worker`, escolhida)** | Mantém `rag-worker`/`ai-worker` reaproveitáveis como blocos atômicos; ciclo de deploy independente da orquestração; permissão (`graphrag:query`) e custo de RPC isolados numa única superfície | Um Worker a mais para operar/monitorar; três RPCs em cadeia concentradas num único ponto de falha para a feature híbrida |
| Estender `rag-worker` com o fluxo híbrido | Reaproveita `query()` já existente sem um novo Service Binding | Acopla uma capability atômica (busca vetorial) a uma orquestração de três dependências; mistura permissões (`rag:query` vs. `graphrag:query`) e custo de latência de casos de uso distintos |
| Estender `ai-worker` com o fluxo híbrido | `ai-worker` já é o ponto de geração final | `ai-worker` deixaria de ser uma capability genérica de chat para saber sobre RAG e grafo, quebrando sua reusabilidade por qualquer Worker que só precise de `chat()` |
| `actorSub` de serviço fixo nas chamadas ao `graph-worker` (como `svc-api-ingredients`/`svc-rag-enrichment`) | Simples, sem depender do JWT do request | Vazaria contexto estrutural de grafos privados de outros usuários — quebra a garantia de ACL por usuário que a [ADR 0016](0016-domain-graph-service-accounts-and-fire-and-forget-enrichment.md) preserva para escritas automáticas |
| Importar `lib/entity-extraction.mjs` do `rag-worker` em vez de duplicar | Uma única fonte de verdade para o prompt/parser | Acopla o build/deploy de dois Workers independentes; os dois casos de uso (documento inteiro vs. pergunta curta) já divergem em formato de saída (`relations` incluído ou não) |

**Decisão**: Worker dedicado (`graphrag-worker`), identidade do usuário real (`sub`) nas chamadas ao `graph-worker`, e duplicação deliberada da extração de entidades entre Workers.

## Referências

- [[0012-graph-worker-knowledge-graph|ADR 0012: Graph Worker — grafo de conhecimento]]
- [[0015-service-bindings-rpc-worker-communication|ADR 0015: Service Bindings + RPC entre Workers]]
- [[0016-domain-graph-service-accounts-and-fire-and-forget-enrichment|ADR 0016: Grafos por domínio, service accounts e enriquecimento fire-and-forget]]
