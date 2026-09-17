# Spec: Teams de Agents — Itens fora de escopo

Complementa [agent-teams.md](agent-teams.md). Lista o que foi deliberadamente adiado, e por quê.

## Teams aninhados (um team como membro de outro team)

`team_members.agent_id` referencia só `agents.id` -- um team não pode ter outro team como membro.

**Por quê**: abriria a possibilidade de ciclos (team A contém team B que contém team A) e complicaria a montagem de contexto/orquestração recursivamente, sem um caso de uso concreto que justifique a complexidade agora.

**Quando revisitar**: se surgir demanda real por composição de teams (ex.: um team "pipeline de conteúdo" usando um team "debate de revisão" como um de seus estágios).

## Streaming dos turnos intermediários da orquestração

Igual à decisão já tomada pra tool calling (ADR 0023): só a resposta final, já resolvida pela orquestração inteira, é streamada. Turnos individuais de cada agent (incluindo os próprios ciclos de tool calling deles) ficam invisíveis ao client durante a execução.

**Por quê**: mesmo raciocínio -- exigiria um vocabulário de evento SSE novo (algo como "agent X está falando...", "coordenador escolheu agent Y..."), sem consumidor real hoje.

**Quando revisitar**: se o produto quiser mostrar progresso em tempo real de uma orquestração longa (ex.: um `debate` de várias rodadas pode demorar), o mesmo formato de evento serviria tanto pra isso quanto pro gap equivalente já registrado na ADR 0023.

## Tools no nível do team (só no nível do agent)

Não existe um conceito de "tool disponível pro team inteiro" -- só as `tools` já configuradas individualmente em cada agent membro (ADR 0023/0024) se aplicam, durante o turno daquele agent especificamente.

**Por quê**: manter tools escopadas ao agent (não ao team) evita uma segunda camada de configuração redundante; um agent que precisa de uma tool específica dentro de um team já pode ter isso configurado nele mesmo.

**Quando revisitar**: se surgir um caso de uso de "tool que só faz sentido no contexto de um team específico, não do agent isoladamente" (pouco provável dado o design atual).

## Orçamento de custo/token agregado por execução

Os tetos existentes (`rounds`, `max_orchestrator_steps`, `max_tool_iterations` de cada agent) limitam cada dimensão isoladamente, mas não existe um limite agregado de tokens/custo total por execução de uma mensagem numa sessão com team.

**Por quê**: um team com `debate` + `rounds: 10` + 5 membros, cada um potencialmente rodando um loop de tool calling de até 5 iterações, pode gerar dezenas de chamadas ao modelo numa única mensagem do usuário -- sem visibilidade agregada de custo antes de acontecer. Resolver isso exigiria uma spec própria de rate limiting/orçamento, fora do escopo de "fazer a orquestração funcionar corretamente" desta spec.

**Quando revisitar**: se o custo de execuções de team em produção se mostrar um problema real (não hipotético).

## Detecção de "sem progresso" além dos tetos numéricos

No modo `orchestrator`, não há detecção de padrões degenerados (ex.: coordenador alternando entre os dois mesmos agents sem produzir uma resposta final) além do teto simples `max_orchestrator_steps`. No modo `debate` com `termination_strategy: moderator`, não há proteção contra o moderador nunca decidir parar além do teto `rounds`.

**Por quê**: detecção de "sem progresso" é heurística e adicionaria complexidade significativa (o que conta como "progresso"?) sem um caso real que mostre que o teto numérico simples é insuficiente.

**Quando revisitar**: se em produção surgirem casos onde o teto numérico é atingido com frequência sem uma resposta útil, valeria investigar heurísticas de parada antecipada.

## Edição de membros durante uma execução em andamento

Não há nenhuma trava/lock que impeça editar um team (`PATCH /v1/teams/:id`) enquanto uma mensagem está sendo processada numa sessão que o referencia. Como a spec principal já decidiu que a sessão sempre lê a config atual do team (Q11), uma edição no meio de uma execução em andamento pode, na pior hipótese, misturar comportamento antigo e novo dentro da mesma resposta (dependendo de em que ponto exato a leitura acontece).

**Por quê**: um mecanismo de lock/transação adicionaria complexidade operacional (D1 não tem transações distribuídas cross-request triviais) para uma janela de corrida muito estreita e de baixo impacto prático.

**Quando revisitar**: se esse cenário de corrida se mostrar um problema real observado, não hipotético.
