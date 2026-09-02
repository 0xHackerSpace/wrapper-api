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
4. Para expor o Worker, use `subdomain_enabled` (workers.dev), `domains` (domínio próprio) ou `routes` (padrão com caminho).
5. Execute `fmt`, `validate`, `plan` e `apply`.

O módulo valida a extensão `.mjs` e envia o conteúdo usando `file()`: não há JavaScript inline em Terraform.

## Worker `auth`

`workers/auth/index.mjs` autentica clientes e autoriza chamadas. Endpoints:

| Endpoint | Função |
| --- | --- |
| `GET /health` | disponibilidade, emissor e bindings presentes |
| `POST /token` | autentica um cliente por client credentials (JSON ou HTTP Basic) e emite um JWT HS256 com os escopos dele |
| `POST /introspect` | valida um token e responde se ele está ativo e se cobre o escopo exigido |

`/token` aceita `{"client_id": "...", "client_secret": "...", "scope": "rag:query"}` e devolve `{"access_token", "token_type", "expires_in", "scope"}`. O `scope` pedido precisa ser um subconjunto dos escopos do cliente; pedir mais devolve `403 invalid_scope`. Cliente inexistente e segredo errado produzem a mesma resposta `401 invalid_client`, e a comparação roda nos dois casos para não vazar a existência do cliente pelo tempo de resposta.

`/introspect` recebe `{"token": "...", "scope": "rag:ingest"}` e responde `{"active", "authorized", "missingScopes", "subject", "scopes", "expiresAt"}`. É o endpoint que outros Workers chamam para autorizar uma requisição. Ele fica aberto por padrão e passa a exigir `Authorization: Bearer <token>` quando o binding `AUTH_TOKEN` existe, o mesmo mecanismo opcional do Worker de RAG.

### Chave de assinatura

`SIGNING_KEY` é um `secret_text` de no mínimo 32 caracteres e **não** entra em `.tfvars`. Defina-o fora do Terraform e mantenha `keep_bindings = ["secret_text"]` no Worker, que preserva o binding a cada upload de script:

```sh
openssl rand -base64 48 | npx wrangler secret put SIGNING_KEY --name dev-auth
```

Sem esse binding o Worker responde `500` em todas as rotas, inclusive `/health`, de propósito.

### Cadastro de clientes

Cada cliente é uma chave `client:<client_id>` no namespace KV `auth_clients`, com este valor:

```json
{
  "secretHash": "<sha-256 hex do client_secret>",
  "scopes": ["rag:query", "rag:ingest"],
  "disabled": false
}
```

Gere o segredo e o hash com entropia alta, guardando apenas o hash:

```sh
secret=$(openssl rand -hex 32)
printf '%s' "$secret" | sha256sum
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

O Worker recebe índice, bucket, modelos e parâmetros de recuperação por bindings (`AI`, `VECTORIZE`, `DOCUMENTS` e `plain_text`), então `workers/rag/index.mjs` não conhece nomes físicos, IDs ou credenciais. O modelo de embedding padrão `@cf/google/embeddinggemma-300m` gera 768 dimensões, valor padrão de `embedding_dimensions`; alterar um exige alterar o outro, o que recria o índice e pede reindexação a partir do R2.

O índice Vectorize é criado pela API da Cloudflare com `terraform_data`, porque o provider 5.23.0 não tem recurso equivalente. O apply precisa de `curl` e de `CLOUDFLARE_API_TOKEN` com permissão `Vectorize Write`. Veja [ADR 0003](docs/decisions/0003-vectorize-api-provisioning.md).

`/ingest` e `/query` só exigem `Authorization: Bearer <token>` quando um binding `AUTH_TOKEN` está presente; forneça-o por `additional_bindings` a partir de uma fonte segura, nunca de um `.tfvars` versionado.

## Expor um Worker em um domínio

O caminho mais curto é `subdomain_enabled = true`, que publica o Worker em `https://<script>.<conta>.workers.dev` sem precisar de zona nem de registro DNS:

```hcl
rag_stacks = {
  rag = {
    script_path        = "workers/rag/index.mjs"
    compatibility_date = "2026-08-24"
    subdomain_enabled  = true
  }
}
```

`<conta>` é o subdomínio workers.dev da conta, escolhido uma única vez no dashboard da Cloudflare; por isso o Terraform expõe apenas o estado do subdomínio, não a URL completa. `subdomain_previews_enabled` faz o mesmo para as URLs de preview de cada versão. Deixar os dois de fora mantém a configuração como está na conta, sem administração pelo Terraform.

Para um domínio próprio, `domains` associa um hostname ao Worker com `cloudflare_workers_custom_domain`. A Cloudflare cria o registro DNS e emite o certificado, então não é preciso declarar nada em `dns_records`. O hostname deve ser o apex da zona ou um subdomínio dela, e a zona precisa estar na mesma conta:

```hcl
rag_stacks = {
  rag = {
    script_path        = "workers/rag/index.mjs"
    compatibility_date = "2026-08-24"
    domains = [{
      hostname = "rag.exemplo.com"
      zone_id  = "<zone id>"
    }]
  }
}
```

O mesmo atributo existe em `workers`. Depois do apply, `https://rag.exemplo.com/health` responde pelo Worker.

Use `routes` quando o gatilho for um padrão com caminho (`exemplo.com/rag/*`) ou quando o hostname já tiver um registro DNS administrado em outro lugar. Rotas só funcionam se existir um registro DNS proxied para o hostname; um domínio customizado dispensa esse passo. Os dois podem coexistir no mesmo Worker.

O token precisa de `Workers Scripts Write` e, para rotas, `Workers Routes Edit`.

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
