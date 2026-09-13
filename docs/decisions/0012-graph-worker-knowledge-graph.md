# ADR 0012: Graph Worker — Grafo de Conhecimento como Complemento ao RAG

Um novo Worker, `graph`, foi adicionado ao projeto para representar entidades (`nodes`) e relações (`edges`) extraídas de documentos, expondo queries de grafo (vizinhos, relações diretas, busca por tipo) como complemento à busca vetorial já feita pelo `rag-worker`.

## Motivação

O `rag-worker` ([[0008-openai-compatible-ai-api|ADR 0008]]) resolve busca por similaridade semântica (embeddings + Vectorize), mas não modela relações explícitas entre entidades — por exemplo, "quais conceitos estão diretamente ligados a X" ou "que documentos referenciam a entidade Y" não são perguntas que busca vetorial responde bem. Um grafo de conhecimento separado, com nodes/edges tipados, cobre essa lacuna sem sobrecarregar o `rag-worker` com um modelo de dados que ele não precisa.

## Implementação

### Worker

```
terraform/workers/graph/
├── src/
│   ├── index.mjs           # roteador
│   └── lib/
│       ├── graph-db.mjs    # acesso a dados (nodes/edges) via D1 cru
│       ├── auth.mjs        # JWT bearer (copiado/adaptado do worker api)
│       ├── jwt.mjs         # generateToken/verifyToken (Web Crypto)
│       └── response.mjs    # helpers HTTP
└── dist/index.mjs          # gerado por esbuild, referenciado pelo Terraform
```

Segue o mesmo padrão dos demais workers ([[0002-workers-es-modules|ADR 0002]]): cada worker é bundlado isoladamente por esbuild, sem imports cross-worker — por isso `auth.mjs`/`jwt.mjs`/`response.mjs` são cópias adaptadas das versões do `api`-worker, não um módulo compartilhado.

### Rotas

| Rota | Auth | Descrição |
|---|---|---|
| `GET /health` | não | health check |
| `GET /` / `/v1` | não | info do worker |
| `POST /v1/nodes` | sim | cria entidade (`type`, `label`, `properties`, `source_document_id` opcional) |
| `GET /v1/nodes/:id` | sim | busca entidade por id |
| `GET /v1/nodes?type=X` | sim | lista entidades por tipo (`type` obrigatório) |
| `POST /v1/edges` | sim | cria relação entre dois nodes existentes (`relation`, `properties` opcional) |
| `GET /v1/nodes/:id/neighbors` | sim | lista nodes conectados, com o tipo de relação |
| `GET /v1/nodes/:id/relations?to=:otherId` | sim | relações diretas entre dois nodes específicos |

Todas as rotas de `/v1/nodes*` e `/v1/edges*` exigem JWT Bearer — inclusive leituras —, espelhando a postura do `rag-worker` (que protege tanto `/ingest` quanto `/query`). `POST /v1/edges` valida que `from_node_id`/`to_node_id` referenciam nodes existentes antes de criar a relação, evitando edges órfãs.

### Dados

D1 dedicado (`dev-graph`, binding `GRAPH_DB`), seguindo a estratégia de múltiplos D1s por domínio ([[0004-d1-multiple-databases|ADR 0004]]):

```sql
CREATE TABLE nodes (id, type, label, properties TEXT, source_document_id, created_at);
CREATE TABLE edges (id, from_node_id REFERENCES nodes(id), to_node_id REFERENCES nodes(id), relation, properties TEXT, created_at);
```

Migration versionada em `terraform/migrations/0007_create_graph_nodes_and_edges.sql`, com `run_migrations = false` no `tfvars` — aplicação é manual via `wrangler d1 execute dev-graph --remote`, com revisão explícita do SQL antes, seguindo a regra do projeto de nunca aplicar migration automaticamente.

### Terraform

