# Arquitetura

```text
Terraform root module
  ├── KV / R2 / D1 / Queues ──┐
  ├── DNS                     ├── Cloudflare API
  ├── Worker scripts + routes ─┘
  └── (futuro) WAF, Access, Zero Trust, Rulesets

terraform/workers/**/*.mjs ── código ES Modules carregado por Terraform ──┘
```

O state e o locking são gerenciados pelo HCP Terraform na organização `0xHackerSpace`, projeto `config` e workspace `wrapper-api`. Cada ambiente seleciona uma composição por meio de `terraform.tfvars`; como uma workspace possui um único state, esta workspace deve gerenciar somente um ambiente de cada vez. O root module cria primeiro os recursos de plataforma e constrói os bindings a partir de seus outputs. Assim, um Worker não precisa conhecer IDs de infraestrutura no código nem no `tfvars`.

O módulo `worker` publica um `cloudflare_workers_script` em sintaxe de módulos (`main_module`) e, opcionalmente, `cloudflare_workers_route`. Ele recebe apenas um caminho de arquivo `.mjs`; todo código permanece fora de HCL. Os fontes ficam em `terraform/workers/<nome>/src/` e esbuild gera um único ES Module em `dist/index.mjs`, resolvendo imports locais antes do upload. Os Workers ficam dentro da raiz Terraform para que HCP Terraform os inclua no pacote de execução remoto, sem misturar código JavaScript aos arquivos HCL. O recurso `cloudflare_workers_script` é o recurso estável atual do provider v5 para upload de script; a evolução para os recursos beta versionados será uma troca localizada no módulo.

Módulos iniciais: `worker`, `dns`, `kv`, `r2`, `d1` e `queues`. `waf` é um ponto de extensão documentado, sem regra padrão que possa bloquear tráfego inadvertidamente. Durable Objects, cron triggers, Turnstile, Access e Zero Trust entram por novos módulos e novos tipos de binding, sem alterar a divisão entre código e infraestrutura.

`vectorize` e `rag` seguem esse caminho. `vectorize` administra um índice Vectorize v2; como o provider ainda não possui recurso equivalente, ele usa `terraform_data` e a API da Cloudflare, conforme [ADR 0003](decisions/0003-vectorize-api-provisioning.md). `rag` compõe `r2`, `vectorize` e `worker` em uma stack de retrieval-augmented generation e entrega índice, bucket, modelos de Workers AI e parâmetros de recuperação ao Worker por bindings `ai`, `vectorize`, `r2_bucket` e `plain_text`.

Os tokens e secrets não são inputs do projeto. Use `CLOUDFLARE_API_TOKEN` e, para bindings secretos futuros, uma fonte segura/CI; valores secretos jamais devem entrar em `.tfvars` versionado.

## Autenticação e RBAC

O projeto implementa autenticação JWT e controle de acesso baseado em papéis (RBAC), conforme [ADR 0007](decisions/0007-rbac-jwt-permissions.md).

**Fluxo:**
1. Worker Auth valida credenciais contra D1 (`dev-auth`)
2. Fetch permissões via relacionamentos: `user_profiles` → `profiles` → `profile_permissions` → `permissions`
3. JWT retornado inclui `permissions` (array de `"resource:action"`) e `profiles` (array de nomes)
4. Cliente decodifica JWT e limita UI conforme permissões
5. Worker API valida JWT antes de executar operações protegidas

**Recursos e Ações:**
- `user`, `profile`, `permission`: CRUD completo
- `auth`: login, logout, stats (`GET /stats` do auth-worker requer `auth:stats`, ver [ADR 0014](decisions/0014-ai-chat-and-auth-stats-permission-enforcement.md))
- `api`: access
- `rag`: ingest, query
- `ai`: chat (`POST /v1/chat/completions` requer `ai:chat`, ver [ADR 0014](decisions/0014-ai-chat-and-auth-stats-permission-enforcement.md))

**Profiles Predefinidos:**
- Admin (17 permissões)
- User (5 permissões)
- Guest (2 permissões)
- RAG User (4 permissões)
- API User (3 permissões)

## Bancos de Dados Múltiplos

Conforme [ADR 0004](decisions/0004-d1-multiple-databases.md), usamos múltiplos D1s separados por domínio:

