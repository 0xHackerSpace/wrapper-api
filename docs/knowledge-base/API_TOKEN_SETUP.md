# Como Gerar Cloudflare API Token com Permissão D1

## ❌ Problema

O token atual não tem permissões D1:
```
Invalid access token [code: 9109]
```

## ✅ Solução: Criar Novo Token com Permissões D1

### 1️⃣ Acesse o Dashboard Cloudflare

Vá para: https://dash.cloudflare.com/profile/api-tokens

### 2️⃣ Criar Novo Token

1. Clique em **"Create Token"**
2. Escolha **"Custom Token"** (não use template pronto)

### 3️⃣ Configure as Permissões

**Nome do Token**: `D1 Migrations - wrapper-api`

**Permissões Necessárias**:

Adicione estas permissões:

| Categoria | Permissão | Status |
|-----------|-----------|--------|
| Account | D1 | **Write** ✅ |
| Account | D1 | **Read** ✅ |
| Account | Cloudflare Workers | **Write** ✅ |
| Zone | D1 | **Write** ✅ |
| Zone | D1 | **Read** ✅ |

### 4️⃣ Definir Escopo

- **Account Resources**: Selecione sua conta
- **Zone Resources**: Se aplicável, selecione as zones

### 5️⃣ Validade

- Recomendado: **3 meses** ou mais
- Para produção: Use tokens de longa duração

### 6️⃣ Copiar Token

Após criar, copie o token (começa com `cfk_` ou `v1.`):

```
cfk_seu_novo_token_aqui_com_muitos_caracteres
```

⚠️ **IMPORTANTE**: Guarde em local seguro! Não coloque no GitHub.

## 🧪 Testar Token

```bash
# Exporte o novo token
export CLOUDFLARE_API_TOKEN='cfk_seu_novo_token_aqui'

# Teste a conexão
npx wrangler d1 info dev-auth --remote
```

**Esperado**: Ver informações do database `dev-auth`

```
ID: 9f7e0d50-62b1-46a1-a18d-53d09895296d
Name: dev-auth
Created At: 2026-09-11T...
File Size: 0 B
Tables: 0
```

## 🚀 Usar com Script

Depois de confirmar que funciona:

```bash
./scripts/run-migrations.sh 'cfk_seu_novo_token_aqui' dev
```

## 🔐 Armazenar Token com Segurança

### ❌ NUNCA coloque em:
- `terraform.tfvars` versionado
- Commits do Git
- Documentação pública

### ✅ Melhores práticas:

**Localmente (desenvolvimento)**:
```bash
# No seu shell rc file (~/.bashrc, ~/.zshrc, etc)
export CLOUDFLARE_API_TOKEN='cfk_seu_token_aqui'

# Ou crie um arquivo .env.local (git-ignored)
echo 'export CLOUDFLARE_API_TOKEN="cfk_..."' > .env.local
source .env.local
```

**GitHub Actions (produção)**:
```yaml
- name: Run Migrations
  env:
    CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
  run: ./scripts/run-migrations.sh "$CLOUDFLARE_API_TOKEN" prod
```

**GitHub Secrets Setup**:
1. Vá para: `Settings` → `Secrets and variables` → `Actions`
2. Clique em **"New repository secret"**
3. Nome: `CLOUDFLARE_API_TOKEN`
4. Valor: Cole seu token
5. Clique em **"Add secret"**

## 📋 Checklist

- [ ] Criei novo token em https://dash.cloudflare.com/profile/api-tokens
- [ ] Token tem permissões **D1 Read** e **D1 Write**
- [ ] Testei token com: `npx wrangler d1 info dev-auth --remote`
- [ ] Exportei variável: `export CLOUDFLARE_API_TOKEN='...'`
- [ ] Executei migrations: `./scripts/run-migrations.sh <token> dev`
- [ ] Verifiquei dados: `npx wrangler d1 execute dev-auth --command="SELECT * FROM users;" --remote`

## 🆘 Troubleshooting

### "Invalid access token [code: 9109]"

**Causas**:
1. Token expirou
2. Token não tem permissões D1
3. Token é inválido ou foi revogado

**Solução**: Crie novo token com permissões D1 conforme instruções acima

### "Unauthorized [code: 6003]"

**Causa**: Token tem permissões, mas não para a ação específica

**Solução**: Verifique se token tem:
- ✅ D1 Read
- ✅ D1 Write
- ✅ Account Resources selecionada

### "Resource not found"

**Causa**: Database `dev-auth` não existe

**Solução**: Confirme que `terraform apply` foi bem-sucedido:
```bash
terraform -chdir=terraform apply -var-file=environments/dev/terraform.tfvars
```

## 📚 Referências

- [Cloudflare API Tokens](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/)
- [Cloudflare D1 Docs](https://developers.cloudflare.com/d1/)
- [Wrangler D1 CLI](https://developers.cloudflare.com/workers/wrangler/commands/#d1)
