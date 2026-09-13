# Spec: GitHub Actions — CI e CD para `dev`

## Contexto

Hoje não existe nenhum workflow de CI/CD (`.github/workflows/` não existe). Build (`npm run build:workers`), testes (`npm test`) e deploy (`terraform apply`) são todos executados manualmente, a partir da máquina do desenvolvedor.

O workspace HCP Terraform `wrapper-api` (org `0xHackerSpace`, projeto `config`) está configurado com **execução local** — quem invoca `terraform apply` é quem efetivamente executa o plano (incluindo os `local-exec` provisioners que rodam `npx wrangler d1 execute` para as migrations); a HCP Terraform só guarda o state remotamente. Isso significa que rodar isso no GitHub Actions requer que o próprio runner tenha acesso a `CLOUDFLARE_API_TOKEN` (usado tanto pelo provider Cloudflare quanto pelo `wrangler`) e a um token da HCP Terraform (pra autenticar `terraform init/plan/apply` contra o backend remoto).

Dos três ambientes em `terraform/environments/`, só `dev` está de fato provisionado (`terraform.tfvars` populado). `staging` e `prod` têm `workers = {}` — placeholders vazios, sem recursos reais.

O repositório é público, `main` é a branch default, sem branch protection configurada, e nenhum GitHub Environment/secret existe ainda.

## Fora de escopo

- **`staging`/`prod`** — não têm tfvars reais ainda; criar jobs pra eles agora seria trabalho morto. Quando esses ambientes forem populados, esse spec pode ser revisitado.
- **Branch protection na `main`** — decidido explicitamente contra: só um desenvolvedor trabalhando no repo hoje.
- **Notificações de falha** (Slack, email, etc.) — não existe integração configurada, não foi pedido.
- **Deploy de `staging`/`prod` sob demanda** (`workflow_dispatch` manual) — mesma razão do primeiro item; sem tfvars reais, não há o que aplicar.

## Workflows

Dois arquivos em `.github/workflows/`:

### `ci.yml` — Pull Requests para `main`

Trigger: `pull_request` (branches: `main`).

Passos:
1. Checkout do repo.
2. Setup Node 22 (via `actions/setup-node`).
3. `npm install` (não há `package-lock.json` hoje, então `npm ci` não é aplicável).
4. `npm run build:workers` — falha o job se o esbuild não conseguir bundlar algum worker.
5. `npm test` — roda a suíte `node --test`.
6. `terraform init` (autenticado via token da HCP Terraform) + `terraform validate` + `terraform plan -var-file=environments/dev/terraform.tfvars` — só *preview*, nunca aplica. Roda contra o **workspace real** (`dev`), então mostra exatamente o que seria alterado se a PR fosse mergeada.

Todos os passos rodam num único job sequencial — se `build` ou `test` falhar, o `plan` nem roda (`terraform plan` sem build/test verde não tem valor).

### `deploy.yml` — Push direto na `main`

Trigger: `push` (branches: `main`).

Passos: idênticos aos passos 1–5 de `ci.yml` (checkout, setup Node, install, build, test), seguido de:

6. `terraform init` + `terraform apply -auto-approve -var-file=environments/dev/terraform.tfvars`.

Roda **a cada commit/push na `main`**, sem gate manual — decisão explícita: todo merge na `main` deploya pra `dev` automaticamente.

`concurrency: { group: deploy-dev, cancel-in-progress: false }` no nível do workflow, pra evitar dois `apply` simultâneos contra o mesmo state se dois pushes acontecerem em sequência rápida (o segundo espera o primeiro terminar, não cancela).

## Secrets a configurar (GitHub Actions → repo secrets)

| Secret | Uso |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Lido automaticamente pelo `provider "cloudflare" {}` (sem `api_token` explícito em `providers.tf`) e exportado como env var pro `npx wrangler d1 execute` chamado pelo `local-exec` das migrations. |
| `TF_API_TOKEN` | Token de usuário/equipe da HCP Terraform, usado por `hashicorp/setup-terraform@v3` (`cli_config_credentials_token`) pra autenticar `terraform init/plan/apply` contra o workspace remoto (state). |

Ambos ficam faltando ainda — precisam ser criados manualmente em Settings → Secrets and variables → Actions antes do primeiro run. Sem eles, `ci.yml` falha no passo de `terraform plan` (não bloqueia build/test, que rodam antes) e `deploy.yml` falha no `apply`.

## Decisões de baixo nível (sem necessidade de validação)

- **Node 22**: não há `.nvmrc` no repo; a versão local usada é 22.x — fixar essa mesma versão no workflow evita divergência silenciosa.
- **`npm install`, não `npm ci`**: não existe `package-lock.json` commitado hoje.
- **Build sempre roda fresco, nunca depende do `dist/` commitado**: `terraform/workers/*/dist/*.mjs` está versionado no git (não é gitignored), mas o job sempre roda `npm run build:workers` antes do `plan`/`apply`, então o deploy reflete o `src/` atual do commit, independentemente de o autor ter lembrado de commitar o `dist/` atualizado. Isso não substitui a convenção existente de commitar `dist/` (ainda necessário pra quem roda `terraform apply` localmente sem CI).
- **Dois arquivos separados** (`ci.yml`/`deploy.yml`) em vez de um workflow único com jobs condicionais — mais simples de ler, já que os triggers (`pull_request` vs `push`) são naturalmente distintos.

## Casos a verificar depois de configurado

- PR contra `main` com teste quebrado → `ci.yml` falha no passo `npm test`, `terraform plan` não roda.
- PR contra `main` com todos os testes passando → `ci.yml` verde, mostra o `terraform plan` nos logs.
- Merge da PR → `deploy.yml` dispara automaticamente, roda `terraform apply` contra `dev`.
- Dois pushes em sequência rápida na `main` → o segundo `deploy.yml` espera o primeiro terminar (não roda em paralelo).
- Secrets ausentes (antes de configurados) → `ci.yml` falha no `terraform init`/`plan` com erro de autenticação; `deploy.yml` falha equivalente no `apply`.

## Gaps conhecidos / próximos passos

- Quando `staging`/`prod` ganharem tfvars reais, este spec precisa ser revisitado — hoje cobre só `dev`.
- Sem branch protection, nada impede um push direto na `main` sem passar por PR (e, portanto, sem passar pelo `terraform plan` de preview) — aceito deliberadamente, dado que só um desenvolvedor usa o repo hoje.
- O comentário existente em `terraform/modules/d1/main.tf` ("Or use GitHub Actions with wrangler deployed") já antecipava esse cenário; nenhuma mudança na migration ou no módulo `d1` é necessária — o `local-exec` já funciona como está, desde que `CLOUDFLARE_API_TOKEN` esteja no ambiente de quem roda o `apply` (agora o runner do GitHub Actions).
