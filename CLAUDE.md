# Claude Code Guide for wrapper-api

## claude config
- sempre que possivel delege assuntos de criacao ou edicao do dos workers , dentro da pasta `terraform/workers/{worker}/src/` use o sub agent `worker-dev` para lidar com a criacao de endpoints, rotas, logica de negocio e testes unitarios.
- para assuntos de terraform, infraestrutura, banco de dados, autenticação e permissões use o sub agent `infra-dev` para lidar com a criação de recursos, migrations, variáveis sensíveis
- apos executar os sub-agents: "worker-dev" ou "infra-dev", sempre que possivel, execute o sub-agent "doc-dev" para atualizar a documentação, ADRs e exemplos de API.




## Project Overview

**Wrapper API** é uma plataforma serverless construída com Cloudflare Workers e Terraform, implementando APIs para gerenciamento de ingredientes, autenticação, RAG (Retrieval-Augmented Generation), IA com compatibilidade OpenAI e um grafo de conhecimento.

## Architecture

```
Cloudflare Workers (6 workers) + D1 + R2 + KV + Queues
├── api-worker: CRUD de ingredientes
├── auth-worker: JWT, autenticação
├── rag-worker: Busca semântica (Vectorize + BGE embeddings)
├── ai-worker: Chat completions (OpenAI-compatível, Cloudflare AI)
├── graph-worker: Grafo de conhecimento (nodes/edges, complemento ao RAG)
└── graphrag-worker: Q&A híbrido (RAG + travessia do grafo), consome os outros 3 via Service Binding
```

**Infraestrutura como Código**: Terraform gerencia todos os recursos via HCP Terraform (workspace: `0xHackerSpace/config/wrapper-api`)

## Development Workflow

### Build & Deploy

```bash
npm run build:workers        # Compila todos os 6 workers (esbuild)
terraform plan              # Valida mudanças
terraform apply            # Deploy para Cloudflare
```

### Worker Structure

Cada worker segue o padrão:
```
terraform/workers/{name}/
├── src/
│   ├── index.mjs           # Handler principal
│   ├── lib/
│   │   ├── response.mjs    # Helpers HTTP
│   │   └── {features}.mjs  # Lógica específica
│   └── lib/db.mjs          # D1 bindings
└── dist/
    └── index.mjs           # Compilado (gerado por esbuild)
```

**Importante**: Todo código fica em `src/`, Terraform referencia `dist/`, esbuild resolve imports locais.

### Database

Múltiplos D1s por domínio:
- `dev-auth`: Usuários, profiles, permissões
- `dev-ingredient`: Ingredientes
- `dev-graph`: Grafo de conhecimento (nodes/edges)

Migrations via:
```bash
wrangler d1 execute dev-auth --remote < terraform/migrations/NNNN_nome.sql
```

## Key Files to Know

