# Spec: Sessões de Chat

## Contexto

Hoje `POST /v1/chat/completions` (`ai-worker`) é totalmente stateless: o client reenvia o array `messages` inteiro a cada request, nada é persistido no servidor. Não existe em nenhum lugar do repo (código, migration ou tfvars) qualquer noção de "sessão", "conversa" ou "histórico" — busca por `session|conversation|chat.?history` não retorna nenhum resultado.

`ai-worker` já enforce JWT (`requirePermission(request, env, "ai:chat")`), com o payload contendo `sub`, `username`, `permissions` (array), minerado pelo `auth-worker`. O `graph-worker` já resolve um problema parecido de propriedade de dado por usuário via a tabela `graph_access` (owner/editor/viewer), mas esse nível de compartilhamento não é necessário aqui (ver Decisões).

## Fora de escopo

Ver [spec de fora-de-escopo](chat-sessions-out-of-scope.md) para a lista original de itens adiados. **Atualização**: compartilhamento, paginação e renomear manualmente foram implementados depois — ver [chat-sessions-sharing-and-pagination.md](chat-sessions-sharing-and-pagination.md), que também substitui as decisões de dono único, "sem paginação" e "título só auto-gerado" descritas abaixo. Só streaming e RPC entre workers continuam fora de escopo.

## Arquitetura

### Worker

Toda a feature vive dentro do **`ai-worker`** existente — não há worker novo. Sessão de chat é conceitualmente parte do mesmo domínio de "conversas com IA" que o worker já possui; um worker dedicado só faria sentido se outro worker precisasse consumir sessão via RPC, o que não é o caso (ver Fora de escopo).

### Banco de dados

Novo D1 dedicado **`dev-chat`**, seguindo o padrão de "múltiplos D1 por domínio" (ADR 0004) — um domínio (sessões de chat) não deve se misturar com `dev-auth` (identidade/autorização).

Bindado só no `ai-worker`, seguindo o mesmo padrão de `graph-worker`↔`GRAPH_DB` em `terraform/environments/dev/terraform.tfvars`:

```hcl
ai = {
  bindings = [
    { name = "AI", type = "ai" },
    { name = "CHAT_DB", type = "d1", resource_key = "chat" },
  ]
}
```

E em `d1_databases`:

```hcl
chat = {
  name                 = "dev-chat"
  primary_location_hint = "..."
  run_migrations        = true
  migrations            = ["migrations/0014_create_chat_sessions.sql"]
}
```

### Schema

Tabela `chat_sessions`:

| Campo | Tipo | Notas |
|---|---|---|
| `id` | TEXT (PK) | Gerado pelo servidor (UUID) na criação. |
| `user_id` | TEXT | `sub` do JWT do dono; toda operação valida `user_id == sub` do token da request. |
| `title` | TEXT | Nulo na criação; auto-preenchido com o início da primeira mensagem do usuário (ver Decisões). |
| `created_at` | DATETIME | Default `CURRENT_TIMESTAMP`. |
| `updated_at` | DATETIME | Atualizado a cada mensagem nova (para ordenar `GET /v1/sessions` por atividade recente). |

Tabela `chat_messages`:

| Campo | Tipo | Notas |
|---|---|---|
| `id` | TEXT (PK) | UUID gerado pelo servidor. |
| `session_id` | TEXT | FK para `chat_sessions.id`, `ON DELETE CASCADE`. |
| `role` | TEXT | `"user"` ou `"assistant"`. |
| `content` | TEXT | Conteúdo da mensagem. |
| `created_at` | DATETIME | Default `CURRENT_TIMESTAMP`; ordena o histórico. |

Índices: `idx_chat_sessions_user_id`, `idx_chat_messages_session_id`.

## Endpoints (`ai-worker`)

Todos exigem a permission `ai:chat` já existente (nenhuma permission nova é criada — ver Decisões) e derivam `user_id`/dono do `sub` do JWT.

