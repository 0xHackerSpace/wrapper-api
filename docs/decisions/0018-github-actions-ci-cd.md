# ADR 0018: GitHub Actions — CI e CD para `dev`

Introduz dois workflows de GitHub Actions — `ci.yml` e `deploy.yml` — automatizando build, testes e `terraform apply` para o ambiente `dev`, eliminando o fluxo manual usado até então.

## Contexto

Não existia nenhum workflow de CI/CD (`.github/workflows/` não existia). Build (`npm run build:workers`), testes (`npm test`) e deploy (`terraform apply`) eram sempre executados manualmente, a partir da máquina do desenvolvedor.

O workspace HCP Terraform `wrapper-api` (org `0xHackerSpace`, projeto `config`) está configurado com **execução local** — quem invoca `terraform apply` é quem efetivamente executa o plano (incluindo os `local-exec` provisioners que rodam `npx wrangler d1 execute` para as migrations); a HCP Terraform só guarda o state remotamente. Isso significa que rodar isso via GitHub Actions exige que o próprio runner tenha `CLOUDFLARE_API_TOKEN` (usado tanto pelo provider Cloudflare quanto pelo `wrangler` das migrations D1) e um token da HCP Terraform (`TF_API_TOKEN`, para autenticar `terraform init/plan/apply` contra o backend remoto).

Dos três ambientes em `terraform/environments/`, só `dev` está de fato provisionado (`terraform.tfvars` populado); `staging` e `prod` têm `workers = {}` — placeholders vazios, fora de escopo aqui.

## Decisão

Dois workflows separados em `.github/workflows/`, cada um mirando só `dev`:

- **`ci.yml`** (trigger: `pull_request` para `main`): checkout, Node 22, `npm install`, `npm run build:workers`, `npm test`, seguido de `terraform init` + `terraform validate` + `terraform plan -var-file=environments/dev/terraform.tfvars` contra o workspace real — apenas *preview*, nunca aplica. Um único job sequencial: se build ou test falharem, o `plan` nem roda.
- **`deploy.yml`** (trigger: `push` para `main`): os mesmos passos de build/test de `ci.yml`, seguidos de `terraform apply -auto-approve -var-file=environments/dev/terraform.tfvars`. Roda a cada commit na `main`, sem gate manual — decisão explícita: todo merge deploya para `dev` automaticamente, mesmo sabendo que `terraform apply` executa as migrations D1 via `wrangler` (`local-exec`) sem intervenção humana adicional. `concurrency: { group: deploy-dev, cancel-in-progress: false }` serializa applies concorrentes caso dois pushes cheguem em sequência rápida — o segundo espera o primeiro terminar, não cancela.

Sem branch protection na `main`: decisão explícita, dado que só um desenvolvedor trabalha no repositório hoje. `staging`/`prod` ficam fora de escopo até terem tfvars reais.

## Implementação

- `CLOUDFLARE_API_TOKEN` é exportado como env var no nível do workflow em ambos os arquivos — consumido tanto pelo `provider "cloudflare" {}` (sem `api_token` explícito em `providers.tf`) quanto pelo `npx wrangler d1 execute` das migrations.
- `hashicorp/setup-terraform@v3` recebe `cli_config_credentials_token: ${{ secrets.TF_API_TOKEN }}`, autenticando `terraform init/plan/apply` contra o backend remoto HCP Terraform.
- `npm install`, não `npm ci` — não existe `package-lock.json` commitado no repositório hoje.
- Node 22 fixado explicitamente via `actions/setup-node@v4` (não há `.nvmrc`; é a versão usada localmente).
- Build sempre roda fresco a partir do `src/` do commit antes do `plan`/`apply`, independentemente do `dist/` commitado — não substitui a convenção existente de commitar `dist/`, ainda necessária para quem roda `terraform apply` localmente sem CI.
- Dois arquivos separados (`ci.yml`/`deploy.yml`) em vez de um workflow único com jobs condicionais — os triggers (`pull_request` vs `push`) são naturalmente distintos, mais simples de ler.

## Secrets necessários

Nenhum dos dois é automatizável — precisam ser criados manualmente em Settings → Secrets and variables → Actions antes do primeiro run:

| Secret | Uso |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Provider Cloudflare + `wrangler` das migrations D1 |
| `TF_API_TOKEN` | Autenticação do `terraform init/plan/apply` contra o workspace remoto HCP Terraform |

Sem eles, `ci.yml` falha no passo de `terraform plan` (build/test já rodaram e reportam status corretamente) e `deploy.yml` falha equivalente no `apply`.

## Trade-offs

| Abordagem | Vantagens | Desvantagens |
|---|---|---|
| **Deploy automático a cada push na `main` (escolhida)** | Iteração rápida, zero fricção operacional, único desenvolvedor no repo hoje | Sem gate manual entre merge e `apply` real — o `plan` só roda na PR, antes do merge (mitigação parcial); um push direto sem PR pula até esse preview |
| Deploy manual via `workflow_dispatch` | Confirmação humana antes de cada apply | Reintroduz a fricção manual que este ADR busca eliminar |
| Branch protection na `main` | Garante que todo push passe por PR/CI antes do merge | Overhead desnecessário com um único desenvolvedor no repositório hoje |

**Decisão**: automação completa sem gate manual e sem branch protection, aceitando o risco dado o contexto atual (um único desenvolvedor, `dev` como único ambiente real).

## Gaps conhecidos / Próximos Passos

- [ ] Configurar `CLOUDFLARE_API_TOKEN` e `TF_API_TOKEN` em Settings → Secrets and variables → Actions (bloqueante para o primeiro run)
- [ ] Revisitar este spec quando `staging`/`prod` ganharem tfvars reais — hoje cobre só `dev`
- [ ] Nenhuma notificação de falha de deploy configurada (Slack, email, etc.) — falhas só aparecem na aba Actions do GitHub

## Referências

- `docs/specs/github-actions-ci-cd.md` — spec completo desta mudança
- [[0011-unit-testing-strategy-for-workers|ADR 0011: Estratégia de testes unitários para workers]]
