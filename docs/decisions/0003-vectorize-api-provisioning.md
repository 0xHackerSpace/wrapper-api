# ADR 0003: Vectorize provisionado pela API da Cloudflare

O provider `cloudflare/cloudflare` 5.23.0 não expõe recurso nem data source para Vectorize: `bindings` do
Worker aceitam o tipo `vectorize`, mas o índice em si não é administrável de forma declarativa.

O módulo `terraform/modules/vectorize` cria o índice com `terraform_data` e dois `local-exec` (criação e
destruição) que chamam `POST/DELETE /accounts/{account_id}/vectorize/v2/indexes`. O token vem de
`CLOUDFLARE_API_TOKEN` no ambiente, como no restante do projeto, e não entra em variável nem em state. O
`input` do recurso guarda apenas account ID, nome, dimensões, métrica e URL da API, valores que o provisioner
de destruição precisa consultar via `self`.

`triggers_replace` cobre nome, dimensões, métrica, descrição e índices de metadados: qualquer alteração
recria o índice e, portanto, descarta os vetores. Os documentos originais e o manifesto permanecem no R2 para
permitir a reindexação. Um índice preexistente com o mesmo nome e as mesmas dimensões é adotado, o que torna
o apply idempotente após falhas parciais.

Essa é uma solução de transição. Quando o provider publicar um recurso de Vectorize, a troca fica contida no
módulo `vectorize`, sem afetar `rag`, os bindings ou o código do Worker.
