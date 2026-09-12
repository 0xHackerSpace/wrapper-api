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
- `auth`: login, logout
- `api`: access
- `rag`: ingest, query

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

Cada Worker recebe bindings D1 específicos no `tfvars`; migrations rodam via `wrangler d1 execute --remote`.

## API de Ingredientes

Conforme [ADR 0006](decisions/0006-ingredients-crud-api.md), ingredientes são gerenciados via endpoints RESTful:

```
GET    /ingredients      - Listar todos
GET    /ingredients/:id  - Obter um
POST   /ingredients      - Criar (requer: nome, slug, type)
PUT    /ingredients/:id  - Atualizar
DELETE /ingredients/:id  - Deletar
```

Campos: `id` (UUID), `nome`, `slug` (UNIQUE), `type`, `reference`, `url`, `permissions`, timestamps.

## API de IA com OpenAI Compatibility

Conforme [ADR 0008](decisions/0008-openai-compatible-ai-api.md), o AI Worker oferece uma API OpenAI-compatível usando Cloudflare Workers AI:

```
GET    /v1/models              - Listar modelos disponíveis
POST   /v1/chat/completions   - Chat completion (compatível com OpenAI)
GET    /health                - Health check
GET    /                       - Service info
```

Modelos suportados:
- `@cf/meta/llama-2-7b-chat-int8` (padrão)
- `@cf/mistral/mistral-7b-instruct-v0.1`
- `@cf/baai/bge-base-en-v1.5` (embeddings)

Permite integração fácil com SDKs OpenAI e ferramentas existentes sem dependências externas.

## Grafo de Conhecimento (Graph Worker)

Conforme [ADR 0012](decisions/0012-graph-worker-knowledge-graph.md), o Graph Worker complementa o `rag-worker` representando entidades e relações explícitas extraídas de documentos. Cada grafo é um container isolado (`graphs`): nodes/edges pertencem a exatamente um grafo, e o acesso a cada grafo é controlado por `graph_access` (papéis `owner`/`editor`/`viewer`), independente da permission RBAC `graph:read`/`graph:write` do JWT — a permission libera o uso da feature, o papel no `graph_access` libera o acesso àquele grafo específico:

```
GET    /health                                    - Health check
POST   /v1/graphs                                 - Criar grafo (criador vira owner)
GET    /v1/graphs                                 - Listar grafos que o usuário tem acesso
GET    /v1/graphs/:graphId/nodes/:id              - Buscar entidade
GET    /v1/graphs/:graphId/nodes?type=X           - Listar entidades por tipo
POST   /v1/graphs/:graphId/nodes                  - Criar entidade (requer editor/owner)
POST   /v1/graphs/:graphId/edges                  - Criar relação entre duas entidades (requer editor/owner)
GET    /v1/graphs/:graphId/nodes/:id/neighbors    - Listar entidades conectadas
GET    /v1/graphs/:graphId/nodes/:id/relations?to= - Relações diretas entre duas entidades
PUT    /v1/graphs/:graphId/access/:userId         - Conceder/atualizar papel de um colaborador (upsert, requer owner)
DELETE /v1/graphs/:graphId/access/:userId         - Revogar acesso de alguém (requer owner) ou sair do próprio grafo (self, requer só graph:read)
GET    /v1/graphs/:graphId/access                 - Listar colaboradores do grafo (requer viewer+)
```

Dados em D1 dedicado (`dev-graph`, binding `GRAPH_DB`), com tabelas `graphs`, `graph_access`, `nodes`/`edges`. Índices em `(graph_id, type, label)`, `from_node_id`, `to_node_id`, `graph_access.user_id`. Constraints de integridade: `UNIQUE(from_node_id, to_node_id, relation)` (evita edges duplicadas), `ON DELETE CASCADE` (remover um grafo/node limpa nodes/edges dependentes), `CHECK(json_valid(properties))`. Todas as rotas exigem JWT Bearer, incluindo leituras; rotas sob `/v1/graphs/:graphId/*` exigem também que o `sub` do token tenha uma entrada em `graph_access` para aquele grafo (404 se o grafo não existe, 403 se existe mas o usuário não tem acesso). O modelo de colaboradores (owner/editor/viewer, via `PUT`/`DELETE`/`GET .../access`, ver [spec](specs/graph-collaborator-management.md)) segue um upsert simples por `user_id` (sem lookup de username), com a invariante de que todo grafo deve sempre ter ao menos um `owner`.

## Gerenciamento de Secrets

Conforme [ADR 0005](decisions/0005-jwt-secret-management.md), `JWT_SECRET` é uma variável Terraform sensível injetada em todos os Workers como binding de tipo `secret_text`. Nunca é commitado; definido via `export TF_VAR_jwt_secret="..."` ou HCP Terraform UI.
