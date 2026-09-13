# ADR 0020: Compartilhamento, Paginação e Renomeação de Sessões de Chat

Adiciona um modelo de ACL (`chat_access`: `owner`/`editor`/`viewer`) às sessões de chat do `ai-worker`, substituindo o modelo de dono único da [ADR 0019](0019-ai-worker-chat-sessions.md), além de paginação keyset em `GET /v1/sessions` e no histórico de mensagens, e um endpoint dedicado para renomear sessão.

## Contexto

A [ADR 0019](0019-ai-worker-chat-sessions.md) decidiu deliberadamente por dono único sem ACL, sem paginação e sem renomear manualmente, com esses três itens registrados como gaps conhecidos em [`docs/specs/chat-sessions-out-of-scope.md`](../specs/chat-sessions-out-of-scope.md). Esta ADR reverte essas três decisões — a spec completa está em [`docs/specs/chat-sessions-sharing-and-pagination.md`](../specs/chat-sessions-sharing-and-pagination.md).

O `graph-worker` já tinha resolvido exatamente o mesmo problema de propriedade compartilhada de dado por usuário via `graph_access` (`owner`/`editor`/`viewer`, [ADR 0012](0012-graph-worker-knowledge-graph.md), [spec graph-collaborator-management](../specs/graph-collaborator-management.md)), incluindo a invariante de "todo container deve ter ao menos um owner" e as rotas `PUT`/`DELETE`/`GET .../access`. Reaproveitar esse modelo, em vez de inventar um novo, evita reintroduzir o mesmo raciocínio (papéis, upsert, auto-remoção, invariante de owner) do zero para um segundo domínio.

## Decisão

### Reaproveitar o modelo de ACL do `graph_access`, não inventar um novo

`chat_access` (migration `0015_add_chat_access.sql`) espelha `graph_access` linha por linha: `id`, `session_id`/`graph_id` FK `ON DELETE CASCADE`, `user_id`, `role` com `CHECK (role IN ('owner', 'editor', 'viewer'))`, `UNIQUE(session_id, user_id)`. As mesmas três rotas de gestão de colaboradores (`PUT`/`DELETE /v1/sessions/:id/access/:userId`, `GET /v1/sessions/:id/access`) seguem a mesma semântica de autorização já validada no grafo: `PUT` sempre exige `owner`; `DELETE` de si mesmo não exige papel mínimo (auto-remoção); `DELETE` de outra pessoa exige `owner`; `GET` aceita qualquer papel (`viewer`+). A mesma invariante de "toda sessão sempre tem ≥1 owner" é aplicada nos mesmos dois pontos (`PUT` rebaixando o único owner, `DELETE` removendo o único owner por si mesmo ou por outro owner) → `409`.

`chat_sessions.user_id` é mantido (metadado histórico de "quem criou"), mas deixa de ser fonte de autorização — toda checagem passa a consultar `chat_access`, exatamente como `graphs.created_by` deixou de ser autoritativo quando `graph_access` foi introduzido.

### Semântica dos 3 papéis, adaptada ao domínio de chat

Diferente do grafo (onde `editor` e `viewer` têm um corte natural em torno de "escrever nodes/edges" vs "só ler"), sessão de chat tem uma ação central — mandar mensagem — que precisou de decisão própria:

- **`owner`**: lê, manda mensagem, renomeia, gerencia colaboradores, apaga a sessão.
- **`editor`**: lê, manda mensagem (`POST .../messages`), renomeia (`PATCH`). Não gerencia colaboradores nem apaga a sessão.
- **`viewer`**: só lê (`GET /v1/sessions/:id`, `GET /v1/sessions/:id/messages`).

Mandar mensagem e renomear ficam no mesmo tier (`editor`+) porque ambos são interações "de conversa" que não afetam quem tem acesso à sessão nem sua existência — diferente de apagar a sessão ou gerenciar acesso, que são ações administrativas reservadas a `owner`.

### `ai:chat` continua sendo a única permission RBAC

Nenhuma permission nova foi criada (nem um equivalente a `graph:write`/`graph:read`). O grafo precisa desse split porque a permission RBAC (`graph:write`) e o papel dentro do grafo (`graph_access`) resolvem problemas diferentes: a permission libera a *feature* para o profile, o papel libera o *grafo específico*. Em chat não há essa segunda dimensão de "feature × recurso" que justifique granularidade extra — `ai:chat` já libera a feature de chat como um todo, e o papel em `chat_access` (owner/editor/viewer) sozinho já decide o que a request pode fazer *dentro* de uma sessão específica. Criar `ai:chat:write`/`ai:chat:read` seria granularidade sem um caso de uso real por trás, mesmo raciocínio que já descartou permission dedicada na ADR 0019.

