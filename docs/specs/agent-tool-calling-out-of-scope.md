# Spec: Tool Calling para Agents — Itens fora de escopo

Complementa [agent-tool-calling.md](agent-tool-calling.md). Lista o que foi deliberadamente adiado, e por quê.

## Tool `find_node` / escrita no grafo (`graph-worker`)

Nenhum método RPC do `graph-worker` (`findNodeByLabel`, `upsertNode`, `createEdge`, etc.) vira tool nesta spec — só `query_knowledge_base` (RAG).

**Por quê**: grafos são multi-tenant com ACL por grafo (`graph_access`). Todo método RPC do `graph-worker` exige um `graphId` específico e um `actorSub` com papel na `graph_access` daquele grafo — não existe hoje um modelo de "qual grafo pertence a qual agent" nem de "de quem é o `actorSub` usado para checar acesso durante uma tool call" (o usuário da sessão? um service account fixo? o dono do agent?). Resolver isso é uma decisão de design própria, não uma extensão mecânica do mecanismo de tools desta spec.

**Quando revisitar**: quando houver um caso de uso concreto de agent que precise consultar/editar um grafo específico, decidindo nesse momento o vínculo agent↔graph e o modelo de autorização.

## Streaming dos ciclos intermediários de tool calling

Só a resposta final (depois do último ciclo do loop) é streamada ao client. Os ciclos intermediários (pedido de tool, execução, resultado) são invisíveis — o client não recebe nenhum evento indicando "consultando a base de conhecimento..." enquanto o loop roda.

**Por quê**: sinalizar progresso intermediário via SSE exigiria um vocabulário de evento novo (algo como um chunk `tool_call` no meio do stream, fora do formato `chat.completion.chunk` padrão da OpenAI que o restante da API já segue), e nenhum client hoje consome isso.

**Quando revisitar**: se o produto quiser mostrar ao usuário "o agent está pesquisando" durante o loop, precisa de um formato de evento SSE novo, desenhado com um consumidor real em mente.

## Tools customizadas / definidas pelo usuário

Só tools pré-cadastradas no código do `ai-worker` (catálogo fixo) podem ser habilitadas em `agent.tools`. Não existe forma de um usuário registrar sua própria tool (ex.: apontando pra um webhook externo).

**Por quê**: executar uma tool arbitrária definida por um usuário levanta problemas de segurança (SSRF, execução de código não confiável) e de contrato (schema de parâmetros, timeout, autenticação) que estão muito além do escopo desta spec.

**Quando revisitar**: nunca fica automático — esse tipo de feature ("plugins"/tools de terceiros) exigiria uma spec de segurança dedicada, se algum dia for cogitada.

## Tool calling em `/v1/chat/completions`

O endpoint stateless não ganha suporte a `tools`/`agent_id` nesta spec.

**Por quê**: tools vivem no agent, e só sessões referenciam agents (ADR 0022) — `/v1/chat/completions` permanece deliberadamente sem esse conceito (ADR 0008).

**Quando revisitar**: se surgir demanda por tool calling sem persistência de sessão, precisaria decidir como isso interage com a ausência de `agent_id` ali.

## Limite de iterações compartilhado/global

`max_tool_iterations` é só por agent (campo do agent, default 5) — não existe um teto global independente do agent que sobreponha o valor configurado.

**Por quê**: já resolvido como decisão desta spec (campo configurável por agent); um teto global adicional seria uma segunda camada de controle sem caso de uso concreto ainda.

**Quando revisitar**: se um agent malconfigurado (`max_tool_iterations` muito alto) causar custo/latência inaceitável em produção, considerar um teto rígido global como cinto de segurança.
