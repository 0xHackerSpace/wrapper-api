# ADR 0005: autenticação e autorização em um Worker próprio

`workers/auth/index.mjs` concentra autenticação e autorização em vez de cada Worker resolver credenciais por
conta própria. Ele emite tokens em `POST /token` e responde em `POST /introspect` se um token está ativo e se
cobre um escopo exigido, que é o ponto de autorização consultado por outros Workers.

O fluxo é client credentials: um cliente apresenta `client_id` e `client_secret`, por JSON ou HTTP Basic, e
recebe um JWT HS256 assinado com o binding `SIGNING_KEY`. A assinatura é simétrica porque o único verificador é
o próprio Worker, através de `/introspect`; um par assimétrico só se justificaria para permitir verificação
offline por terceiros, com JWKS público, o que não é o caso.

Os clientes vivem no namespace KV `auth_clients`, em registros `client:<client_id>` com o hash SHA-256 do
segredo, os escopos permitidos e um sinal `disabled`. O Worker compara o hash mesmo quando o cliente não
existe, contra um valor fixo, e devolve `401 invalid_client` idêntico para cliente inexistente e segredo
errado: sem isso, o tempo de resposta e a mensagem revelariam quais client IDs existem. O escopo pedido precisa
ser subconjunto do que o cliente possui.

SHA-256 basta porque `client_secret` é credencial de máquina com alta entropia, gerada aleatoriamente. Se algum
dia o Worker autenticar senhas escolhidas por pessoas, isso precisa virar uma KDF com custo, como PBKDF2.

Tokens não são revogáveis antes de expirar: desabilitar um cliente impede novas emissões, mas um token já
emitido continua válido até `exp`. É a contrapartida de não consultar estado a cada verificação; por isso
`TOKEN_TTL` tem padrão de uma hora e é limitado a no máximo um dia. Revogação imediata exigiria uma denylist de
`jti` em KV, e entra apenas se houver necessidade concreta.

`/introspect` fica aberto por padrão e passa a exigir `Authorization: Bearer` quando o binding `AUTH_TOKEN`
existe. É o mesmo mecanismo opcional já adotado pelo Worker de RAG, reaproveitado em vez de criar um segundo
padrão de proteção interna.
