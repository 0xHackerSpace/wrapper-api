# ADR 0001: um root module, valores por ambiente

Usamos um único root module em `terraform/` e arquivos `environments/<nome>/terraform.tfvars`.

Isso evita divergência entre `dev`, `staging` e `prod`, mantém o grafo de recursos idêntico e permite que o backend de estado seja configurado por ambiente. Workspaces não são usados para esconder o ambiente: o comando torna explícito qual arquivo de valores e qual backend são usados.
