# Spec: Documento OpenAPI das APIs

## Contexto

O projeto expõe 6 Cloudflare Workers, cada um com sua própria superfície HTTP (`terraform/workers/{api,auth,ai,graph,rag,graphrag}/{src/,}index.mjs`), documentada hoje só informalmente em `requests/call.http` (arquivo único, ~727 linhas, exemplos via REST Client). Não existe nenhum arquivo OpenAPI/Swagger no repositório, nem nenhuma lib de schema validation (`zod`, `joi`, `ajv`, etc.) — o único devDependency do projeto é `esbuild`. Toda validação de request/response é feita à mão em código (checks `if`/`throw`).

Cada worker é implantado como serviço Cloudflare independente, todos seguindo o mesmo padrão de URL: `https://dev-{worker}.0xhackerspace.workers.dev` (via `cloudflare_workers_script_subdomain`, sem rotas customizadas — confirmado em `terraform/modules/worker/main.tf` e `terraform/outputs.tf`).

Três dos seis workers (`ai`, `graph`, `rag`) também são `WorkerEntrypoint` e expõem métodos RPC adicionais via Service Binding (`chat()`, `upsertNode`/`updateNode`/`deleteNode`/`createEdge`/`getNeighbors`/`findPaths`/`findNodeByLabel`, `query()`) — esses métodos não são alcançáveis via HTTP, só entre Workers na mesma conta Cloudflare.

## Fora de escopo

- **Métodos RPC-only** (Service Binding) — OpenAPI é um formato de descrição de API **HTTP**; RPC entre Workers não passa pela borda HTTP e não tem contrato representável nesse formato. Documentado só como nota textual no arquivo, não como `paths`.
- **Geração automática a partir do código** — exigiria adotar uma lib de schema validation (ex.: `zod` + `@asteasolutions/zod-to-openapi`) e refatorar a validação de todos os 6 workers, mudança de arquitetura muito maior que "documentar a API existente". Registrado como gap/próximo passo (ver seção própria).
- **Lint/validação automática de sintaxe** (ex.: `@redocly/cli`) — o projeto não tem nenhum linter/formatter configurado hoje (nem para JS/Terraform); adicionar um só para este arquivo destoaria do padrão atual. Revisão fica manual/via extensão da IDE.
- **Depreciar `requests/call.http`** — continua existindo em paralelo, sem sincronização automática com o OpenAPI (mantidos manualmente, podem divergir com o tempo).

## Decisão

### Um documento único, `docs/openapi.yaml`

Formato **YAML**, **OpenAPI 3.1** (compatível com JSON Schema — útil pros campos que aceitam `null`, como `title` em sessões de chat). Um arquivo só para os 6 workers (não um por worker), com `tags` separando por worker e um `servers` por worker.

```yaml
servers:
  - url: https://dev-api.0xhackerspace.workers.dev
    description: api-worker (dev)
  - url: https://dev-auth.0xhackerspace.workers.dev
    description: auth-worker (dev)
  - url: https://dev-ai.0xhackerspace.workers.dev
    description: ai-worker (dev)
  - url: https://dev-graph.0xhackerspace.workers.dev
    description: graph-worker (dev)
  - url: https://dev-rag.0xhackerspace.workers.dev
    description: rag-worker (dev)
  - url: https://dev-graphrag.0xhackerspace.workers.dev
    description: graphrag-worker (dev)
```

Cada operação (`paths./algo.get/post/...`) declara `tags: [api|auth|ai|graph|rag|graphrag]` para navegação em ferramentas como Swagger UI, já que os `servers` são globais ao documento (OpenAPI não amarra path a server específico sem `servers` por-operação, que não é necessário aqui — a convenção de tag já deixa claro qual worker serve qual rota).

### Mantido à mão

Escrito e atualizado manualmente a cada mudança de API, mesma disciplina já usada para `docs/specs/`, ADRs e `requests/call.http`. Sem geração automática a partir do código (ver Fora de escopo) — se o documento ficar desatualizado, é um lapso de processo, não uma falha de ferramenta.

### RBAC e papéis de ACL em prosa

OpenAPI não tem conceito nativo para permission strings (`ai:chat`, `graph:write`) nem para papel mínimo de ACL (`viewer`/`editor`/`owner` em `chat_access`/`graph_access`). Cada operação documenta isso na `description`, em texto livre, seguindo um padrão consistente:

```
Requer JWT + permission `ai:chat`. Papel mínimo na sessão: `editor`.
```

Sem vendor extensions (`x-required-permission` etc.) — não há hoje nenhuma ferramenta que consumiria esses campos programaticamente, então a máquina-legibilidade extra não paga o custo de verbosidade em ~40 operações.

### Exemplos reaproveitados de `requests/call.http`

Cada operação relevante ganha um `examples` no `requestBody`/`responses`, adaptado dos exemplos reais já existentes em `requests/call.http` (que tem exemplos pra quase toda rota, incluindo casos de erro 400/401/403/404/409).

