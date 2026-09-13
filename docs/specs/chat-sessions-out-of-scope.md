# Spec: Sessões de Chat — Itens fora de escopo

Complementa [chat-sessions.md](chat-sessions.md). Lista o que foi deliberadamente adiado durante a especificação da feature de sessões de chat, e por quê — para que uma revisão futura não precise re-descobrir o raciocínio do zero.

**Atualização**: compartilhamento, paginação/busca e renomear manualmente foram implementados — ver [chat-sessions-sharing-and-pagination.md](chat-sessions-sharing-and-pagination.md). Só a exposição via RPC continua fora de escopo (seção abaixo).

## Streaming

`/v1/chat/completions` e a nova `POST /v1/sessions/:id/messages` não suportam streaming (SSE ou chunked). Já era um "próximo passo" listado na ADR 0008 (AI Worker OpenAI compatibility) antes desta spec existir — sessões não mudam esse gap, só herdam a mesma limitação do endpoint stateless.

**Quando revisitar**: se streaming for implementado para `/v1/chat/completions`, a mesma mudança pode ser estendida a `/v1/sessions/:id/messages` sem alterar o schema.

## Exposição via RPC (Service Binding)

Nenhum outro worker (`graphrag-worker`, `rag-worker`, etc.) pode criar ou ler sessões via RPC — a feature é exclusiva do caminho HTTP público do `ai-worker`.

**Por quê**: não existe hoje nenhum consumidor interno concreto que precise disso. Expor `WorkerEntrypoint` methods (`createSession`, `appendMessage`) sem um caller real seria especulativo (YAGNI).

**Quando revisitar**: se `graphrag-worker` precisar manter uma sessão de conversa ao longo de múltiplas chamadas de Q&A híbrido, isso vira uma spec própria — provavelmente reaproveitando o mesmo padrão de `actorSub` explícito já usado pelo `graph-worker` via RPC (ADR 0015/0016).
