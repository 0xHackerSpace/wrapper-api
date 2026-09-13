# ADR 0013: Enforcement de Permissões do JWT nos Workers

Os Workers `api`, `graph` e `rag` passam a validar o array `permissions` do JWT (emitido pelo `auth-worker`) por rota, além de só checar se o token é válido. Junto disso, o modelo de RBAC ([ADR 0007](0007-rbac-jwt-permissions.md)) ganhou permissões e profiles para os dois recursos que ainda não tinham: `graph` e `ingredient`.

## Motivação

O JWT emitido no login já carregava `permissions: string[]` (ex: `"rag:query"`) desde o ADR 0007, mas nenhum Worker de fato lia esse array — `requireAuth`/`authorize` só verificavam que o token era válido. Na prática:

- `api-worker`: `/protected` e `/profile` aceitavam qualquer JWT válido; as rotas `/ingredients*` **não tinham auth nenhuma**, apesar de existir a permission `api:access` criada precisamente para isso.
- `rag-worker`: `/ingest` e `/query` aceitavam qualquer JWT válido, sem diferenciar `rag:ingest` de `rag:query`.
- `graph-worker` (recém-criado, [ADR 0012](0012-graph-worker-knowledge-graph.md)): mesma situação — só `requireAuth`, sem permission.

Ou seja, o modelo de RBAC existia nos dados (D1 `dev-auth`) mas não era aplicado em nenhum lugar do código.

## Implementação

### `requirePermission` (api-worker e graph-worker)

Ambos os workers têm sua própria cópia de `lib/auth.mjs` (cada worker é bundlado isoladamente, sem imports cross-worker). Adicionamos a mesma função nas duas cópias:

```javascript
export async function requirePermission(request, env, permission) {
  const payload = await requireAuth(request, env);

  if (!Array.isArray(payload.permissions) || !payload.permissions.includes(permission)) {
    throw new AuthError(403, `Missing required permission: ${permission}`);
  }

  return payload;
}
```

Token válido mas sem a permission → `403`, distinto do `401` de token ausente/inválido/expirado.

### rag-worker: `authorize()` inline

O `rag-worker` não usa `lib/auth.mjs` (tem um `authorize()` próprio dentro de `index.mjs`). A função ganhou um parâmetro opcional `permission`, e a tabela `ROUTES` passou a declarar qual permission cada rota exige:

```javascript
const ROUTES = {
  "/health": { method: "GET", handler: ..., authenticated: false },
  "/ingest": { method: "POST", handler: ingest, authenticated: true, permission: "rag:ingest" },
  "/query":  { method: "POST", handler: query,  authenticated: true, permission: "rag:query" },
};
```

Quando `env.JWT_SECRET` não está configurado, `authorize()` continua retornando cedo sem checar nada (comportamento de dev/teste preexistente, inalterado).

### Mapeamento de rotas → permission

| Worker | Rota | Permission |
|---|---|---|
| api | `GET/POST /protected`, `/profile` | `api:access` |
| api | `GET /ingredients`, `GET /ingredients/:id` | `ingredient:read` |
| api | `POST /ingredients` | `ingredient:create` |
| api | `PUT /ingredients/:id` | `ingredient:update` |
| api | `DELETE /ingredients/:id` | `ingredient:delete` |
| graph | `GET /v1/nodes*`, `/neighbors`, `/relations` | `graph:read` |
| graph | `POST /v1/nodes`, `POST /v1/edges` | `graph:write` |
| rag | `POST /ingest` | `rag:ingest` |
| rag | `POST /query` | `rag:query` |

`ai-worker` e a rota `GET /stats` do `auth-worker` ficaram fora de escopo: nenhum dos dois tinha JWT auth antes, e adicionar auth a uma rota antes pública é uma decisão de acesso diferente de "aplicar as permissions que já existem" — não foi feito aqui.

### Novas permissions e profiles seedados

