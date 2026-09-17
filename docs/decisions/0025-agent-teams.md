# ADR 0025: Teams de Agents — Orquestração Multi-Agent no `ai-worker`

Adiciona **teams**: um novo recurso que agrupa múltiplos agents e os coordena em 3 modos de orquestração (`pipeline`, `debate`, `orchestrator`) para produzir uma resposta a partir de uma mensagem do usuário numa sessão de chat.

## Contexto

Até aqui, uma sessão de chat referencia no máximo **um** agent (`agent_id`, snapshot congelado na criação, [ADR 0022](0022-agent-registration.md)). Não existia nenhum mecanismo para múltiplos agents colaborarem numa mesma resposta.

A spec completa está em [`docs/specs/agent-teams.md`](../specs/agent-teams.md) (itens deliberadamente fora de escopo em [`docs/specs/agent-teams-out-of-scope.md`](../specs/agent-teams-out-of-scope.md)). Ela cobre o schema, as rotas e as regras de validação de cada modo em detalhe; esta ADR foca nas decisões de arquitetura e nas decisões de implementação que a spec deliberadamente deixou abertas.

## Decisão

### Novo recurso `agent_teams`, no mesmo D1 `dev-agents`

Teams vivem no D1 `dev-agents` (mesmo banco dos agents), não em `dev-chat` nem num D1 dedicado. Diferente do snapshot de agent único da ADR 0022, `team_members.agent_id` é uma **referência viva**: um team sempre executa com a config atual de seus membros. Por isso ganha uma FK real (`agents(id)`, mesmo D1) em vez de colunas de snapshot — algo que só é possível porque `agent_teams`/`team_members` vivem no mesmo banco que `agents`.

### 3 modos de orquestração, escolhidos por team (`orchestration_mode`)

- **`pipeline`**: os membros rodam em sequência (`team_members.order_index`); cada um recebe só a mensagem original do usuário + a saída do agent anterior (não a cadeia completa). O último produz a resposta final.
- **`debate`**: todos os membros veem a mensagem original e a discussão acumulada, falando em ordem a cada rodada. Duas estratégias de parada (`termination_strategy`): `fixed_rounds` (roda exatamente `rounds` rodadas, depois `lead_agent_id` sintetiza a resposta final) e `moderator` (após cada rodada, `lead_agent_id` decide se finaliza ou continua; `rounds` é sempre o teto de segurança, mesmo que o moderador nunca decida parar).
- **`orchestrator`**: `lead_agent_id` decide, passo a passo, qual membro fala a seguir ou se finaliza, via a tool sintética `select_next_agent` (reaproveitando a infraestrutura de function calling da [ADR 0023](0023-agent-tool-calling.md)). `max_orchestrator_steps` (default 10) é o teto de segurança.

Em qualquer modo, quando um membro tem `tools`/`graph_id` configurados (ADR 0023/[0024](0024-agent-graph-tool.md)), seu turno roda o próprio loop de tool calling — orquestração aninhada, com teto independente (`max_tool_iterations` do agent vs. `rounds`/`max_orchestrator_steps` do team).

### Decisão de implementação: cada turno é uma única mensagem `role: user` flattened

Não documentada na spec — decisão tomada durante a implementação. Workers AI exige alternância estrita `user`/`assistant` nas mensagens ([ADR 0009](0009-system-message-normalization-in-cloudflare-workers-ai.md)). Um transcript de orquestração multi-agent (uma fala por membro, sem turnos de usuário intercalados) violaria essa alternância se fosse enviado como uma sequência de mensagens `role: assistant`.

A solução, em `lib/team-orchestration.mjs` e `lib/agent-turn.mjs`: cada turno de cada agent recebe **um único** array de mensagens — o `system_prompt` do agent (se houver) + exatamente uma mensagem `role: user` cujo conteúdo é uma string já "achatada" contendo tudo que aquele turno precisa (mensagem original do usuário, saída do agent anterior no `pipeline`, transcript formatado da discussão no `debate`/`orchestrator`). `buildTurnMessages()` (`agent-turn.mjs`) monta esse array; `formatTranscript()` e os `build*TurnContent()` helpers (`team-orchestration.mjs`) montam a string. Isso nunca quebra a alternância, porque cada chamada ao modelo continua sendo, na prática, uma conversa de no máximo duas mensagens (`system` opcional + `user`) — o próprio loop de tool calling interno de um turno (quando o agent tem `tools`) é o único lugar onde uma sequência `user`/`assistant`/`tool` mais longa é construída, e ele já era compatível com a ADR 0009 antes desta feature.