| Método | Rota | Descrição | Permission |
|---|---|---|---|
| POST | `/v1/sessions` | Cria sessão vazia, retorna `{ id, title: null, created_at }`. | `ai:chat` |
| GET | `/v1/sessions` | Lista sessões do usuário autenticado (`user_id == sub`), ordenadas por `updated_at` desc. Sem paginação (gap conhecido, ver Fora de escopo). | `ai:chat` |
| GET | `/v1/sessions/:id` | Retorna a sessão + histórico completo de mensagens (`chat_messages` ordenado por `created_at`). 404 se não existir ou não pertencer ao `sub`. | `ai:chat` |
| POST | `/v1/sessions/:id/messages` | Envia mensagem nova (ver contrato abaixo). 404 se a sessão não existir ou não pertencer ao `sub`. | `ai:chat` |
| DELETE | `/v1/sessions/:id` | Apaga a sessão e suas mensagens (cascade). 404 se não existir ou não pertencer ao `sub`. | `ai:chat` |

`/v1/chat/completions` **permanece inalterado** — nenhum campo novo, nenhuma branch condicional. Sessões são um caminho totalmente separado.

### Contrato de `POST /v1/sessions/:id/messages`

Request:
```json
{ "content": "texto da mensagem do usuário", "model": "@cf/mistral/mistral-7b-instruct-v0.1" }
```
`model` é opcional, mesmo default já usado hoje em `chatCompletion` (`lib/ai.mjs`) se omitido.

Fluxo:
1. Valida que a sessão existe e pertence ao `sub` do JWT.
2. Persiste a mensagem do usuário (`role: "user"`) em `chat_messages`.
3. Monta o contexto: últimas 20 mensagens da sessão (ver Decisões — janela de contexto), já incluindo a mensagem recém-persistida.
4. Chama `ai.run(model, { messages })` (mesmo caminho interno já usado por `/v1/chat/completions`).
5. Persiste a resposta do assistente (`role: "assistant"`) em `chat_messages`.
6. Atualiza `chat_sessions.updated_at`; se `title` ainda for nulo, preenche com os primeiros ~50 caracteres do `content` da mensagem do usuário.
7. Retorna:
```json
{
  "session_id": "...",
  "message": { "role": "assistant", "content": "..." },
  "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 }
}
```
Formato inspirado em `choices[0].message` do `/v1/chat/completions`, mas simplificado (sem `choices` array, já que não há `n>1` aqui).

## Decisões de baixo nível (sem necessidade de validação)

- **Hard delete**: `DELETE /v1/sessions/:id` remove de fato (cascade em `chat_messages`), sem soft-delete — mesmo padrão de `ingredients`.
- **Título auto-gerado**: nenhum endpoint dedicado para renomear (fora de escopo); truncamento simples da primeira mensagem do usuário, sem chamada extra à IA para resumir.
- **Janela de contexto = 20 mensagens**: histórico completo sempre persistido no D1 (nada é descartado), mas só as últimas 20 mensagens da sessão (10 trocas) são enviadas como `messages` pro `AI.run()`, evitando estourar limite de contexto do modelo em sessões longas. Número escolhido arbitrariamente como ponto de partida razoável; pode ser ajustado depois sem migration (é lógica de query, não schema).
- **Sem novas permissions RBAC**: reaproveita `ai:chat` — sessão é sempre operação do próprio dono sobre os próprios dados (não há ação administrativa de terceiro sobre sessão alheia que justifique granularidade extra).
- **Numeração de migration**: próxima livre é `0014_create_chat_sessions.sql` (`terraform/migrations/`, último hoje é `0013_add_graphrag_permission.sql`).

## Casos a verificar depois de implementado

- `POST /v1/sessions` sem sessão prévia → retorna `id` novo, `title: null`.
- `POST /v1/sessions/:id/messages` numa sessão de outro usuário → 404 (não 403, para não vazar existência da sessão).
- Primeira mensagem de uma sessão → `title` passa de `null` para o texto truncado.
- Sessão com mais de 20 mensagens → contexto enviado ao modelo é só a janela das últimas 20, mas `GET /v1/sessions/:id` retorna o histórico completo.
- `DELETE /v1/sessions/:id` → `chat_messages` da sessão somem junto (cascade).
- `GET /v1/sessions` → ordenado por `updated_at` desc (sessão com mensagem mais recente aparece primeiro).

## Gaps conhecidos / próximos passos

- Sem paginação em `GET /v1/sessions` nem no histórico de `GET /v1/sessions/:id` — mesmo gap já aceito em `GET /ingredients`.
- Janela de contexto fixa em 20 mensagens não é configurável por request; se necessário no futuro, adicionar um parâmetro é uma mudança pequena e isolada.
- Ver [chat-sessions-out-of-scope.md](chat-sessions-out-of-scope.md) para itens deliberadamente adiados.
