# Spec: Exposição de Agents via RPC — Decisão de Não Implementar Agora

Formaliza a decisão de **não desenhar nem implementar** a exposição de operações de agent (`agents`/`agent_access`) via RPC (Service Binding) para outros workers, apesar de esse item aparecer registrado como gap em [`agent-registration-out-of-scope.md`](agent-registration-out-of-scope.md). Mesmo raciocínio já aplicado à decisão análoga para sessões de chat.

## Contexto

`ai-worker` já expõe um RPC `chat()` (`WorkerEntrypoint`, `terraform/workers/ai/src/index.mjs`), consumido hoje por `graphrag-worker` e `rag-worker` via Service Binding — mas ele continua totalmente stateless e anônimo (sem `actorSub`, sem noção de agent nem de sessão). Esse método **não muda** com esta decisão.

`agents`/`agent_access` (ADR 0022) só são acessíveis hoje via HTTP (`/v1/agents*`), autenticado por JWT + permission `ai:agents` + papel em `agent_access`. Nenhum outro worker pode criar, ler ou usar um agent via RPC.

## Decisão

**Não implementar.** Verificado novamente: nenhum worker do repositório tem hoje um caso de uso concreto para isso. `graphrag-worker` — o candidato mais óbvio, já que orquestra `rag`+`graph`+`ai` via RPC — **continua sem expor nenhum RPC próprio** (`terraform/workers/graphrag/src/index.mjs` é puramente `fetch`-based, não é um `WorkerEntrypoint` consumido por ninguém; confirmado via grep, sem match de `class ... extends WorkerEntrypoint` no arquivo). Não existe, portanto, nem o lado consumidor pronto para justificar desenhar o lado provedor — mesma situação exata que levou à decisão de não expor sessões de chat via RPC.

Desenhar um contrato de RPC agora (quais métodos, qual granularidade, se o snapshot seria copiado ou o `agent_id` bruto passado) seria apostar em requisitos futuros desconhecidos — YAGNI, mesmo raciocínio já usado nas ADRs 0020/0022 para rejeitar recursos sem caso de uso real.

## Esboço de design para quando houver um consumidor real (referência, não implementado)

Registrado só para acelerar o design quando/se este gap for revisitado — **não é uma spec de implementação**, os detalhes exatos dependerão do consumidor real:

- Seguiria o padrão já validado do `graph-worker` e reaproveitado por `agent-db.mjs` (ADR 0022): métodos RPC recebendo um `actorSub` explícito como parâmetro (sem JWT no caminho RPC — a fronteira de confiança é "só alcançável via Service Binding", mesma razão da ADR 0015), cada método chamando `requireRole()` de `agent-db.mjs` internamente para checar o papel do `actorSub` em `agent_access` — reaproveitando a mesma função usada pelo caminho HTTP hoje.
- Um "service account" fixo (`actorSub` tipo `svc-graphrag-agents`, mesmo padrão de `svc-api-ingredients`/`svc-rag-enrichment`/`svc-graphrag-chat` documentado na ADR 0016 e no esboço análogo para sessões) precisaria ganhar uma linha `owner`/`editor`/`viewer` em `agent_access` para o agent relevante — inserida manualmente via `wrangler d1 execute`, não automatizada, mesmo processo do `chat_access`/`graph_access`.
- Provavelmente exporia só leitura (ex.: um método tipo `getAgentConfig(agentId, actorSub)` retornando os campos já usados no snapshot), não o CRUD completo de `/v1/agents*` — um consumidor via RPC tipicamente quer resolver a config de um agent pra usar, não gerenciar agents.
- `terraform/environments/dev/terraform.tfvars`: o worker consumidor (ex.: `graphrag`) reaproveitaria o binding `AI_WORKER` → `ai` já existente hoje para `chat()` — não precisaria de um binding novo.

## Gatilho para revisitar

Quando um worker específico tiver uma necessidade real e concreta de resolver/usar um agent via RPC (ex.: `graphrag-worker` ganha uma feature que precisa aplicar a config de um agent cadastrado a uma chamada interna de Q&A híbrido, sem passar pelo HTTP do `ai-worker`), esta spec é reaberta — o consumidor real, nesse momento, define quais métodos são efetivamente necessários, em vez do design especulativo esboçado acima.

## Status em `agent-registration-out-of-scope.md`

Este spec substitui a entrada "Exposição via RPC (Service Binding)" daquele documento como o registro canônico da decisão — a entrada lá passa a apontar para este arquivo.
