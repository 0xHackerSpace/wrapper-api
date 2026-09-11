# ADR 0005: Gerenciamento de JWT_SECRET via Terraform

O `JWT_SECRET` é gerenciado como variável Terraform sensível (`sensitive = true`) e injetado em todos os Workers via binding de tipo `secret_text`.

**Motivação:**

- Centraliza o gerenciamento de segredos em uma única fonte de verdade (Terraform)
- Evita exposição em arquivos `.env` ou commits acidentais
- Permite rotação de segredos entre ambientes
- Workers acessam o secret via `env.JWT_SECRET` sem necessidade de `wrangler secret put` manual

**Implementação:**

1. Variável declarada em `terraform/variables.tf`:
```hcl
variable "jwt_secret" {
  type      = string
  sensitive = true
  default   = ""
}
```

2. Binding injetado automaticamente em `terraform/locals.tf`:
```hcl
jwt_secret_binding = var.jwt_secret != "" ? [{
  name = "JWT_SECRET"
  type = "secret_text"
  text = var.jwt_secret
}] : []
```

3. Todos os Workers recebem esse binding junto com suas configurações específicas.

**Segurança:**

- `jwt_secret` **nunca** é commitado no `terraform/environments/*/terraform.tfvars`
- Definido via variável de ambiente: `export TF_VAR_jwt_secret="..."`
- Ou via HCP Terraform UI (Workspace → Variables)
- Terraform remoto em HCP Terraform protege o estado

**Rotation:**

Para rotacionar o secret, atualize `TF_VAR_jwt_secret` e execute `terraform apply`. Todos os Workers receberão o novo binding automaticamente.
