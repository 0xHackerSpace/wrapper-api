# Cloudflare infrastructure

Base Terraform para administrar infraestrutura Cloudflare e publicar Workers. Terraform e o provider oficial `cloudflare/cloudflare` são a fonte de verdade; a lógica dos Workers fica exclusivamente em `terraform/workers/**/*.mjs`.

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

1. Crie o código em `terraform/workers/<nome>/src/`, usando ES Modules e `export default`.
2. Execute `npm ci && npm run build:workers` para gerar o entrypoint em `dist/index.mjs`.
3. Adicione uma entrada em `workers` no `terraform.tfvars` do ambiente, apontando `script_path` para o `.mjs` em `dist/`.
4. Se necessário, declare o recurso em `kv_namespaces`, `r2_buckets`, `d1_databases` ou `queues` e cite-o em `bindings` pelo `resource_key`.
5. Execute `fmt`, `validate`, `plan` e `apply`.

O módulo valida a extensão `.mjs` e envia o conteúdo usando `file()`: não há JavaScript inline em Terraform.

## Acesso aos Workers

Os Workers são automaticamente publicados em `{script_name}.{workers_subdomain}.workers.dev` via `cloudflare_workers_script_subdomain`. Por exemplo, com `workers_subdomain = "0xhackerspace"`, o worker `dev-api` é acessível em:

```
https://dev-api.0xhackerspace.workers.dev
```

A configuração é simples: `subdomain_enabled = true` (padrão) e `previews_enabled = false`. Após um `apply` bem-sucedido, o Terraform exibe as URLs públicas de cada worker no output `worker_urls`. Para RAG stacks, o output `rag_stacks` inclui `worker_url`.

```sh
terraform -chdir=terraform apply -var-file=environments/dev/terraform.tfvars
# Outputs:
# worker_urls = {
#   api = "https://dev-api.0xhackerspace.workers.dev"
# }
# rag_stacks = {
#   rag = {
#     worker = "dev-rag"
#     worker_url = "https://dev-rag.0xhackerspace.workers.dev"
#     ...
#   }
# }
```

## RAG na Cloudflare

O módulo `terraform/modules/rag` compõe `r2`, `vectorize` e `worker` em uma stack de retrieval-augmented generation: bucket para documentos originais, índice Vectorize para embeddings e um Worker com `GET /health`, `POST /ingest` e `POST /query`. Declare a stack em `rag_stacks` no `terraform.tfvars` do ambiente:

```hcl
rag_stacks = {
  rag = {
    script_path        = "workers/rag/index.mjs"
    compatibility_date = "2026-08-24"
  }
}
```

O Worker recebe índice, bucket, modelos e parâmetros de recuperação por bindings (`AI`, `VECTORIZE`, `DOCUMENTS` e `plain_text`), então `terraform/workers/rag/index.mjs` não conhece nomes físicos, IDs ou credenciais. O modelo de embedding padrão `@cf/google/embeddinggemma-300m` gera 768 dimensões, valor padrão de `embedding_dimensions`; alterar um exige alterar o outro, o que recria o índice e pede reindexação a partir do R2.

O índice Vectorize é criado pela API da Cloudflare com `terraform_data`, porque o provider 5.23.0 não tem recurso equivalente. O apply precisa de `curl` e de `CLOUDFLARE_API_TOKEN` com permissão `Vectorize Write`. Veja [ADR 0003](docs/decisions/0003-vectorize-api-provisioning.md).

`/ingest` e `/query` só exigem `Authorization: Bearer <token>` quando um binding `AUTH_TOKEN` está presente; forneça-o por `additional_bindings` a partir de uma fonte segura, nunca de um `.tfvars` versionado.

## Adicionar um recurso Cloudflare

Crie um módulo focado em `terraform/modules/`, exponha entradas e saídas mínimas, acrescente sua coleção tipada em `terraform/variables.tf`, componha-a em `terraform/main.tf` e faça referência por binding quando aplicável. Mantenha políticas de WAF, Access e Zero Trust em módulos próprios, em vez de misturá-las ao deployment de um Worker.

## Novo ambiente

Copie um diretório existente em `terraform/environments/` e preencha seus valores. Não copie módulos nem o root module. Para ter state isolado, crie uma workspace HCP para o novo ambiente e atualize a seleção no bloco `cloud`. Veja [ADR 0001](docs/decisions/0001-environment-roots.md).

## Validação

```sh
terraform -chdir=terraform fmt -recursive
terraform -chdir=terraform init
terraform -chdir=terraform validate
node --test 'tests/**/*.test.mjs'
```

Os testes usam o runner embutido do Node.js, sem dependências, e exercitam os Workers com bindings simulados.