### Paginação keyset com cursor opaco

`GET /v1/sessions` e o novo `GET /v1/sessions/:id/messages` usam paginação por keyset (não `OFFSET`), com cursor opaco em base64 (`"<valor-de-ordenação>|<id>"`, decodificado/re-encodado em `chat-db.mjs`). Sessões ordenam por `updated_at DESC, id DESC`; mensagens por `created_at ASC, id ASC` (desempate por `id` garante cursor estável quando dois registros compartilham timestamp). Cada página busca `limit + 1` linhas para decidir `next_cursor` sem uma query `COUNT` separada. `limit` tem default 20 e máximo 100, clampado silenciosamente (sem erro) se fora do range.

Keyset foi escolhido sobre `OFFSET`/`LIMIT` pelo motivo padrão: performance estável independente da profundidade da página (sem re-escanear linhas já vistas) e sem duplicação/perda de itens se uma sessão nova for criada ou uma mensagem nova for enviada entre duas chamadas de paginação — problema real aqui, já que `updated_at` muda a cada mensagem.

### Quebra de contrato deliberada: `GET /v1/sessions/:id` não inclui mais `messages` inline

A ADR 0019 tinha `GET /v1/sessions/:id` retornando sessão + histórico completo embutido. Com paginação, isso deixou de fazer sentido — não dá para paginar um campo aninhado dentro do payload de outra rota sem contorcer o contrato. `GET /v1/sessions/:id` agora retorna só metadados (`id`, `title`, `created_at`, `updated_at`, `role` do chamador); histórico de mensagens passa a ter endpoint próprio (`GET /v1/sessions/:id/messages?limit=&cursor=`).

Quebrar esse contrato foi aceito porque a feature de sessões (ADR 0019) foi implantada há poucas horas, sem consumidores reais em produção ainda — o custo de migrar um client hipotético é zero agora e cresce a cada dia que passa.

### 404 uniforme para quem não tem nenhum acesso, 403 para quem tem acesso insuficiente

`requireRole()` (`chat-db.mjs`) distingue os dois casos deliberadamente: retorna `null` quando o ator não tem nenhuma linha em `chat_access` para a sessão (o caller converte isso em `404`, preservando a garantia da ADR 0019 de nunca vazar a existência de uma sessão alheia); lança `AuthError(403)` só quando o ator já tem algum papel, mas abaixo do mínimo exigido pela rota (nesse caso, `403` não vaza nada novo — quem já tem acesso de leitura sabe que a sessão existe). Isso muda o comportamento de `POST .../messages` e `DELETE /v1/sessions/:id` para um `viewer`: antes (dono único) não existia esse meio-termo; agora um `viewer` recebe `403` (não `404`) ao tentar mandar mensagem ou apagar a sessão.

## Implementação

- Migration `terraform/migrations/0015_add_chat_access.sql`: cria `chat_access` (`id`, `session_id` FK `ON DELETE CASCADE`, `user_id`, `role` `CHECK IN ('owner','editor','viewer')`, `UNIQUE(session_id, user_id)`, índice em `user_id`) e faz backfill de uma linha `owner` para cada `chat_sessions.user_id` já existente (mesmo cuidado da migration `0010` do `graph_access`), usando `lower(hex(randomblob(16)))` para gerar o id do backfill.
- `terraform/environments/dev/terraform.tfvars`: `0015_add_chat_access.sql` adicionada à lista `migrations` do D1 `chat`.
- `terraform/workers/ai/src/lib/chat-db.mjs`: `ROLE_RANK` (`viewer: 1, editor: 2, owner: 3`), `ConflictError` (novo, mapeado para `409`), `requireRole()` (ver seção 404 vs 403 acima), `getChatAccess`/`listChatAccess`/`upsertChatAccess`/`deleteChatAccess` com a invariante de ≥1 owner (`assertNotLastOwner`), `renameSession` (valida `title` não-vazio, máx 200 caracteres — mais generoso que os 50 caracteres do truncamento automático, por ser escolha explícita do usuário), `encodeCursor`/`decodeCursor` (cursor opaco base64) usados por `listSessionsForUser` e a nova `listMessagesPage`. `createSession` agora insere também a linha `owner` em `chat_access` para o criador.
- `terraform/workers/ai/src/index.mjs`: rotas existentes reescritas para checar papel via `requireRole()` em vez de `user_id == sub`. Rotas novas: `PATCH /v1/sessions/:id` (renomear, exige `editor`+), `GET /v1/sessions/:id/messages?limit=&cursor=` (histórico paginado, exige `viewer`+), `PUT|DELETE|GET /v1/sessions/:id/access[/:userId]` (gestão de colaboradores). `GET /v1/sessions/:id` não inclui mais `messages`. `GET /v1/sessions` agora pagina (`limit`/`cursor`) e lista sessões via `chat_access`, incluindo o `role` do chamador em cada item.
- `terraform/workers/ai/src/lib/response.mjs`: novo helper `conflict()` (`409`), usado pelo catch de `ConflictError` em `index.mjs`.
- Testes em `tests/ai-worker.test.mjs` reescritos/expandidos para cobrir os papéis, a invariante de owner, paginação e o novo endpoint de renomear.