- **dev-auth**: Usuários, logs, profiles, permissões (5 migrations)
- **dev-ingredient**: Ingredientes (1 migration)
- **dev-graph**: Nodes e edges do grafo de conhecimento (1 migration)
- **dev-chat**: Sessões, mensagens e ACL de acesso de chat, exclusivo do `ai-worker` (3 migrations, ver [ADR 0019](decisions/0019-ai-worker-chat-sessions.md), [ADR 0020](decisions/0020-chat-session-sharing-and-pagination.md) e [ADR 0022](decisions/0022-agent-registration.md))
- **dev-agents**: Agents (configuração de IA reutilizável) e ACL de acesso, exclusivo do `ai-worker` (1 migration, ver [ADR 0022](decisions/0022-agent-registration.md))

Cada Worker recebe bindings D1 específicos no `tfvars`; migrations rodam via `wrangler d1 execute --remote`.

## API de Ingredientes

Conforme [ADR 0006](decisions/0006-ingredients-crud-api.md), ingredientes são gerenciados via endpoints RESTful:

```
GET    /ingredients                       - Listar todos
GET    /ingredients/:id                   - Obter um
POST   /ingredients                       - Criar (requer: nome, slug, type)
PUT    /ingredients/:id                   - Atualizar
DELETE /ingredients/:id                   - Deletar
GET    /ingredients/:id/recommendations?relation=&indirect=&maxDepth= - Ingredientes relacionados via grafo de conhecimento
```

Campos: `id` (UUID), `nome`, `slug` (UNIQUE), `type`, `reference`, `url`, `permissions`, timestamps.

### Recomendações via grafo de conhecimento

Conforme [ADR 0016](decisions/0016-domain-graph-service-accounts-and-fire-and-forget-enrichment.md), o `api-worker` mantém um grafo `ingredients` no `graph-worker` (Service Binding `GRAPH_WORKER`, [ADR 0015](decisions/0015-service-bindings-rpc-worker-communication.md)) sincronizado automaticamente a cada criação/edição/remoção de ingrediente: um node `{type: "ingredient", label: <nome>, properties: {ingredientId}}` por ingrediente, escrito como o service actor `svc-api-ingredients`. A sincronização roda em `ctx.waitUntil()` (best-effort, `terraform/workers/api/src/lib/graph-sync.mjs`) e nunca falha a resposta HTTP do `api-worker` se o `graph-worker` estiver indisponível.

`GET /ingredients/:id/recommendations` requer `ingredient:read` e resolve o node do ingrediente por `label` (o nome) antes de consultar o grafo:
- Sem `GRAPH_WORKER` configurado: `501`.
- Ingrediente inexistente no D1: `404`.
- Ingrediente existe mas ainda não tem node no grafo (lag de sincronização): `200` com lista vazia.
- `?indirect=true`: usa `findPaths` (travessia multi-hop, [ADR 0012](decisions/0012-graph-worker-knowledge-graph.md)) em vez de `getNeighbors` (vizinhos diretos); `?relation=` e `?maxDepth=` filtram/limitam a travessia.
- Cada vizinho é enriquecido de volta para o registro completo do ingrediente via `properties.ingredientId` + lookup no D1; se essa propriedade não resolver mais (ingrediente removido sem o node ter sido limpo ainda), cai para `{nodeId, label}`.

O seed do grafo `ingredients` (criação do grafo + `graph_access` para `svc-api-ingredients`) é um passo manual pendente, ver ADR 0016.

## API de IA com OpenAI Compatibility

Conforme [ADR 0008](decisions/0008-openai-compatible-ai-api.md), o AI Worker oferece uma API OpenAI-compatível usando Cloudflare Workers AI:

```
GET    /v1/models              - Listar modelos disponíveis
POST   /v1/chat/completions   - Chat completion (compatível com OpenAI)
GET    /health                - Health check
GET    /                       - Service info
```

`GET /v1/models`, `GET /health` e `GET /` continuam públicos. `POST /v1/chat/completions` exige JWT Bearer com a permission `ai:chat` (hoje atribuída só ao profile `Admin`), conforme [ADR 0014](decisions/0014-ai-chat-and-auth-stats-permission-enforcement.md). Conforme [ADR 0021](decisions/0021-chat-streaming.md), o corpo aceita `stream: true` para retornar a resposta como SSE (`Content-Type: text/event-stream`, eventos `chat.completion.chunk` estilo OpenAI) em vez de um JSON único.