### Decisão de implementação: protocolo de tags `[FINAL]`/`[CONTINUE]` no `debate` com `termination_strategy: moderator`

Também não documentada na spec, que deixa a cargo do implementador ("use seu julgamento de como sinalizar essa decisão de forma parseável"). A decisão do moderador (parar ou continuar) é sinalizada por um prefixo de texto simples na própria resposta — `[FINAL] <resposta final>` ou `[CONTINUE] <orientação para a próxima rodada>` — em vez de function calling. `parseModeratorDecision()` (`team-orchestration.mjs`) interpreta o prefixo; qualquer coisa que não comece exatamente com `[FINAL]` (incluindo `[CONTINUE]` ou uma resposta que não seguiu o protocolo) é tratada como "continuar" — o teto `rounds` garante que uma discussão adversarial (moderador que nunca decide parar) sempre termina. Mantém a chamada do moderador como um `runAgentTurn()` comum (`chatCompletion()`, sem tools reservadas), reutilizável mesmo que o moderador tenha suas próprias `tools` configuradas.

### Tool sintética `select_next_agent`, com `enum` dinâmico

No modo `orchestrator`, o coordenador (`lead_agent_id`) recebe uma tool que não faz parte do catálogo fixo (`lib/tools.mjs`) — é montada em runtime por `selectNextAgentTool()` (`team-orchestration.mjs`), com `next_agent.enum` preenchido com os `name`s dos membros atuais do team (exceto o próprio coordenador), recalculado a cada chamada. Isso vai além do que a spec descreve textualmente (só "validado contra os names... em runtime"): expor o `enum` de verdade dá ao modelo as opções válidas antecipadamente, não só depois de errar. Ao atingir `max_orchestrator_steps`, uma última chamada é forçada com `finishOnlyTool()`, uma variante da mesma tool só com `action: "finish"` disponível — mesmo padrão de "forçar resposta final" já usado pelo loop de tool calling comum (ADR 0023). Essa chamada do coordenador é feita diretamente via `chatCompletionWithTools()` (não via `runToolCallingLoop()`/`runAgentTurn()`), porque a única tool disponível ali é a de roteamento, independente de quaisquer `tools` de domínio que o próprio coordenador tenha configurado.

### Permission dedicada: `ai:teams`

Separada de `ai:agents`, mesmo raciocínio que já separa `ai:agents` de `ai:chat`: "montar equipes" é uma capacidade administrativa distinta de "cadastrar um agent individual". Exigida em todas as rotas `/v1/teams*`, seedada com a mesma paridade inicial de `ai:agents` (só `profile-admin`, migration `0024_seed_team_permissions.sql`).

### ACL `team_access`: mesmo modelo owner/editor/viewer

Espelha `agent_access`/`chat_access`/`graph_access` — `owner`/`editor`/`viewer`, invariante de ≥1 owner idêntica às demais ACLs do projeto, mesma semântica 404-sem-acesso / 403-papel-insuficiente.

### Sessão com team: referência viva, sem snapshot

`chat_sessions.team_id` (nullable, mutuamente exclusivo com `agent_id` — `400` em `POST /v1/sessions` se ambos forem enviados) é uma referência direta, nunca congelada: editar o team depois (membros, modo de orquestração) afeta a próxima mensagem de qualquer sessão que o referencia. Trade-off deliberado, oposto à filosofia de "congelar para previsibilidade" de `agent_id` — aqui, "o team é sempre a versão atual" se estende até a sessão.

`chat_messages.agent_id` (nullable, sem FK cross-database, mesma razão de todas as demais colunas `agent_*` de `dev-chat`) marca qual membro produziu cada mensagem gerada dentro de uma orquestração — usuário vê só a resposta final; o transcript completo (incluindo os ciclos de tool calling internos de cada membro) fica persistido e reconstruível via `GET /v1/sessions/:id/messages`.

### Streaming: mesmo padrão da ADR 0023 (só a resposta final)

Toda a orquestração roda internamente sem streaming, não importa o modo; só a resposta final, já resolvida, é re-executada com `stream: true` — `runTeamOrchestration()` devolve `messagesForFinalCall`/`aiOptions` (o prompt exato que produziu a resposta final em cada modo, incluindo o caso de finalização antecipada do moderador) para `handleTeamSendMessage()` (`index.mjs`) replay via `streamSendMessageResponse()`, reaproveitando o mesmo caminho já usado pelo tool calling de agent único.

