# Spec: Teams de Agents (Orquestração Multi-Agent)

Gerado via interview (`/grilling`). Complementa [agent-registration.md](agent-registration.md) e [agent-tool-calling.md](agent-tool-calling.md).

## Contexto

Hoje uma sessão de chat referencia no máximo **um** agent (`agent_id`, snapshot congelado na criação — ADR 0022). Esta spec introduz **teams**: um novo recurso que agrupa múltiplos agents e os faz colaborar em 3 modos de orquestração diferentes para produzir uma resposta a partir da mensagem do usuário.

## Decisão

### Novo recurso: `agent_teams`, mesmo D1 dos agents

Teams vivem no D1 `dev-agents` (mesmo banco dos agents, não um D1 dedicado) — diferente da separação `dev-chat`/`dev-agents` da ADR 0022, aqui a relação `team_members.agent_id` é uma **referência viva** (não um snapshot: um team sempre executa com a config atual de seus membros), então ganha FK real `ON DELETE CASCADE`/`RESTRICT` dentro do mesmo D1, evitando um team apontar pra um `agent_id` que não existe mais.

### 3 modos de orquestração, escolhidos por team

Um team declara `orchestration_mode` (`pipeline` | `debate` | `orchestrator`) na criação. Os 3 modos coexistem — não é uma evolução de um pro outro, são estratégias diferentes que o usuário escolhe conforme o caso de uso.

#### `pipeline`: cadeia sequencial

Os membros do team rodam na ordem de `team_members.order_index`. Cada agent recebe **só a saída do agent anterior** (mais a mensagem original do usuário como contexto fixo) — não a cadeia completa. O último agent da cadeia produz a resposta final ao usuário.

#### `debate`: todos veem a conversa, N rodadas

Todos os membros veem a mensagem original do usuário e a conversa entre si, falando em rodadas (ordem de `order_index` dentro de cada rodada). Dois critérios de parada, escolhidos por team via `termination_strategy`:

- **`fixed_rounds`**: roda exatamente `rounds` rodadas completas (todos os membros falam em cada rodada); depois, o membro designado em `agent_teams.lead_agent_id` (o "sintetizador") recebe a discussão completa e produz a resposta final.
- **`moderator`**: depois de cada rodada completa, o membro em `lead_agent_id` (o "moderador") é consultado — decide se a discussão já é suficiente; se sim, ele mesmo sintetiza a resposta final naquela mesma chamada; se não, mais uma rodada acontece. Sempre com o teto `rounds` como limite máximo de segurança (independente da decisão do moderador), pra nunca rodar indefinidamente.

#### `orchestrator`: coordenador dirige quem fala

O membro em `lead_agent_id` (o "coordenador") decide, a cada passo, qual dos outros membros do team fala a seguir — ou que já é hora de finalizar. Implementado reaproveitando a infraestrutura de function calling da ADR 0023: o coordenador recebe uma tool sintética `select_next_agent` (não parte do catálogo fixo de `lib/tools.mjs`, montada dinamicamente por execução):

```json
{
  "type": "function",
  "function": {
    "name": "select_next_agent",
    "description": "Escolhe qual agent do team fala a seguir, ou finaliza a conversa com uma resposta.",
    "parameters": {
      "type": "object",
      "properties": {
        "action": { "type": "string", "enum": ["speak", "finish"] },
        "next_agent": { "type": "string", "description": "Nome do agent que deve falar (obrigatório quando action=speak)." },
        "final_answer": { "type": "string", "description": "Resposta final ao usuário (obrigatório quando action=finish)." }
      },
      "required": ["action"]
    }
  }
}
```

`next_agent` é validado contra os `name`s dos membros atuais do team a cada chamada (lista montada em runtime, não fixa). Exige que o coordenador use um modelo com suporte a `tools` (hoje só `@cf/meta/llama-3.1-8b-instruct`, mesma restrição da ADR 0023). Teto de segurança: `max_orchestrator_steps` (campo no team, default 10) — atingido sem `action: "finish"`, força uma última chamada só com `action: "finish"` disponível (mesmo padrão de "força resposta final" já usado no loop de tool calling comum).

### Agents mantêm suas próprias `tools` durante o turno

Quando um membro do team fala (em qualquer um dos 3 modos), se ele tem `tools`/`graph_id` configurados (ADR 0023/0024), o turno dele roda o loop de tool calling normal — orquestração aninhada: o loop de team pode conter, dentro de cada turno individual, um loop de tool calling completo. Cada nível tem seu próprio teto (`max_tool_iterations` do agent para o loop interno, `rounds`/`max_orchestrator_steps` do team para o loop externo).

### Usuário vê só a resposta final; transcript completo fica persistido