Modelos suportados:
- `@cf/meta/llama-2-7b-chat-int8` (padrão)
- `@cf/mistral/mistral-7b-instruct-v0.1`
- `@cf/baai/bge-base-en-v1.5` (embeddings)

Permite integração fácil com SDKs OpenAI e ferramentas existentes sem dependências externas.

### Sessões de chat

Conforme [ADR 0019](decisions/0019-ai-worker-chat-sessions.md) e [ADR 0020](decisions/0020-chat-session-sharing-and-pagination.md), o `ai-worker` também mantém sessões de chat persistidas em D1 dedicado (`dev-chat`, binding `CHAT_DB`), separado do fluxo stateless de `/v1/chat/completions`:

```
POST   /v1/sessions                       - Cria sessão vazia (title: null), criador vira owner. Body aceita agent_id opcional (ver ADR 0022)
GET    /v1/sessions?limit=&cursor=        - Lista sessões que o usuário tem chat_access, paginado, ordenadas por updated_at desc
GET    /v1/sessions/:id                   - Metadados da sessão + role do chamador (sem messages inline)
PATCH  /v1/sessions/:id                   - Renomeia a sessão (body { title }, requer editor/owner)
POST   /v1/sessions/:id/messages          - Envia mensagem, persiste turno completo (user + assistant), requer editor/owner
GET    /v1/sessions/:id/messages?limit=&cursor= - Histórico paginado, ordenado por created_at asc, requer viewer+
DELETE /v1/sessions/:id                   - Remove sessão e mensagens (cascade), requer owner
PUT    /v1/sessions/:id/access/:userId    - Concede/atualiza o papel de um colaborador (upsert, requer owner)
DELETE /v1/sessions/:id/access/:userId    - Revoga acesso de alguém (requer owner) ou sai da própria sessão (self)
GET    /v1/sessions/:id/access            - Lista colaboradores da sessão (requer viewer+)
```

Todas exigem JWT Bearer com a permission `ai:chat` (a mesma de `/v1/chat/completions`, nenhuma nova permission foi criada — o papel dentro da sessão já controla o resto). Acesso a cada sessão é controlado por `chat_access` (papéis `owner`/`editor`/`viewer`, mesmo modelo de `graph_access`, [ADR 0012](decisions/0012-graph-worker-knowledge-graph.md)): `owner` lê, escreve, renomeia, gerencia colaboradores e apaga a sessão; `editor` lê, escreve e renomeia; `viewer` só lê. Toda sessão sempre tem ao menos um `owner` (invariante aplicada em `PUT`/`DELETE .../access`). Ator sem nenhuma linha em `chat_access` recebe `404` (não vaza existência da sessão); ator com papel insuficiente recebe `403`. Histórico completo é sempre persistido, mas só as últimas 20 mensagens da sessão são enviadas como contexto para `AI.run()` em cada nova mensagem. `GET /v1/sessions` e `GET /v1/sessions/:id/messages` usam paginação keyset com cursor opaco em base64 (`limit` default 20, máx 100). Conforme [ADR 0021](decisions/0021-chat-streaming.md), `POST /v1/sessions/:id/messages` também aceita `stream: true`: a resposta é enviada como SSE e a mensagem completa do assistente só é persistida (`addMessage` + `touchSession`) depois que o stream termina com sucesso — se falhar no meio, nada do assistente é gravado.

### Agents (configuração de IA reutilizável)

Conforme [ADR 0022](decisions/0022-agent-registration.md), o `ai-worker` também mantém **agents**: uma configuração nomeada e reutilizável (`system_prompt` + `model`/`temperature`/`max_tokens`/`top_p`) persistida em D1 dedicado (`dev-agents`, binding `AGENTS_DB`), separado de `dev-chat`:

```
POST   /v1/agents                       - Cria agent, criador vira owner automaticamente
GET    /v1/agents?limit=&cursor=        - Lista agents que o usuário tem agent_access, paginado (mesmo padrão de /v1/sessions)
GET    /v1/agents/:id                   - Detalhe (qualquer papel; 404 se sem acesso)
PATCH  /v1/agents/:id                   - Edita campos (requer editor/owner)
DELETE /v1/agents/:id                   - Apaga o agent (requer owner)
PUT    /v1/agents/:id/access/:userId    - Concede/atualiza o papel de um colaborador (upsert, requer owner)
DELETE /v1/agents/:id/access/:userId    - Revoga acesso de alguém (requer owner) ou sai do próprio agent (self)
GET    /v1/agents/:id/access            - Lista colaboradores do agent (requer viewer+)
```