## Trade-offs

| Abordagem | Vantagens | Desvantagens |
|---|---|---|
| **Reaproveitar o modelo `graph_access` (escolhida)** | Raciocínio de ACL, invariante de owner e rotas já validados em produção pelo grafo; menos superfície nova para revisar/testar | `chat_access` e `graph_access` são tabelas duplicadas (schemas quase idênticos) em D1s diferentes — sem tabela compartilhada entre domínios, por design (ADR 0004) |
| ACL genérica compartilhada entre grafo e chat | Uma implementação só | Misturaria domínios em D1s diferentes (violaria "múltiplos D1 por domínio", ADR 0004); acoplaria dois Workers que hoje evoluem de forma independente |
| Nova permission RBAC granular (`ai:chat:read`/`ai:chat:write`) | Simetria com o padrão `graph:read`/`graph:write` | Sem caso de uso real — o papel em `chat_access` já resolve toda a granularidade necessária dentro de uma sessão |
| Manter `messages` inline em `GET /v1/sessions/:id` e paginar só via query param adicional | Sem quebra de contrato | Contorção do contrato (paginar um campo aninhado); pior ergonomia de cache/etag do que um endpoint dedicado |
| Paginação por `OFFSET`/`LIMIT` | Mais simples de implementar | Instável sob escrita concorrente (sessão/mensagem nova desloca o offset, duplica ou pula itens); degrada em páginas profundas |

**Decisão**: `chat_access` como cópia adaptada de `graph_access` (mesmo schema, mesma invariante, mesmas rotas), papéis owner/editor/viewer adaptados à semântica de chat, `ai:chat` como única permission RBAC, paginação keyset com cursor opaco, e quebra deliberada do contrato de `GET /v1/sessions/:id`.

## Gaps conhecidos / Próximos passos

- Sem lookup de usuário por username/email — quem compartilha precisa saber o `user_id` (`sub` do JWT) de antemão, mesmo gap já aceito em [`graph-collaborator-management.md`](../specs/graph-collaborator-management.md).
- Sem notificação ao usuário convidado.
- Exposição via RPC/Service Binding para outros workers continua fora de escopo (ver [chat-sessions-out-of-scope.md](../specs/chat-sessions-out-of-scope.md)).
- Sem endpoint "quem sou eu nesta sessão" isolado — hoje só via `GET /v1/sessions/:id` (campo `role`) ou procurando a si mesmo em `GET .../access`, mesmo gap aceito no grafo.
- Sem streaming em `POST /v1/sessions/:id/messages` — gap herdado da ADR 0019/0008, não afetado por esta mudança.

## Referências

- `docs/specs/chat-sessions-sharing-and-pagination.md` — spec completa desta feature
- `docs/specs/chat-sessions.md` / `docs/specs/chat-sessions-out-of-scope.md` — spec e gaps originais, atualizados por esta ADR
- `docs/specs/graph-collaborator-management.md` — precedente reaproveitado (mesmo modelo de ACL)
- [[0004-d1-multiple-databases|ADR 0004: Múltiplos D1s por domínio]]
- [[0012-graph-worker-knowledge-graph|ADR 0012: Graph Worker — grafo de conhecimento]]
- [[0014-ai-chat-and-auth-stats-permission-enforcement|ADR 0014: Enforcement de permissões no AI Worker e no /stats do Auth Worker]]
- [[0019-ai-worker-chat-sessions|ADR 0019: Sessões de Chat no `ai-worker`]]
