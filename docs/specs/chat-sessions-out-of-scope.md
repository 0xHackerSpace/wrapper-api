# Spec: Sessões de Chat — Itens fora de escopo

Complementa [chat-sessions.md](chat-sessions.md). Lista o que foi deliberadamente adiado durante a especificação da feature de sessões de chat, e por quê — para que uma revisão futura não precise re-descobrir o raciocínio do zero.

**Atualização**: compartilhamento, paginação/busca, renomear manualmente e streaming foram implementados — ver [chat-sessions-sharing-and-pagination.md](chat-sessions-sharing-and-pagination.md) e [ADR 0021](../decisions/0021-chat-streaming.md). Só a exposição via RPC continua fora de escopo (seção abaixo).

## Streaming

**Implementado** — ver [ADR 0021](../decisions/0021-chat-streaming.md) e a spec [chat-streaming.md](chat-streaming.md). `/v1/chat/completions` e `POST /v1/sessions/:id/messages` agora aceitam `stream: true` no corpo e retornam SSE (`chat.completion.chunk` estilo OpenAI); ausência do campo (ou `false`) mantém o comportamento anterior sem mudança.

## Exposição via RPC (Service Binding)

Nenhum outro worker (`graphrag-worker`, `rag-worker`, etc.) pode criar ou ler sessões via RPC — a feature é exclusiva do caminho HTTP público do `ai-worker`.

**Por quê**: não existe hoje nenhum consumidor interno concreto que precise disso. Expor `WorkerEntrypoint` methods (`createSession`, `appendMessage`) sem um caller real seria especulativo (YAGNI).

**Quando revisitar**: se `graphrag-worker` precisar manter uma sessão de conversa ao longo de múltiplas chamadas de Q&A híbrido, isso vira uma spec própria — provavelmente reaproveitando o mesmo padrão de `actorSub` explícito já usado pelo `graph-worker` via RPC (ADR 0015/0016).