Todas exigem JWT Bearer com a permission `ai:agents`, **separada** de `ai:chat` (gerenciar agents é uma capacidade administrativa/de configuração distinta de conversar) e checada antes de qualquer papel em `agent_access`. Acesso a cada agent segue o mesmo modelo `owner`/`editor`/`viewer` de `chat_access`/`graph_access`, com a mesma invariante de ao menos um `owner`.

`POST /v1/sessions` aceita um `agent_id` opcional no corpo: o `ai-worker` verifica `viewer`+ em `agent_access` para aquele agent (404 se inexistente ou sem acesso) e copia `system_prompt`/`model`/`temperature`/`max_tokens`/`top_p` como um **snapshot congelado** para as colunas `agent_*` da sessão, em `dev-chat`. `POST /v1/sessions/:id/messages` usa sempre esse snapshot (nunca reconsulta `dev-agents`) — editar ou apagar o agent depois não afeta sessões já criadas.

## RAG Worker (retrieval-augmented generation)

```
GET    /health   - Health check
POST   /ingest   - Indexar um documento (chunking + embeddings + Vectorize + R2)
POST   /query    - Busca semântica + geração de resposta
```

`POST /ingest` requer `rag:ingest`, `POST /query` requer `rag:query`. `POST /ingest` aceita um campo opcional `graphId` no payload (default `"rag-documents"`) que direciona o enriquecimento automático do grafo (ver abaixo) para um grafo específico.

Conforme [ADR 0015](decisions/0015-service-bindings-rpc-worker-communication.md), o `rag-worker` também é um `WorkerEntrypoint`: `fetch()` preserva integralmente o roteamento HTTP acima, e um novo método RPC `query(question, opts)` expõe a mesma lógica de busca vetorial + geração usada por `POST /query`, reaproveitável por outros Workers via Service Binding (ex.: o futuro `graphrag-worker` da Fase 4 do roadmap GraphRAG).

### Enriquecimento automático do grafo

Conforme [ADR 0016](decisions/0016-domain-graph-service-accounts-and-fire-and-forget-enrichment.md), cada `POST /ingest` dispara, em `ctx.waitUntil()` (fire-and-forget, depois de já ter respondido `201` ao cliente):
1. `lib/entity-extraction.mjs`: extrai entidades/relações do texto (limitado a 8000 caracteres) via `env.AI_WORKER.chat(...)` (RPC), pedindo um JSON estrito. Parsing defensivo — nunca lança; JSON malformado ou resposta inesperada do modelo degrada para `{entities: [], relations: []}`, com o erro logado.
2. `lib/graph-sync.mjs`: grava as entidades/relações extraídas no `graph-worker` (`upsertNode`/`createEdge` via RPC) como o service actor `svc-rag-enrichment`. Conflito de aresta duplicada (reingestão do mesmo documento) é tratado como sucesso silencioso.

Esse pipeline é best-effort: uma falha em qualquer etapa (extração ou sync) nunca atrasa nem derruba a resposta de `/ingest`, só é visível via log. O seed do grafo `rag-documents` (criação do grafo + `graph_access` para `svc-rag-enrichment`) é um passo manual pendente, ver ADR 0016.

## Comunicação entre Workers (Service Bindings + RPC)

Conforme [ADR 0015](decisions/0015-service-bindings-rpc-worker-communication.md), Workers que precisam chamar outro Worker da mesma conta usam **Service Bindings + RPC** (`WorkerEntrypoint`, de `cloudflare:workers`), não HTTP fetch com token. `workers` e `rag_stacks` ganham um campo opcional `service_bindings` (`{name, target_worker|target_rag, entrypoint}`) no Terraform, resolvido via locals puros (`worker_script_names`/`rag_script_names`) para não depender de outputs de módulo e evitar ciclos no grafo de dependências.