`POST /v1/sessions/:id/messages` numa sessão com team devolve só a resposta final sintetizada (o mesmo formato `{ session_id, message: { role: assistant, content }, usage }` de sempre). A conversa inter-agent inteira (cada fala de cada membro, incluindo os ciclos de tool calling internos de cada um) é persistida em `chat_messages` — nova coluna nullable `agent_id` (migration própria, ver Schema) marca **quem disse o quê**, permitindo reconstruir a conversa completa via `GET /v1/sessions/:id/messages` para quem quiser auditar/debugar.

### Permission dedicada: `ai:teams`

Separada de `ai:agents` (mesma lógica já usada pra separar `ai:agents` de `ai:chat`, ADR 0022) — "montar equipes de agents" é uma capacidade administrativa distinta de "cadastrar um agent individual". Exigida em todas as rotas `/v1/teams*`.

### ACL: mesmo modelo owner/editor/viewer

`team_access` espelha `agent_access`/`chat_access`/`graph_access`: papéis `owner` (gerencia tudo, apaga), `editor` (edita membros/config), `viewer` (só lê — e pode referenciar o team ao criar uma sessão, mesma semântica de "usar é leitura" já usada pra agents). Invariante de ≥1 owner idêntica às demais ACLs do projeto.

### Sessão com team: referência viva, não snapshot

`chat_sessions.team_id` (nullable, **mutuamente exclusivo** com `agent_id` — `400` se ambos forem passados em `POST /v1/sessions`) é uma referência direta ao team, sem congelar nada: se o team for editado depois (membros trocados, modo de orquestração alterado), a próxima mensagem na sessão já usa a config nova. Diferente do agent único (que congela deliberadamente para previsibilidade), aqui a filosofia já estabelecida na Q10 da entrevista ("team é sempre a versão atual") se estende à ponta da sessão — evita a inconsistência de "o team em si é sempre atual, mas a sessão trava numa versão antiga dele".

**Consequência aceita**: diferente de uma sessão com agent único, uma conversa em andamento com um team pode, sim, mudar de comportamento no meio se alguém com acesso editar o team — trade-off deliberado, consistente com a natureza "viva" do recurso team.

### Rotas novas

```
POST   /v1/teams                        Cria team (name, orchestration_mode, members[], lead_agent_id, rounds/termination_strategy/max_orchestrator_steps conforme o modo)
GET    /v1/teams?limit=&cursor=         Lista teams com acesso, paginado (mesmo padrão keyset de /v1/agents)
GET    /v1/teams/:id                    Detalhe (papel mínimo viewer)
PATCH  /v1/teams/:id                    Edita campos, incluindo substituir members[] inteiro (papel editor/owner)
DELETE /v1/teams/:id                    Apaga o team (papel owner) -- não apaga os agents membros
PUT    /v1/teams/:id/access/:userId     Concede/atualiza papel (owner)
DELETE /v1/teams/:id/access/:userId     Revoga acesso, ou auto-remoção (owner sobre outros; qualquer papel sobre si mesmo)
GET    /v1/teams/:id/access             Lista colaboradores (qualquer papel)
```

**Sem endpoints de membro individual** (`PUT/DELETE /v1/teams/:id/members/:agentId`) -- `PATCH /v1/teams/:id` substitui a lista `members` inteira de uma vez, mesmo padrão de "campos opcionais, o que for enviado é atualizado" já usado em `AgentUpdateInput`, evitando multiplicar rotas para um caso de uso que não precisa de granularidade por membro.

### Schema

**`agent_teams`** (D1 `dev-agents`):

| Campo | Tipo | Notas |
|---|---|---|
| `id` | TEXT (PK) | UUID |
| `name` | TEXT NOT NULL | |
| `orchestration_mode` | TEXT NOT NULL | `CHECK (orchestration_mode IN ('pipeline', 'debate', 'orchestrator'))` |
| `lead_agent_id` | TEXT | FK `agents(id)`, nullable -- obrigatório (validado em app) para `debate` e `orchestrator`, ignorado em `pipeline` |
| `rounds` | INTEGER | Nullable -- obrigatório para `debate` (ambas estratégias: teto máximo mesmo com `moderator`) |
| `termination_strategy` | TEXT | Nullable -- `CHECK (termination_strategy IN ('fixed_rounds', 'moderator'))`, só relevante em `debate` |
| `max_orchestrator_steps` | INTEGER | Nullable, default 10 quando `orchestration_mode = 'orchestrator'` |
| `created_at` / `updated_at` | DATETIME | Default `CURRENT_TIMESTAMP` |

**`team_members`**:

