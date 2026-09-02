# Arquitetura

```text
Terraform root module
  ├── KV / R2 / D1 / Queues ──┐
  ├── DNS                     ├── Cloudflare API
  ├── Worker scripts + routes ─┘
  └── (futuro) WAF, Access, Zero Trust, Rulesets

workers/**/*.mjs ── código ES Modules carregado por Terraform ──┘
```

O state e o locking são gerenciados pelo HCP Terraform na organização `0xHackerSpace`, projeto `config` e workspace `wrapper-api`. Cada ambiente seleciona uma composição por meio de `terraform.tfvars`; como uma workspace possui um único state, esta workspace deve gerenciar somente um ambiente de cada vez. O root module cria primeiro os recursos de plataforma e constrói os bindings a partir de seus outputs. Assim, um Worker não precisa conhecer IDs de infraestrutura no código nem no `tfvars`.

O módulo `worker` publica um `cloudflare_workers_script` em sintaxe de módulos (`main_module`) e, opcionalmente, `cloudflare_workers_route`. Ele recebe apenas um caminho de arquivo `.mjs`; todo código permanece fora de HCL. O recurso `cloudflare_workers_script` é o recurso estável atual do provider v5 para upload de script; a evolução para os recursos beta versionados será uma troca localizada no módulo.

Módulos iniciais: `worker`, `dns`, `kv`, `r2`, `d1` e `queues`. `waf` é um ponto de extensão documentado, sem regra padrão que possa bloquear tráfego inadvertidamente. Durable Objects, cron triggers, Turnstile, Access e Zero Trust entram por novos módulos e novos tipos de binding, sem alterar a divisão entre código e infraestrutura.

`vectorize` e `rag` seguem esse caminho. `vectorize` administra um índice Vectorize v2; como o provider ainda não possui recurso equivalente, ele usa `terraform_data` e a API da Cloudflare, conforme [ADR 0003](decisions/0003-vectorize-api-provisioning.md). `rag` compõe `r2`, `vectorize` e `worker` em uma stack de retrieval-augmented generation e entrega índice, bucket, modelos de Workers AI e parâmetros de recuperação ao Worker por bindings `ai`, `vectorize`, `r2_bucket` e `plain_text`.

Os Workers publicados recebem tráfego por três gatilhos opcionais do módulo `worker`: subdomínio workers.dev, domínio customizado e rota de zona ([ADR 0004](decisions/0004-worker-triggers.md)). O Worker `auth` centraliza emissão e verificação de tokens para os demais ([ADR 0005](decisions/0005-auth-worker.md)).

Os tokens e secrets não são inputs do projeto. Use `CLOUDFLARE_API_TOKEN` e, para bindings secretos futuros, uma fonte segura/CI; valores secretos jamais devem entrar em `.tfvars` versionado. Bindings `secret_text` são definidos fora do Terraform e preservados entre uploads por `keep_bindings` ([ADR 0006](decisions/0006-worker-secrets.md)).