### Segurança: HTTP Bearer (JWT)

```yaml
components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
      bearerFormat: JWT
```

Aplicado via `security: [{ bearerAuth: [] }]` em toda operação que exige `Authorization: Bearer <token>` (a maioria — as exceções são as rotas públicas: `/health`, `/`, `/v1`, `POST /signup`, `POST /login`, `POST /verify`, `POST /refresh`, `GET /v1/models`).

### Erros documentados como realmente são (sem unificar)

Os workers têm dois formatos de erro diferentes hoje, e o documento reflete essa realidade em vez de uma versão idealizada:

- `auth-worker`: `{ error: "mensagem" }` — string plana.
- Todos os outros 5 workers: `{ error: { message: "...", type: "invalid_request_error" } }` — objeto.

Dois schemas reutilizáveis em `components/schemas` (`AuthErrorResponse`, `ErrorResponse`), cada worker referenciando o que de fato usa.

## Escopo por worker (baseado no inventário de código)

| Worker | Rotas HTTP | Notas |
|---|---|---|
| `auth` | `/health`, `/`, `/signup`, `/login`, `/verify`, `/refresh`, `/stats` | Único com erro `{error: "string"}` plano. |
| `api` | `/health`, `/`, `/protected`, `/profile`, `/ingredients` (CRUD), `/ingredients/:id/recommendations` | — |
| `ai` | `/health`, `/`, `/v1`, `/v1/models`, `/v1/chat/completions`, `/v1/sessions*` (CRUD + mensagens + paginação + colaboradores), `stream: true` em dois endpoints | RPC `chat()` fora de escopo. |
| `graph` | `/health`, `/`, `/v1`, `/v1/graphs` (create/list), `/v1/graphs/:graphId/nodes*`, `/edges`, `/neighbors`, `/relations`, `/paths`, `/access*` | RPC (7 métodos) fora de escopo. |
| `rag` | `/health`, `/ingest`, `/query` | Auth própria (`authorize()`), pula JWT se `JWT_SECRET` ausente (dev fallback). RPC `query()` fora de escopo. |
| `graphrag` | `/health`, `/v1/graphrag/query` | Não é `WorkerEntrypoint` — não expõe RPC pra ninguém. |

Total aproximado: ~40 operações HTTP documentáveis, distribuídas conforme a tabela.

## Decisões de baixo nível (sem necessidade de validação)

- **Localização**: `docs/openapi.yaml` (raiz de `docs/`, mesmo nível de `architecture.md`).
- **`info.version`**: `"1.0.0"` estático — não há hoje nenhum esquema de versionamento de API no projeto pra amarrar a isso.
- **`operationId`**: gerado no padrão `{method}{PathEmCamelCase}` (ex.: `postV1SessionsIdMessages`) — só relevante pra geração de client SDKs, que não é um requisito hoje, mas custa pouco preencher corretamente.
- **Rotas públicas** (`/health`, `/`, etc.) entram no documento sem `security`, para completude — mesmo sem valor de "referência de auth", servem pra quem for explorar a API descobrir esses endpoints de liveness/info.

## Casos a verificar

- Documento passa validação básica de sintaxe YAML e estrutura OpenAPI 3.1 (verificação manual/via extensão de IDE, sem lint automatizado — ver Fora de escopo).
- Toda rota real do inventário acima aparece no `paths` — nenhuma rota inventada, nenhuma rota real esquecida.
- Cada operação autenticada declara `security: [{ bearerAuth: [] }]` e a permission/papel mínimo na `description`.
- `auth-worker` usa `AuthErrorResponse` nas respostas de erro; os outros 5 usam `ErrorResponse` — nenhum worker usa o schema errado.
- Exemplos em `examples` correspondem de fato ao que `requests/call.http` já tem (não são inventados).

## Gaps conhecidos / próximos passos

- **Geração automática**: se o projeto adotar uma lib de schema validation no futuro (`zod` + `zod-to-openapi` é o caminho mais direto dado o ecossistema JS/esbuild já em uso), este documento manual pode ser substituído por um gerado a partir do código — nesse momento, revisitar esta spec.
- **Divergência entre `openapi.yaml` e `requests/call.http`**: ambos mantidos à mão, sem sincronização — revisão de PR precisa lembrar de atualizar os dois quando uma rota muda (não automatizado).
- **Sem lint de sintaxe**: um erro de indentação YAML ou um campo inválido do schema OpenAPI só é percebido em revisão manual ou ao importar o arquivo numa ferramenta (Swagger UI, Postman) — sem CI gate.
- **RPC não documentado em nenhum formato formal**: os métodos RPC-only (`chat()`, `upsertNode` etc., `query()`) ficam descritos só em comentários de código e nos ADRs 0015/0016 — não há um "OpenAPI para RPC" (o formato não se aplica); se isso incomodar no futuro, a alternativa seria um documento separado ad-hoc (não OpenAPI).
