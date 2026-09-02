# ADR 0004: três gatilhos para um Worker

Um Worker publicado por `cloudflare_workers_script` não recebe tráfego sozinho. O módulo `worker` oferece três
gatilhos, todos opcionais, e cada ambiente escolhe o que faz sentido.

`subdomain_enabled` usa `cloudflare_workers_script_subdomain` e publica o Worker em
`<script>.<conta>.workers.dev`. É o caminho sem pré-requisito: não exige zona, registro DNS nem certificado.
O padrão é `null`, que não cria recurso algum e deixa a configuração da conta como está, para que Workers já
existentes não mudem de comportamento ao adotar o atributo.

`domains` usa `cloudflare_workers_custom_domain`, que associa um hostname ao Worker e faz a Cloudflare criar o
registro DNS e emitir o certificado. Foi preferido a `routes` + `dns_records` porque uma rota só funciona se já
existir um registro proxied para o hostname, o que obrigaria a declarar um registro artificial (tipicamente
`AAAA 100::`) apenas para satisfazer a rota. As validações exigem `zone_id` ou `zone_name` em cada entrada, já
que o provider aceita ambos como opcionais mas a API precisa de um deles.

`routes` continua para os casos que domínio customizado não cobre: padrões com caminho, como
`exemplo.com/rag/*`, e hostnames cujo DNS é administrado fora deste repositório. Os três podem coexistir no
mesmo Worker.

A URL completa de workers.dev depende do subdomínio da conta, escolhido uma única vez no dashboard e não
exposto por nenhum recurso ou data source do provider 5.23.0. Por isso o módulo devolve apenas o estado
(`subdomain_enabled`), e não uma URL.