## Implementação

- `terraform/migrations/0023_create_agent_teams.sql` (D1 `dev-agents`): tabelas `agent_teams`, `team_members` (FK real `agents(id)`), `team_access`.
- `terraform/migrations/0024_seed_team_permissions.sql` (D1 `dev-auth`): permission `ai:teams`, atribuída a `profile-admin`.
- `terraform/migrations/0025_add_team_support_to_chat.sql` (D1 `dev-chat`): `chat_sessions.team_id`, `chat_messages.agent_id` (ambas nullable, sem FK).
- `terraform/environments/dev/terraform.tfvars`: as 3 migrations acima adicionadas às listas de `auth`/`chat`/`agents`. Nenhum novo Service Binding — teams reaproveitam os bindings já existentes do `ai-worker` (`AGENTS_DB`, `CHAT_DB`, `AI`, e os Service Bindings `RAG_WORKER`/`GRAPH_WORKER` já usados pelas tools de agent individual).
- `terraform/workers/ai/src/lib/team-db.mjs` (novo): CRUD + ACL de `agent_teams`/`team_members`/`team_access`, mesmo padrão de `agent-db.mjs` (`ROLE_RANK`, `requireRole()`, paginação keyset). Validação por modo (`validateTeamFields()`): `pipeline` rejeita `lead_agent_id`/`rounds`/`termination_strategy`/`max_orchestrator_steps`; `debate` exige `lead_agent_id`+`rounds`+`termination_strategy`; `orchestrator` exige `lead_agent_id` (+ `max_orchestrator_steps`, default 10). `lead_agent_id` sempre precisa estar em `members`.
- `terraform/workers/ai/src/lib/agent-turn.mjs` (novo): `runAgentTurn()` — "um agent fala" extraído de `runToolCallingLoop()` (que morava em `index.mjs`, agora também aqui), reusável tanto pelo caminho de agent único quanto por qualquer modo de team. `buildTurnMessages()` monta o array de mensagens de um turno (system opcional + uma mensagem `user`).
- `terraform/workers/ai/src/lib/team-orchestration.mjs` (novo): `runPipeline()`, `runDebate()`, `runOrchestrator()` e o entry point `runTeamOrchestration()`, despachado por `orchestration_mode`. Toda leitura de team/agent é fresca (nunca cacheada), refletindo a "referência viva".
- `terraform/workers/ai/src/lib/chat-db.mjs`: `chat_sessions.team_id` (`createSession()`/`getSessionById()`/`listSessionsForUser()`/`mapSessionRow()`) e `chat_messages.agent_id` (`addMessage()`/`mapMessageRow()`/`listMessagesPage()`/`listRecentMessages()`), ambos opcionais e retrocompatíveis (`null` para todo call site anterior a esta feature).
- `terraform/workers/ai/src/index.mjs`: rotas `/v1/teams*` (mesmo padrão HTTP de `/v1/agents*`); `handleCreateSession()` valida `agent_id`/`team_id` mutuamente exclusivos e resolve `team_id` via `requireTeamRole(..., "viewer")` (404 se inexistente/sem acesso, sem snapshot); `handleSendMessage()` verifica `session.team_id` e, se presente, delega para `handleTeamSendMessage()` em vez do caminho de agent único/sem agent.
- Testes em `tests/ai-worker.test.mjs`: cobrem os 3 modos, validação por modo, mutualidade `agent_id`/`team_id`, persistência de `agent_id` em `chat_messages`, ACL de team, streaming da resposta final.

## Trade-offs