- **terraform/main.tf**: Root module (KV, R2, D1, routes)
- **terraform/modules/worker/main.tf**: Worker deployment logic
- **terraform/environments/dev/terraform.tfvars**: Dev config (workers, bindings)
- **scripts/build-workers.mjs**: Build script (esbuild para todos os workers)
- **docs/decisions/**: ADRs documentam decisões técnicas
- **requests/call.http**: Exemplos de API (REST Client extension)

## Patterns & Guidelines

### Code Style
- **Language**: JavaScript (ES Modules)
- **Linting**: ESLint (se disponível)
- **Formatting**: Prettier (se disponível)
- **Naming**: camelCase para funções/variáveis

### Error Handling
- Workers retornam erros em formato OpenAI para compatibilidade:
  ```json
  {"error": {"message": "...", "type": "invalid_request_error"}}
  ```
- HTTP status codes seguem REST padrão (400, 401, 404, 500)

### Autenticação
- **JWT Bearer tokens** gerados por `auth-worker`
- D1 binding `JWT_SECRET` (variável sensível Terraform)
- Rotas protegidas validam JWT antes de executar
- Permissões incluídas no JWT como array `["resource:action"]`

### AI Worker (OpenAI-compatível)
- Endpoints: `/v1/models`, `/v1/chat/completions`, `/health`
- Modelos disponíveis: Llama 2, Mistral, BGE (embeddings)
- System messages são concatenadas com primeira mensagem user (Cloudflare AI exigência)
- Resposta padronizada OpenAI com `choices`, `usage`, `finish_reason`

## Common Tasks

### Add a New Worker

1. Criar pasta `terraform/workers/{name}/src/`
2. Implementar `src/index.mjs` com handler default export
3. Adicionar entrada em `scripts/build-workers.mjs`
4. Configurar em `terraform/environments/dev/terraform.tfvars`:
   ```hcl
   {name} = {
     script_path        = "workers/{name}/dist/index.mjs"
     compatibility_date = "2026-08-24"
     bindings = [...]
   }
   ```
5. Rodar `npm run build:workers && terraform apply`

### Add Database Migration

1. Criar arquivo em `terraform/migrations/{sequence}_{name}.sql` (numeração sequencial global, sem subpasta por DB)
2. Adicionar o path à lista `migrations` do D1 correspondente em `terraform/environments/{env}/terraform.tfvars`
3. Executar manualmente (nunca automático): `wrangler d1 execute {db-name} --remote < terraform/migrations/{file}.sql`
4. Documentar em `docs/architecture.md`

### Update Documentation

- **Architecture**: `docs/architecture.md` (visão geral, endpoints, DBs)
- **ADRs**: `docs/decisions/` (decisões técnicas com contexto)
- **API Examples**: `requests/call.http` (REST Client)

## Testing

Testes unitários rodam com o Node.js test runner nativo (sem dependências):

```bash
npm test                              # Roda todos os testes em tests/*.test.mjs
node --test tests/ai-worker.test.mjs  # Roda um arquivo específico
```

Cada worker tem um arquivo `tests/{worker}-worker.test.mjs` que importa o `index.mjs` real e chama `worker.fetch(request, env, ctx)` com um harness de bindings mockados (D1 em memória, `AI.run()` fake, etc). Ao adicionar um worker ou rota, adicione testes seguindo esse padrão.

Testar manualmente via:
- REST Client (VS Code extension `humao.rest-client`)
- Exemplos em `requests/call.http`
- Cloudflare dashboard para logs de workers

## Secrets & Environment

- **JWT_SECRET**: Variável sensível Terraform, injetada em todos os workers
- Nunca commitr `.env` ou valores secretos
- Definir via: `export TF_VAR_jwt_secret="..."` antes de `terraform apply`

## Useful Commands

```bash
npm run build:workers              # Build todos os workers
terraform fmt                       # Formata HCL
terraform validate                 # Valida config
wrangler tail {worker-name}       # Logs ao vivo
wrangler d1 shell {db}            # SQL shell interativo
```

## Decision Records

Decisões arquiteturais documentadas em `docs/decisions/`:
- **0002**: Workers em ES Modules
- **0003**: Vectorize API provisioning
- **0004**: Múltiplos D1s
- **0005**: JWT secret management
- **0006**: Ingredients CRUD API
- **0007**: RBAC + JWT authentication
- **0008**: AI Worker com OpenAI compatibility
- **0009**: System message normalization (Cloudflare Workers AI)
- **0010**: Claude Code integration guidelines
- **0011**: Estratégia de testes unitários para workers
- **0012**: Graph Worker — grafo de conhecimento
- **0013**: Enforcement de permissões do JWT nos workers
- **0014**: Enforcement de permissões no AI Worker e no `/stats` do Auth Worker
- **0015**: Service Bindings + RPC (`WorkerEntrypoint`) como padrão de comunicação entre Workers
- **0016**: Grafos por domínio, service accounts e enriquecimento fire-and-forget do grafo via RAG
- **0017**: GraphRAG Worker — orquestrador dedicado para Q&A híbrido (RAG + Graph)
- **0018**: GitHub Actions — CI e CD para `dev`
- **0019**: Sessões de Chat no `ai-worker` (D1 `dev-chat`, endpoints `/v1/sessions/*`)
- **0020**: Compartilhamento, paginação e renomear de sessões de chat (`chat_access` ACL, keyset pagination)
- **0021**: Streaming (SSE) para chat completions e sessões de chat (`stream: true`, `chat.completion.chunk`)

Ler antes de propor mudanças significativas em arquitetura.

## When to Ask For Confirmation

- Mudanças em `terraform/main.tf` ou módulos
- Adicionar novos workers ou databases
- Alterações em autenticação/permissões
- Deploy para produção (terraform apply em main)

## Notes

- HCP Terraform gerencia state remotamente — não commitr `terraform.tfstate`
- Workspace atual usa `dev` environment (tfvars)
- Compatibilidade OpenAI permite integração fácil com SDKs existentes
- Cloudflare Workers AI oferece low-latency inference sem custo de API externa
