# ADR 0006: segredos de Worker fora do Terraform

Bindings do tipo `secret_text` teriam de receber seu valor de uma variável Terraform, e esse valor apareceria
no plano e no state. Isso contraria a regra do projeto de que tokens e segredos não são inputs, já aplicada a
`CLOUDFLARE_API_TOKEN` e ao provisionamento do Vectorize.

Segredos são definidos fora do Terraform, pela API ou por `wrangler secret put`. Como cada upload de script
substitui a lista de bindings, o módulo `worker` expõe `keep_bindings`, que mapeia o atributo homônimo de
`cloudflare_workers_script` e preserva do upload anterior os tipos listados. Com `keep_bindings =
["secret_text"]`, o `SIGNING_KEY` do Worker `auth` sobrevive a todo apply sem nunca ter sido conhecido pelo
Terraform. O mesmo vale para o `AUTH_TOKEN` opcional do Worker de RAG.

A consequência é uma ordem de operações: o primeiro apply publica o Worker sem o segredo, ele é definido em
seguida e os applies seguintes o mantêm. Nesse intervalo o Worker `auth` responde `500` em todas as rotas, por
falhar fechado quando `SIGNING_KEY` está ausente ou é curto demais. Terraform também não administra rotação: o
valor é trocado pela mesma via que o criou.