| Abordagem | Vantagens | Desvantagens |
|---|---|---|
| **`team_members.agent_id` como FK real (mesmo D1, escolhida)** | Nunca aponta para um agent inexistente; consistente com a natureza "viva" do recurso | Acopla `agent_teams` ao mesmo D1 dos agents — impede um D1 dedicado a teams no futuro sem reintroduzir referência cross-database |
| `team_members.agent_id` como referência lógica cross-database (como `chat_sessions.agent_id`) | Isolamento de domínio consistente com o resto do projeto (D1 por domínio, ADR 0004) | Sem FK real, um team poderia referenciar um agent apagado; exigiria checagem de existência em toda leitura |
| **Turno flattened em uma única mensagem `role: user` (escolhida)** | Nunca viola a alternância estrita da ADR 0009; reusa `chatCompletion()`/`runAgentTurn()` sem mudança nenhuma no contrato com Workers AI | Perde a estrutura nativa de "conversa" — o modelo recebe uma string pré-formatada, não uma sequência de mensagens distintas por falante |
| Multi-mensagem por falante (uma `role: assistant` por membro) | Estrutura mais "natural"/nativa | Violaria a alternância exigida pela Workers AI (ADR 0009) sem transformação adicional |
| **Protocolo de tags `[FINAL]`/`[CONTINUE]` para o moderador (escolhida)** | Mantém a chamada do moderador como um `runAgentTurn()` comum, sem reservar a tool `select_next_agent` para um caso que a spec não pede function calling | Depende do modelo seguir o protocolo textual; um modelo que ignora o prefixo é tratado como "continuar" (mitigado pelo teto `rounds`) |
| Function calling também para a decisão do moderador | Sinal estruturado, sem depender de parsing de texto | Reservaria uma tool para um modelo que talvez não tenha suporte a `tools`, ou entraria em conflito com as `tools` de domínio do próprio moderador |
| **`select_next_agent` com `enum` dinâmico dos nomes dos membros (escolhida)** | Dá ao modelo as opções válidas de antemão, reduzindo a chance de nome inválido | Nomes de membros duplicados ou alterados entre chamadas (edição do team em runtime) tornam o enum uma foto do instante da chamada, não uma garantia permanente |
| `next_agent` livre, só validado depois da chamada (como a spec descreve textualmente) | Schema da tool mais simples | Deixa a validação inteiramente reativa — o coordenador só descobre o erro depois de tentar |

## Gaps conhecidos

Detalhados em [`docs/specs/agent-teams-out-of-scope.md`](../specs/agent-teams-out-of-scope.md):

- **Teams aninhados**: um team não pode ter outro team como membro (`team_members.agent_id` só referencia `agents.id`) — evita ciclos e complexidade de composição recursiva sem caso de uso concreto ainda.
- **Streaming dos turnos intermediários**: mesmo raciocínio da ADR 0023 — só a resposta final é streamada; turnos individuais (incluindo os do coordenador/moderador) são invisíveis ao client durante a execução.
- **Tools no nível do team**: não existe "tool disponível ao team inteiro" — só as `tools` já configuradas por agent (ADR 0023/0024) se aplicam durante o turno daquele agent.
- **Orçamento agregado de custo/token por execução**: os tetos (`rounds`, `max_orchestrator_steps`, `max_tool_iterations` de cada agent) limitam cada dimensão isoladamente, sem visibilidade agregada de custo antes de uma execução potencialmente cara (`debate` com muitas rodadas × muitos membros × loops de tool calling internos).
- **Detecção de "sem progresso" além dos tetos numéricos**: nem `orchestrator` nem `debate` com `moderator` detectam padrões degenerados (ex.: coordenador alternando entre os mesmos dois agents) além do teto simples.
- **Edição de membros durante uma execução em andamento**: sem lock/trava — como a sessão sempre lê a config atual do team, uma edição no meio de uma execução pode, na pior hipótese, misturar comportamento antigo e novo dentro da mesma resposta.

## Referências

- `docs/specs/agent-teams.md` — spec completa desta feature
- `docs/specs/agent-teams-out-of-scope.md` — itens deliberadamente fora de escopo
- [ADR 0009: System message normalization (Cloudflare Workers AI)](0009-system-message-normalization-in-cloudflare-workers-ai.md)
- [ADR 0015: Service Bindings + RPC (WorkerEntrypoint)](0015-service-bindings-rpc-worker-communication.md)
- [ADR 0019: Sessões de Chat no `ai-worker`](0019-ai-worker-chat-sessions.md)
- [ADR 0020: Compartilhamento, paginação e renomear de sessões de chat](0020-chat-session-sharing-and-pagination.md)
- [ADR 0021: Streaming (SSE) para chat completions e sessões de chat](0021-chat-streaming.md)
- [ADR 0022: Cadastro de Agents no `ai-worker`](0022-agent-registration.md)
- [ADR 0023: Tool Calling para Agents no `ai-worker`](0023-agent-tool-calling.md)
- [ADR 0024: Tool `find_node` (Grafo) para Agents](0024-agent-graph-tool.md)
