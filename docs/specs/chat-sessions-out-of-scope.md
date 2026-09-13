# Spec: Sessões de Chat — Itens fora de escopo

Complementa [chat-sessions.md](chat-sessions.md). Lista o que foi deliberadamente adiado durante a especificação da feature de sessões de chat, e por quê — para que uma revisão futura não precise re-descobrir o raciocínio do zero.

## Streaming

`/v1/chat/completions` e a nova `POST /v1/sessions/:id/messages` não suportam streaming (SSE ou chunked). Já era um "próximo passo" listado na ADR 0008 (AI Worker OpenAI compatibility) antes desta spec existir — sessões não mudam esse gap, só herdam a mesma limitação do endpoint stateless.

**Quando revisitar**: se streaming for implementado para `/v1/chat/completions`, a mesma mudança pode ser estendida a `/v1/sessions/:id/messages` sem alterar o schema.

## Compartilhamento de sessão entre usuários

Decidido explicitamente: sessão de chat é sempre privada ao dono (`user_id == sub` do JWT), sem modelo de ACL tipo `graph_access` (owner/editor/viewer, ver ADR 0012/0016).

**Por quê**: não há nenhum caso de uso de "chat compartilhado" mencionado; é um assistente pessoal por usuário. Adicionar ACL agora seria complexidade sem requisito real por trás.

**Quando revisitar**: se surgir um caso de uso de colaboração (ex.: sessão de suporte vista por um admin), a tabela `graph_access` do `graph-worker` é o precedente de design a reaproveitar.

## Exposição via RPC (Service Binding)

Nenhum outro worker (`graphrag-worker`, `rag-worker`, etc.) pode criar ou ler sessões via RPC — a feature é exclusiva do caminho HTTP público do `ai-worker`.

**Por quê**: não existe hoje nenhum consumidor interno concreto que precise disso. Expor `WorkerEntrypoint` methods (`createSession`, `appendMessage`) sem um caller real seria especulativo (YAGNI).

**Quando revisitar**: se `graphrag-worker` precisar manter uma sessão de conversa ao longo de múltiplas chamadas de Q&A híbrido, isso vira uma spec própria — provavelmente reaproveitando o mesmo padrão de `actorSub` explícito já usado pelo `graph-worker` via RPC (ADR 0015/0016).

## Renomear sessão manualmente

Não existe endpoint `PATCH /v1/sessions/:id` para o usuário definir um título customizado. O `title` é só auto-gerado a partir da primeira mensagem (ver `chat-sessions.md` → Decisões de baixo nível).

**Por quê**: não foi um requisito levantado; título automático já resolve a necessidade mínima de listagem legível.

**Quando revisitar**: se a UI de listagem precisar de títulos editáveis pelo usuário, é um endpoint pequeno e isolado (`UPDATE chat_sessions SET title = ? WHERE id = ? AND user_id = ?`), sem impacto em nenhuma outra parte da spec.

## Paginação e busca no histórico

`GET /v1/sessions` (lista de sessões) e `GET /v1/sessions/:id` (histórico de mensagens de uma sessão) retornam tudo de uma vez, sem `limit`/`cursor`/`offset`, e sem filtro de busca por texto.

**Por quê**: mesmo gap já aceito em `GET /ingredients` hoje — introduzir paginação sem um requisito de volume real (quantas sessões/mensagens um usuário típico teria) seria projetar para um cenário hipotético.

**Quando revisitar**: se sessões/histórico crescerem a ponto de a resposta ficar grande o suficiente para importar (payload ou tempo de query), paginação por `created_at`/`updated_at` é a extensão natural — o schema já tem os campos necessários para isso (`created_at`, `updated_at` indexados).
