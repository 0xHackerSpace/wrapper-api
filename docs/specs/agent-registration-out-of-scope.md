# Spec: Cadastro de Agents — Itens fora de escopo

Complementa [agent-registration.md](agent-registration.md). Lista o que foi deliberadamente adiado durante a especificação de agents, e por quê.

## Tool calling / function calling

Agent é, nesta spec, só `system_prompt` + parâmetros de geração (`model`, `temperature`, `max_tokens`, `top_p`). Não há campo para declarar acesso a ferramentas/RPCs de outros workers (ex.: `graph-worker`, `rag-worker`) que o `ai-worker` orquestraria durante a conversa.

**Por quê**: tool calling é uma feature grande por si só — parsing de function calls do modelo, orquestração de chamadas RPC, tratamento de erro por ferramenta, formato de resposta intermediária. Os modelos disponíveis via Cloudflare Workers AI não têm suporte confirmado e maduro a function calling estilo OpenAI hoje.

**Quando revisitar**: se surgir um caso concreto de agent que precise consultar `graph-worker`/`rag-worker` durante a conversa (não só no fluxo já existente do `graphrag-worker`), vira spec própria.

## Versionamento/histórico de edições do agent

Editar um agent (`PATCH /v1/agents/:id`) sobrescreve os campos diretamente, sem guardar as versões anteriores em lugar nenhum. A única "cópia congelada" que existe é o snapshot dentro de cada sessão que referenciou o agent no momento da criação (ver spec principal).

**Por quê**: não há requisito hoje de auditoria/rollback de config de agent; adicionar uma tabela de histórico seria especulativo sem um consumidor real.

**Quando revisitar**: se precisar de auditoria de quem mudou o quê num agent compartilhado por múltiplos editores.

## Re-snapshot de sessão existente

Não existe endpoint para atualizar os campos snapshot (`agent_system_prompt`, `agent_model`, etc.) de uma sessão já criada para refletir uma edição posterior do agent. Quem quiser a config atualizada precisa criar uma sessão nova referenciando o mesmo `agent_id`.

**Por quê**: mistura duas garantias que a spec principal deliberadamente separa — "conversa não muda de comportamento no meio" (snapshot) vs "quero a config mais recente" (re-snapshot). Resolver os dois casos ao mesmo tempo complicaria o contrato sem um pedido concreto.

**Quando revisitar**: se o padrão de uso mostrar que usuários frequentemente querem "atualizar" uma sessão de longa duração para a config mais nova do agent em vez de começar uma nova.

## Agents públicos / templates compartilhados

Não existe conceito de agent visível para todos os usuários por padrão (tipo "marketplace" ou "templates do sistema"). Acesso é sempre via `agent_access` explícita, um usuário de cada vez — mesmo modelo de `chat_access`/`graph_access`.

**Por quê**: nenhum requisito concreto de compartilhamento amplo hoje; ACL explícita já cobre o caso de "vários usuários específicos usam o mesmo agent" (decisão já tomada nesta spec).

**Quando revisitar**: se surgir demanda por uma biblioteca de agents pré-cadastrados disponíveis a todo usuário sem precisar de `agent_access` individual.

## Exposição via RPC (Service Binding)

**Decisão registrada** — ver [agent-registration-rpc-exposure.md](agent-registration-rpc-exposure.md). Nenhum outro worker pode criar, ler ou usar agents via RPC — a feature é exclusiva do caminho HTTP público do `ai-worker`, mesma decisão já tomada para sessões de chat (ver [chat-session-rpc-exposure.md](chat-session-rpc-exposure.md)).