`ai-worker` é o primeiro Worker convertido: `fetch()` mantém 100% do roteamento HTTP existente (incluindo a permission `ai:chat`, [ADR 0014](decisions/0014-ai-chat-and-auth-stats-permission-enforcement.md)); um novo método RPC `chat(messages, options)` fica disponível apenas para Workers que o chamam via Service Binding, sem checagem de permissão adicional nesse caminho — a plataforma já restringe o acesso a Workers da mesma conta.

## Grafo de Conhecimento (Graph Worker)

Conforme [ADR 0012](decisions/0012-graph-worker-knowledge-graph.md), o Graph Worker complementa o `rag-worker` representando entidades e relações explícitas extraídas de documentos. Cada grafo é um container isolado (`graphs`): nodes/edges pertencem a exatamente um grafo, e o acesso a cada grafo é controlado por `graph_access` (papéis `owner`/`editor`/`viewer`), independente da permission RBAC `graph:read`/`graph:write` do JWT — a permission libera o uso da feature, o papel no `graph_access` libera o acesso àquele grafo específico:

```
GET    /health                                    - Health check
POST   /v1/graphs                                 - Criar grafo (criador vira owner)
GET    /v1/graphs                                 - Listar grafos que o usuário tem acesso
GET    /v1/graphs/:graphId/nodes/:id              - Buscar entidade
GET    /v1/graphs/:graphId/nodes?type=X&label=Y   - Listar entidades por tipo (label opcional, case-insensitive)
POST   /v1/graphs/:graphId/nodes                  - Criar entidade (requer editor/owner)
PUT    /v1/graphs/:graphId/nodes/:id              - Atualizar label/properties de uma entidade (requer editor/owner)
DELETE /v1/graphs/:graphId/nodes/:id              - Remover entidade, cascateando para suas edges (requer editor/owner)
POST   /v1/graphs/:graphId/edges                  - Criar relação entre duas entidades (requer editor/owner)
GET    /v1/graphs/:graphId/nodes/:id/neighbors?relation=&type= - Listar entidades conectadas (filtros opcionais)
GET    /v1/graphs/:graphId/nodes/:id/relations?to= - Relações diretas entre duas entidades
GET    /v1/graphs/:graphId/nodes/:id/paths?to=&maxDepth=&relation=&direction= - Travessia multi-hop (ver abaixo)
PUT    /v1/graphs/:graphId/access/:userId         - Conceder/atualizar papel de um colaborador (upsert, requer owner)
DELETE /v1/graphs/:graphId/access/:userId         - Revogar acesso de alguém (requer owner) ou sair do próprio grafo (self, requer só graph:read)
GET    /v1/graphs/:graphId/access                 - Listar colaboradores do grafo (requer viewer+)
```

`GET .../paths` faz travessia multi-hop via recursive CTE do D1/SQLite, com detecção de ciclo e `maxDepth` limitado a 1–6 (default 3; `LIMIT 200` linhas por segurança). Sem `?to=`, retorna todos os nodes alcançáveis a partir de `:id` (modo `reachable`); com `?to=`, retorna os caminhos entre os dois nodes (modo `paths`). `?relation=` filtra por tipo de relação e `?direction=` controla o sentido das edges seguidas (`outgoing`/`incoming`/`both`).

Dados em D1 dedicado (`dev-graph`, binding `GRAPH_DB`), com tabelas `graphs`, `graph_access`, `nodes`/`edges`. Índices em `(graph_id, type, label)`, `from_node_id`, `to_node_id`, `graph_access.user_id`. Constraints de integridade: `UNIQUE(from_node_id, to_node_id, relation)` (evita edges duplicadas), `ON DELETE CASCADE` (remover um grafo/node limpa nodes/edges dependentes), `CHECK(json_valid(properties))`. Todas as rotas exigem JWT Bearer, incluindo leituras; rotas sob `/v1/graphs/:graphId/*` exigem também que o `sub` do token tenha uma entrada em `graph_access` para aquele grafo (404 se o grafo não existe, 403 se existe mas o usuário não tem acesso). O modelo de colaboradores (owner/editor/viewer, via `PUT`/`DELETE`/`GET .../access`, ver [spec](specs/graph-collaborator-management.md)) segue um upsert simples por `user_id` (sem lookup de username), com a invariante de que todo grafo deve sempre ter ao menos um `owner`. Conforme [ADR 0015](decisions/0015-service-bindings-rpc-worker-communication.md), o `graph-worker` também é um `WorkerEntrypoint`: além do `fetch()` HTTP acima, expõe métodos RPC (`upsertNode`, `updateNode`, `deleteNode`, `createEdge`, `getNeighbors`, `findPaths`, `findNodeByLabel`) para outros Workers via Service Binding, recebendo um `actorSub` explícito e checando apenas o papel do usuário em `graph_access` — sem repetir a permission RBAC `graph:read`/`graph:write`, que fica exclusiva do caminho HTTP. Conforme [ADR 0016](decisions/0016-domain-graph-service-accounts-and-fire-and-forget-enrichment.md), esse caminho RPC é hoje consumido por dois service actors fixos, cada um dono de um grafo de domínio: `svc-api-ingredients` (grafo `ingredients`, recomendações do `api-worker`) e `svc-rag-enrichment` (grafo `rag-documents`, enriquecimento automático do `rag-worker`).

