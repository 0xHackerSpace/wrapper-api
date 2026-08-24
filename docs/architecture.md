# Arquitetura

```text
Terraform root module
  ├── KV / R2 / D1 / Queues ──┐
  ├── DNS                     ├── Cloudflare API
  ├── Worker scripts + routes ─┘
  └── (futuro) WAF, Access, Zero Trust, Rulesets

workers/**/*.mjs ── código ES Modules carregado por Terraform ──┘
```

Cada ambiente seleciona uma única composição por meio de `terraform.tfvars`. O root module cria primeiro os recursos de plataforma e constrói os bindings a partir de seus outputs. Assim, um Worker não precisa conhecer IDs de infraestrutura no código nem no `tfvars`.

O módulo `worker` publica um `cloudflare_workers_script` em sintaxe de módulos (`main_module`) e, opcionalmente, `cloudflare_workers_route`. Ele recebe apenas um caminho de arquivo `.mjs`; todo código permanece fora de HCL. O recurso `cloudflare_workers_script` é o recurso estável atual do provider v5 para upload de script; a evolução para os recursos beta versionados será uma troca localizada no módulo.

Módulos iniciais: `worker`, `dns`, `kv`, `r2`, `d1` e `queues`. `waf` é um ponto de extensão documentado, sem regra padrão que possa bloquear tráfego inadvertidamente. Durable Objects, Workers AI, Vectorize, cron triggers, Turnstile, Access e Zero Trust entram por novos módulos e novos tipos de binding, sem alterar a divisão entre código e infraestrutura.

Os tokens e secrets não são inputs do projeto. Use `CLOUDFLARE_API_TOKEN` e, para bindings secretos futuros, uma fonte segura/CI; valores secretos jamais devem entrar em `.tfvars` versionado.