Entradas adicionadas em `terraform/environments/dev/terraform.tfvars`:
- `d1_databases.graph` (`name = "dev-graph"`, `primary_location_hint = "wnam"`)
- `workers.graph` (`script_path = "workers/graph/dist/index.mjs"`, binding `GRAPH_DB` → `resource_key = "graph"`)

Nenhuma mudança em `main.tf`/`locals.tf`/módulos — o worker `graph` usa exatamente o mecanismo de merge de bindings já existente ([[0004-d1-multiple-databases|ADR 0004]]), e `JWT_SECRET` é injetado automaticamente via `local.jwt_secret_binding`, sem declaração manual.

### Testes

`tests/graph-worker.test.mjs` (13 testes), seguindo a estratégia de [[0011-unit-testing-strategy-for-workers|ADR 0011]]: harness com D1 fake em memória, `authHeader()` usando `generateToken()` real. Cobre health sem auth, criação de node/edge com e sem auth, listagem de neighbors, validação (400 vs 500), e 404.

## Trade-offs

| Abordagem | Vantagens | Desvantagens |
|-----------|-----------|--------------|
| **Worker + D1 dedicado (escolhida)** | Consistente com o padrão de domínio isolado ([[0004-d1-multiple-databases]]); reaproveita JWT/D1 já estabelecidos; sem infra nova (Neo4j, etc) | Grafo relacional sobre SQL (sem operadores de travessia nativos); queries multi-hop exigem SQL manual ou múltiplas chamadas |
| Estender o `rag-worker` com tabelas de grafo | Um só worker/deploy | Mistura dois modelos de dado (vetorial + relacional) num só domínio, dificultando manutenção e violando a separação por domínio já adotada |
| Banco de grafo dedicado (ex: Neo4j externo) | Travessias nativas, mais expressivo para queries complexas | Introduz dependência de infraestrutura fora do ecossistema Cloudflare; sem binding nativo Terraform equivalente aos já usados no projeto |

**Decisão**: para o escopo atual (vizinhos diretos, relações entre dois nodes, busca por tipo), D1 com índices em `type`/`from_node_id`/`to_node_id` é suficiente e mantém o projeto 100% dentro do ecossistema Cloudflare + Terraform já estabelecido.

## Próximos Passos

- [ ] Aplicar a migration `0007_create_graph_nodes_and_edges.sql` manualmente após `terraform apply` criar o D1 `dev-graph`
- [ ] Rodar `terraform apply` para provisionar `dev-graph` e o worker `graph` (pendente de confirmação explícita)
- [ ] Avaliar se leituras (`GET /v1/nodes*`) devem ficar públicas, caso o `rag-worker` (ou outro worker) precise consultar o grafo sem token de usuário
- [x] Endpoint de travessia multi-hop: `GET /v1/graphs/:graphId/nodes/:id/paths` (recursive CTE, `maxDepth` 1–6, detecção de ciclo) — Fase 1 do roadmap GraphRAG
- [x] `PUT`/`DELETE /v1/graphs/:graphId/nodes/:id` (CRUD de node que faltava) — Fase 1 do roadmap GraphRAG
- [x] Conversão para `WorkerEntrypoint` + métodos RPC via Service Binding (`upsertNode`, `updateNode`, `deleteNode`, `createEdge`, `getNeighbors`, `findPaths`, `findNodeByLabel`), ver [ADR 0015](0015-service-bindings-rpc-worker-communication.md)

## Referências

- [[0004-d1-multiple-databases|ADR 0004: Múltiplos D1s por domínio]]
- [[0008-openai-compatible-ai-api|ADR 0008: AI Worker com OpenAI Compatibility]]
- [[0011-unit-testing-strategy-for-workers|ADR 0011: Estratégia de Testes Unitários para Workers]]
- [[0015-service-bindings-rpc-worker-communication|ADR 0015: Service Bindings + RPC como comunicação interna entre Workers]]
- `CLAUDE.md` — seção "Architecture"