## GraphRAG Worker (Q&A híbrido)

Conforme [ADR 0017](decisions/0017-graphrag-worker-hybrid-qa-orchestrator.md), `graphrag-worker` é o sexto Worker do projeto: combina o contexto vetorial do `rag-worker` com o contexto estrutural do `graph-worker` para responder perguntas, gerando a resposta final via `ai-worker`. Diferente de `ai`/`graph`/`rag` (ADR 0015), ele **não** é um `WorkerEntrypoint` — é HTTP-only, no topo da cadeia de Service Bindings: consome `RAG_WORKER`, `GRAPH_WORKER` e `AI_WORKER`, mas nada o chama via RPC.

```
GET    /health                - Health check (reporta quais dos 3 bindings estão configurados)
POST   /v1/graphrag/query     - Q&A híbrido (RAG + travessia do grafo)
```

`POST /v1/graphrag/query` requer a permission `graphrag:query` (migration `0013_add_graphrag_permission.sql`, atribuída aos profiles `Admin` e `RAG User`). Body: `{ question, graphId="rag-documents", topK?, maxDepth?=2 }`. Fluxo de 4 passos:

1. `env.RAG_WORKER.query(question, {topK})` (RPC) — busca vetorial + geração, retorna `{question, answer, sources}`. Chamada essencial: erro propaga como `500`.
2. Extrai entidades candidatas da pergunta via `env.AI_WORKER.chat(...)` (RPC), usando um prompt local (`lib/entity-extraction.mjs`) — uma variante enxuta da extração do `rag-worker` (só `entities`, sem `relations`), deliberadamente duplicada em vez de importada entre os dois Workers, já que cada um é compilado e deployado de forma independente ([ADR 0017](decisions/0017-graphrag-worker-hybrid-qa-orchestrator.md)). Essa etapa nunca lança — degrada para `{entities: []}`.
3. Para cada entidade candidata: `env.GRAPH_WORKER.findNodeByLabel(graphId, sub, type, label)` seguido de `env.GRAPH_WORKER.findPaths(graphId, sub, nodeId, {maxDepth})` (RPC) — usa o `sub` do **próprio usuário autenticado** (extraído do JWT do request), não um service account, para que a ACL fina do grafo (`graph_access`) seja respeitada em nome de quem pergunta. Falha em qualquer uma dessas chamadas (node não encontrado, sem acesso ao grafo, erro de RPC) descarta só aquela entidade — degradação graciosa, nunca falha a pergunta inteira. Sem nenhuma entidade resolvida, a resposta final ainda é gerada normalmente usando só o contexto vetorial.
4. Monta um prompt combinando `ragResult.answer` (contexto vetorial já sintetizado) com o contexto do grafo formatado como texto legível (ex.: `Alho -[combines_with]-> Cebola (distance 1)`), e envia a `env.AI_WORKER.chat(...)` (RPC) para gerar a resposta final. Chamada essencial: erro propaga como `500`.

Resposta: `{ question, answer, sources, graphContext }`.

## Gerenciamento de Secrets

Conforme [ADR 0005](decisions/0005-jwt-secret-management.md), `JWT_SECRET` é uma variável Terraform sensível injetada em todos os Workers como binding de tipo `secret_text`. Nunca é commitado; definido via `export TF_VAR_jwt_secret="..."` ou HCP Terraform UI.
