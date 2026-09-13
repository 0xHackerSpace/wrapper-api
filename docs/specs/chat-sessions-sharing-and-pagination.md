# Spec: Compartilhamento, Paginação e Renomeação de Sessões de Chat

Complementa [chat-sessions.md](chat-sessions.md). Resolve 3 dos itens listados em [chat-sessions-out-of-scope.md](chat-sessions-out-of-scope.md) (compartilhamento, paginação/busca, renomear manualmente) — o quarto item (exposição via RPC) continua fora de escopo.

## Contexto

A spec original decidiu dono único sem ACL, sem paginação, e sem endpoint de renomear (título só auto-gerado). Este spec reverte essas três decisões, reaproveitando o modelo de ACL já validado e implementado pelo `graph-worker` ([ADR 0012](../decisions/0012-graph-worker-knowledge-graph.md), [spec graph-collaborator-management](graph-collaborator-management.md)): tabela de acesso separada com papéis `owner`/`editor`/`viewer`, invariante de "sempre ≥1 owner", upsert de papel, auto-remoção sem precisar ser owner.

## Compartilhamento (ACL)

### Schema

Nova tabela `chat_access` ([migration a criar], mesmo formato de `graph_access`):

| Campo | Tipo | Notas |
|---|---|---|
| `id` | TEXT (PK) | UUID. |
| `session_id` | TEXT | FK `chat_sessions(id)` `ON DELETE CASCADE`. |
| `user_id` | TEXT | Quem tem acesso. |
| `role` | TEXT | `CHECK (role IN ('owner', 'editor', 'viewer'))`. |
| `created_at` | DATETIME | Default `CURRENT_TIMESTAMP`. |

`UNIQUE(session_id, user_id)` — um usuário tem no máximo um papel por sessão. Índice `idx_chat_access_user_id` em `user_id` (para listar "minhas sessões" via join).

`chat_sessions.user_id` continua existindo (criador original, metadado histórico), mas **deixa de ser a fonte de autorização** — toda checagem de acesso passa a consultar `chat_access`.

**Backfill**: sessões já criadas antes desta migration não têm linha em `chat_access` — a migration insere uma linha `owner` para cada `chat_sessions.user_id` existente, senão ninguém teria acesso a sessões já criadas (mesmo cuidado tomado na migration `0010` do `graph_access`).

### Semântica dos papéis

- **`owner`**: lê, manda mensagens, renomeia, gerencia colaboradores (`PUT`/`DELETE .../access/:userId`), apaga a sessão.
- **`editor`**: lê, manda mensagens (`POST .../messages`), renomeia. Não gerencia colaboradores nem apaga a sessão.
- **`viewer`**: só lê (`GET /v1/sessions/:id`, `GET /v1/sessions/:id/messages`).

### Rotas novas

```
PUT    /v1/sessions/:id/access/:userId   Conceder ou atualizar o papel de alguém (upsert)
DELETE /v1/sessions/:id/access/:userId   Revogar acesso de alguém, ou sair da própria sessão
GET    /v1/sessions/:id/access           Listar colaboradores da sessão e seus papéis
```

Autorização idêntica ao padrão de `graph`:

| Rota | Papel exigido |
|---|---|
| `PUT .../access/:userId` | `owner` (sempre, mesmo alterando o próprio papel) |
| `DELETE .../access/:userId` (a si mesmo) | qualquer papel (auto-remoção) |
| `DELETE .../access/:userId` (a outra pessoa) | `owner` |
| `GET .../access` | qualquer papel (`viewer`+) |

Todas exigem a permission RBAC `ai:chat` (sem nova permission — diferente do `graph`, aqui não há split `read`/`write`, o papel dentro da sessão já faz esse controle).

### Invariante: toda sessão sempre tem ≥1 owner

Mesma regra do grafo, aplicada em `PUT` (rebaixar o único owner → 409) e `DELETE` (remover o único owner, self ou por outro owner → 409). Múltiplos owners são permitidos.

### Mudanças nos endpoints existentes

- `GET /v1/sessions`: lista sessões onde o usuário tem **qualquer** linha em `chat_access` (não só as que criou), incluindo `role` na resposta de cada sessão.
- `GET /v1/sessions/:id`: exige qualquer papel (`viewer`+); 404 se não houver acesso.
- `POST /v1/sessions/:id/messages`: exige `owner` ou `editor`; `viewer` → 403 (não 404 — quem já tem acesso de leitura sabe que a sessão existe).
- `DELETE /v1/sessions/:id`: agora exige `owner` (antes, dono único implícito); `editor`/`viewer` → 403.

## Paginação

`GET /v1/sessions`:
- Query params `limit` (default 20, máx 100) e `cursor` (opaco, base64 de `"<updated_at>|<id>"`).
- Resposta: `{ "object": "list", "data": [...], "next_cursor": "..." | null }`, ordenado por `updated_at` desc (mesma ordenação de hoje).

**Mudança de contrato**: `GET /v1/sessions/:id` deixa de incluir `messages` inline (só retorna metadados: `id`, `title`, `created_at`, `updated_at`, `role`). Histórico de mensagens passa a ter endpoint próprio:

```
GET /v1/sessions/:id/messages?limit=&cursor=
```
- `limit` (default 20, máx 100), `cursor` opaco (base64 de `"<created_at>|<id>"`), ordenado por `created_at` asc.
- Resposta: `{ "object": "list", "data": [...], "next_cursor": "..." | null }`.

Aceito quebrar o contrato anterior de `GET /v1/sessions/:id` porque a feature foi implantada há poucas horas, sem consumidores reais ainda.

## Renomear sessão

`PATCH /v1/sessions/:id`, corpo `{ "title": "..." }`.

- Autorização: `owner` ou `editor` (mesmo tier de quem manda mensagem); `viewer` → 403.
- Validação: `title` deve ser string não-vazia, máx 200 caracteres (400 caso contrário) — mais generoso que os 50 caracteres do truncamento automático da primeira mensagem, já que aqui é escolha explícita do usuário.
- Resposta: `200` com a sessão atualizada.

## Casos a verificar

- `PUT` concede `editor` a um segundo usuário → esse usuário consegue `POST /messages` e `PATCH` (renomear), mas não `PUT`/`DELETE .../access` nem `DELETE` da sessão (403).
- `viewer` tentando `POST /messages`, `PATCH` ou `DELETE` da sessão → 403.
- `PUT` rebaixando o único `owner` → 409.
- `DELETE .../access/:userId` removendo o único `owner` (self ou por outro owner) → 409.
- `DELETE .../access/:userId` de si mesmo, sendo `viewer` → sucesso (sai da sessão).
- Usuário sem nenhuma linha em `chat_access` para a sessão → 404 em qualquer rota `/v1/sessions/:id*`.
- `GET /v1/sessions` pagina corretamente (`next_cursor` não nulo quando há mais resultados, nulo no fim).
- `GET /v1/sessions/:id/messages` pagina o histórico completo sem perder/duplicar mensagens entre páginas.
- Sessão criada antes desta mudança (sem linha em `chat_access` pré-migration) — após a migration de backfill, o criador original consegue acessar normalmente como `owner`.

## Gaps conhecidos

- Sem lookup de usuário por username/email — quem compartilha precisa saber o `user_id` (`sub` do JWT) de antemão, mesmo gap já aceito em `graph-collaborator-management.md`.
- Sem notificação ao usuário convidado.
- Exposição via RPC para outros workers continua fora de escopo (ver [chat-sessions-out-of-scope.md](chat-sessions-out-of-scope.md)).
