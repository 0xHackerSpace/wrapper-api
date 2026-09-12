# Spec: Graph Collaborator Management

## Contexto

O `graph-worker` isola dados por grafo (`graphs` + `graph_access`, ver [ADR 0012](../decisions/0012-graph-worker-knowledge-graph.md)), com papéis `owner`/`editor`/`viewer`. Hoje só o criador de um grafo tem acesso a ele — não existe forma de convidar outro usuário. Este spec cobre a API para gerenciar quem tem acesso a um grafo já existente.

Não é necessária nenhuma migration nova: a tabela `graph_access` (com `CHECK (role IN ('owner', 'editor', 'viewer'))` e `UNIQUE(graph_id, user_id)`) já existe desde a migration `0010_add_graph_containers_and_access.sql`. Este spec é só a API por cima dela.

## Fora de escopo

- **Lookup de usuário por username/email.** Não existe hoje nenhum jeito de resolver username → `user_id` entre workers (o `auth-worker` não expõe esse endpoint, e o `graph-worker` não tem acesso ao D1 de auth). Quem convida precisa saber o `user_id` (o `sub` do JWT) da outra pessoa de antemão. Endpoint de busca por username fica para um spec futuro.
- Notificação ao convidado (email, webhook, etc).
- Auditoria/histórico de mudanças de acesso.
- Rate limiting de convites.

## Rotas

```
PUT    /v1/graphs/:graphId/access/:userId   Conceder ou atualizar o papel de alguém (upsert)
DELETE /v1/graphs/:graphId/access/:userId   Revogar acesso de alguém, ou sair do próprio grafo
GET    /v1/graphs/:graphId/access           Listar colaboradores do grafo e seus papéis
```

### `PUT /v1/graphs/:graphId/access/:userId`

Concede ou atualiza o papel de `:userId` no grafo. Comportamento de upsert: se `:userId` já tem uma linha em `graph_access` para esse grafo, o papel é atualizado; caso contrário, uma nova linha é criada.

**Autorização**: RBAC `graph:write` **e** o chamador precisa ser `owner` do grafo. Não existe caminho onde `editor`/`viewer` chame essa rota (nem para alterar o próprio papel).

**Corpo**:
```json
{ "role": "editor" }
```

**Validação**:
- `role` deve ser um de `owner`/`editor`/`viewer` (400 caso contrário).
- Se `:userId` já é o único `owner` do grafo e a requisição mudaria o papel dele para `editor`/`viewer` → 409 ("Graph must have at least one owner").

**Respostas**: `200` com a linha de acesso atualizada (`{ graph_id, user_id, role }`) em concessões/atualizações; `403` se o chamador não é owner ou não tem `graph:write`; `404` se o grafo não existe.

### `DELETE /v1/graphs/:graphId/access/:userId`

Revoga o acesso de `:userId` ao grafo.

**Autorização**, dois casos:
- **`:userId` é o próprio chamador** (saindo do grafo): RBAC `graph:read` é suficiente. Não precisa ser owner — qualquer papel pode se auto-remover.
- **`:userId` é outra pessoa**: RBAC `graph:write` **e** o chamador precisa ser `owner`.

**Validação**: se `:userId` é o único `owner` do grafo → 409 ("Graph must have at least one owner"), tanto na auto-remoção quanto na remoção por outro owner.

**Respostas**: `200`/`204` em sucesso; `404` se o grafo não existe **ou** se `:userId` não tinha acesso a esse grafo (idempotente, mas explícito — mesmo padrão já usado em `DELETE /ingredients/:id`); `403` se não autorizado; `409` no caso do último owner.

### `GET /v1/graphs/:graphId/access`

Lista os colaboradores do grafo.

**Autorização**: RBAC `graph:read` e qualquer papel (`viewer`+) — não precisa ser owner para ver quem mais colabora.

**Resposta**: `200` com a lista de `{ user_id, role, created_at }`, ordenada por `created_at`.

## Modelo de autorização (resumo)

| Rota | RBAC | Papel exigido no grafo |
|---|---|---|
| `PUT .../access/:userId` | `graph:write` | `owner` (sempre, mesmo alterando o próprio papel) |
| `DELETE .../access/:userId` (a si mesmo) | `graph:read` | qualquer um (auto-remoção) |
| `DELETE .../access/:userId` (a outra pessoa) | `graph:write` | `owner` |
| `GET .../access` | `graph:read` | qualquer um (`viewer`+) |

A separação de RBAC entre auto-remoção (`graph:read`) e ações sobre terceiros (`graph:write`) é intencional: o profile `User` seedado hoje (migration `0008`) só tem `graph:read`. Se auto-remoção exigisse `graph:write`, alguém com esse profile — convidado como `viewer` de um grafo alheio — nunca conseguiria sair dele.

## Invariante: todo grafo sempre tem ≥1 owner

Regra única, aplicada de forma consistente em `PUT` e `DELETE`, independente de quem executa a ação (o próprio owner ou outro owner administrando):

> Nenhuma operação pode resultar em um grafo com zero `owner`s.

Isso cobre: o último owner tentando sair (`DELETE` de si mesmo), o último owner sendo removido por outro owner (impossível se ele é o último — não existe "outro owner" nesse caso, mas a regra vale de forma geral), e o último owner sendo rebaixado via `PUT` para `editor`/`viewer`.

Múltiplos owners são permitidos — não há "transferência" de ownership, `role` é só um valor atribuído via upsert. Um grafo pode ter 2+ owners simultaneamente.

## Casos de erro a cobrir nos testes

- `PUT`/`DELETE` sobre outra pessoa por quem não é owner → 403.
- `PUT`/`DELETE` sobre outra pessoa com `graph:read` mas sem `graph:write` → 403.
- Auto-`DELETE` com apenas `graph:read` (sem `graph:write`) → sucesso.
- `PUT` com `role` inválido (fora do enum) → 400.
- `PUT` rebaixando o único owner → 409.
- `DELETE` removendo o único owner (self ou por outro owner) → 409.
- `PUT` upsert: conceder a quem já tem acesso atualiza o papel em vez de duplicar/errar.
- `GET` por um `viewer` → 200 (não precisa ser owner).
- Qualquer rota com `:graphId` inexistente → 404.
- `DELETE` de alguém que não tinha acesso → 404.

## Gaps conhecidos (não resolvidos por este spec)

- Sem lookup de username → `user_id`; convite exige saber o UUID de antemão.
- Sem endpoint para "quem sou eu no grafo X" (o papel do próprio chamador) — hoje só dá pra descobrir via `GET .../access` e procurar a si mesmo na lista.