Duas migrations novas em `terraform/migrations/`, aplicadas em `dev-auth` (nunca automaticamente sem revisão — ver [ADR terraform rules]):

**`0008_seed_graph_permissions.sql`**
- Permissions: `graph:read`, `graph:write`
- Profile `Graph User`: `auth:login`, `auth:logout`, `graph:read`, `graph:write`
- `Admin` ganha `graph:read` + `graph:write`; `User` ganha só `graph:read` (leitura, espelhando o padrão já usado para `rag:query`)

**`0009_seed_ingredient_permissions.sql`**
- Permissions: `ingredient:create`, `ingredient:read`, `ingredient:update`, `ingredient:delete`
- Profile `Ingredient User`: `auth:login`, `auth:logout`, `api:access`, `ingredient:read` (só leitura)
- Profile `Ingredient Admin`: mesmas + `ingredient:create`, `ingredient:update`, `ingredient:delete` (CRUD completo)
- `Admin` ganha as 4 permissions de `ingredient`

`api:access` foi incluído nos dois novos profiles de ingredient por retrocompatibilidade histórica (nenhuma rota depende mais dele para ingredientes), mas não tem efeito funcional adicional hoje.

### Testes

Cada worker afetado ganhou cobertura para o caso 403 (JWT válido, permission ausente), verificando que uma permission não "vaza" para outra ação do mesmo recurso (ex: `graph:read` não deve permitir `POST /v1/nodes`; `ingredient:read` não deve permitir `POST/PUT/DELETE /ingredients`). Total foi de 58 → 61 testes.

## Trade-offs

| Abordagem | Vantagens | Desvantagens |
|-----------|-----------|--------------|
| **Permission por rota, helper compartilhado por worker (escolhida)** | Simples, sem dependência nova; consistente com o padrão já existente de `requireAuth`/`AuthError` por worker; erro 403 explícito facilita debugging no cliente | Helper duplicado em cada worker (sem módulo compartilhado, por causa do bundling isolado do esbuild) |
| Middleware central de autorização (ex: um Worker "gateway" na frente dos outros) | Um único lugar para regras de acesso | Muda a topologia de rede inteira (novo Worker, nova rota Cloudflare); escopo bem maior que "aplicar o que já existe" |
| Checar permissions no cliente/gateway antes de chamar o Worker | Menos trabalho no Worker | Não é defesa real — qualquer requisição direta ao Worker ignora a checagem |

**Decisão**: manter a checagem no próprio Worker que possui o recurso, replicando o `requirePermission`/`authorize` como já se replica `auth.mjs`/`jwt.mjs` entre workers — é o padrão já estabelecido pelo projeto para lidar com o isolamento de bundling do esbuild.

## Próximos Passos

- [ ] Rodar `terraform apply` para aplicar as migrations 0008 e 0009 em `dev-auth` (pendente de confirmação)
- [x] Decidir se `ai-worker` deve ganhar autenticação/permission própria — feito em [ADR 0014](0014-ai-chat-and-auth-stats-permission-enforcement.md) (`ai:chat`)
- [x] Decidir se `GET /stats` do `auth-worker` deve exigir alguma permission — feito em [ADR 0014](0014-ai-chat-and-auth-stats-permission-enforcement.md) (`auth:stats`)
- [ ] Atribuir os profiles `Graph User`, `Ingredient User`/`Ingredient Admin` a usuários reais via `user_profiles` (hoje só existem os dados; nenhum usuário seed foi migrado para eles)
- [ ] Considerar extrair `lib/auth.mjs` para um pacote compartilhado se o número de workers crescer e a duplicação começar a doer

## Referências

- [[0007-rbac-jwt-permissions|ADR 0007: RBAC + JWT authentication]]
- [[0012-graph-worker-knowledge-graph|ADR 0012: Graph Worker — grafo de conhecimento]]
- [[0011-unit-testing-strategy-for-workers|ADR 0011: Estratégia de testes unitários para workers]]
- `.claude/rules/terraform.md` — regras de migration/apply
