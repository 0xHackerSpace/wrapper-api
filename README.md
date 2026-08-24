# Cloudflare infrastructure

Base Terraform para administrar infraestrutura Cloudflare e publicar Workers. Terraform e o provider oficial `cloudflare/cloudflare` são a fonte de verdade; a lógica dos Workers fica exclusivamente em `workers/**/*.mjs`.

## Arquitetura

O root module em `terraform/` compõe módulos pequenos para KV, R2, D1, Queues, DNS e Workers. Recursos de dados são provisionados antes dos Workers; o root converte as referências declaradas no ambiente em bindings do Worker. Rotas dependem do script publicado. Consulte [a arquitetura](docs/architecture.md).

## Pré-requisitos

- Terraform `>= 1.5`;
- uma conta Cloudflare e um API Token de menor privilégio;
- permissões compatíveis com os recursos usados (por exemplo, Workers Scripts, Workers Routes, DNS Edit, KV, R2, D1 e Queues).

Autentique sem gravar credenciais no repositório:

```sh
export CLOUDFLARE_API_TOKEN='...'
```

O token deve ser fornecido pelo gerenciador de segredos do CI/CD em produção. `account_id`, zone IDs e nomes de recursos não são segredos, mas os exemplos usam valores vazios para impedir applies acidentais.

## Uso

Autentique a CLI no HCP Terraform e então execute:

```sh
terraform login
terraform -chdir=terraform init
terraform -chdir=terraform plan -var-file=environments/dev/terraform.tfvars
terraform -chdir=terraform apply -var-file=environments/dev/terraform.tfvars
```

O estado é armazenado e bloqueado no HCP Terraform, organização `0xHackerSpace`, projeto `config`, workspace `wrapper-api`. Nunca faça commit de `*.tfstate`. Troque `dev` por `staging` ou `prod` para selecionar valores, mas não use ambientes diferentes simultaneamente na mesma workspace: uma workspace possui um único state. Para isolá-los, crie workspaces por ambiente e altere a seleção no bloco `cloud`.

## Adicionar um Worker

1. Crie o código em `workers/<nome>/index.mjs`, usando ES Modules e `export default`.
2. Adicione uma entrada em `workers` no `terraform.tfvars` do ambiente, apontando `script_path` para o `.mjs`.
3. Se necessário, declare o recurso em `kv_namespaces`, `r2_buckets`, `d1_databases` ou `queues` e cite-o em `bindings` pelo `resource_key`.
4. Execute `fmt`, `validate`, `plan` e `apply`.

O módulo valida a extensão `.mjs` e envia o conteúdo usando `file()`: não há JavaScript inline em Terraform.

## Adicionar um recurso Cloudflare

Crie um módulo focado em `terraform/modules/`, exponha entradas e saídas mínimas, acrescente sua coleção tipada em `terraform/variables.tf`, componha-a em `terraform/main.tf` e faça referência por binding quando aplicável. Mantenha políticas de WAF, Access e Zero Trust em módulos próprios, em vez de misturá-las ao deployment de um Worker.

## Novo ambiente

Copie um diretório existente em `terraform/environments/` e preencha seus valores. Não copie módulos nem o root module. Para ter state isolado, crie uma workspace HCP para o novo ambiente e atualize a seleção no bloco `cloud`. Veja [ADR 0001](docs/decisions/0001-environment-roots.md).

## Validação

```sh
terraform -chdir=terraform fmt -recursive
terraform -chdir=terraform init
terraform -chdir=terraform validate
```
