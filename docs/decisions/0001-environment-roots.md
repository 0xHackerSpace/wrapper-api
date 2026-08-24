# ADR 0001: um root module, valores por ambiente

Usamos um único root module em `terraform/` e arquivos `environments/<nome>/terraform.tfvars`, conectado ao HCP Terraform na organização `0xHackerSpace`, projeto `config` e workspace `wrapper-api`.

Isso evita divergência entre `dev`, `staging` e `prod` e mantém o grafo de recursos idêntico. A workspace única possui um único state e, portanto, não deve receber applies de ambientes distintos. Quando houver mais de um ambiente ativo, adotaremos uma workspace HCP por ambiente (por exemplo, `wrapper-api-dev`, `wrapper-api-staging`, `wrapper-api-prod`), preservando o mesmo root module.