| Campo | Tipo | Notas |
|---|---|---|
| `id` | TEXT (PK) | UUID |
| `team_id` | TEXT | FK `agent_teams(id)` `ON DELETE CASCADE` |
| `agent_id` | TEXT | FK `agents(id)` -- referência viva, real, no mesmo D1 |
| `order_index` | INTEGER NOT NULL | Ordem no `pipeline`/rodadas do `debate`; ignorado (mas preenchido) em `orchestrator` |

`UNIQUE(team_id, agent_id)` -- um agent não pode ser membro duplicado do mesmo team.

**`team_access`** (mesmo shape de `agent_access`): `id`, `team_id` FK `ON DELETE CASCADE`, `user_id`, `role` `CHECK (role IN ('owner', 'editor', 'viewer'))`, `UNIQUE(team_id, user_id)`.

**`chat_sessions`** ganha `team_id TEXT` (nullable). Sem FK: `dev-chat` e `dev-agents` continuam sendo D1s separados, mesma limitação cross-database já aceita para `chat_sessions.agent_id` desde a ADR 0022. É só `team_members.agent_id` (dentro do próprio `dev-agents`) que ganha FK real, conforme decidido na Q10.

**`chat_messages`** ganha `agent_id TEXT` (nullable, sem FK -- cross-database, mesma razão) -- marca qual agent produziu aquela mensagem quando ela vem de dentro de uma orquestração de team; `null` para mensagens de sessão com agent único ou sem agent.

### Migrations

- `0023_create_agent_teams.sql` (D1 `dev-agents`): `agent_teams`, `team_members`, `team_access`.
- `0024_seed_team_permissions.sql` (D1 `dev-auth`): permission `ai:teams`, mesma paridade inicial (`profile-admin`) usada em `0017_seed_agent_permissions.sql`.
- `0025_add_team_support_to_chat.sql` (D1 `dev-chat`): `chat_sessions.team_id`, `chat_messages.agent_id`.

## Decisões de baixo nível (sem necessidade de validação)

- **Validação de criação/edição de team**: `orchestration_mode = 'pipeline'` não exige `lead_agent_id`/`rounds`/`termination_strategy`/`max_orchestrator_steps` (rejeitados com `400` se enviados); `'debate'` exige `lead_agent_id` + `rounds` + `termination_strategy`; `'orchestrator'` exige `lead_agent_id` (mais `max_orchestrator_steps`, default 10 se omitido).
- **`lead_agent_id` precisa estar em `team_members`**: validado na criação/edição -- um team não pode ter um líder que não é membro dele. Remover da lista `members` um agent que é `lead_agent_id` atual é rejeitado com `400` (precisa trocar o `lead_agent_id` primeiro, no mesmo `PATCH`).
- **Falha real de modelo (não de tool) durante a orquestração** (ex.: `ai.run()` lança exceção, binding ausente) aborta a execução inteira com erro ao usuário -- diferente de erro de tool (que vira resultado e o loop continua), uma falha de infraestrutura no meio de uma orquestração de team não tem como ser recuperada de forma sensata.
- **Streaming**: mesmo padrão já estabelecido na ADR 0023 -- toda a orquestração (não importa o modo) roda de forma não-streaming internamente; só a resposta final, já resolvida, é re-executada com `stream: true` quando pedido.
- **`GET /v1/sessions/:id/messages` numa sessão com team**: mensagens internas da orquestração (com `agent_id` preenchido) aparecem no histórico como qualquer mensagem `role: assistant`/`role: tool`, na ordem em que foram geradas -- cliente que quiser reconstruir "quem disse o quê" usa o campo `agent_id`.

## Casos a verificar

- `POST /v1/sessions` com `agent_id` e `team_id` ao mesmo tempo retorna `400`.
- Cada modo respeita seu teto de segurança sem nunca rodar indefinidamente, mesmo em casos adversariais (ex.: coordenador sempre escolhe `action: "speak"`, moderador nunca decide parar).
- Editar um team (trocar membros, mudar `orchestration_mode`) afeta a próxima mensagem de uma sessão já existente que o referencia -- comportamento esperado (Q11), não um bug.
- Turno de um membro com `tools` habilitadas roda o loop de tool calling normalmente dentro da orquestração maior, sem misturar o teto de iterações de tool calling com o teto de rodadas/passos do team.
- `chat_messages.agent_id` correto para cada mensagem gerada durante uma orquestração, permitindo reconstruir a conversa completa.
- Remover o `lead_agent_id` atual de `team_members` sem trocar o campo é rejeitado com `400`.
- ACL (`team_access`) e permission (`ai:teams`) checadas independentemente, mesma semântica 404-sem-acesso / 403-papel-insuficiente já usada em agents/sessions.

## Fora de escopo

Ver [agent-teams-out-of-scope.md](agent-teams-out-of-scope.md).
