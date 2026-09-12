# ADR 0010: Claude Code Integration Guidelines (CLAUDE.md)

Projeto wrapper-api adota um arquivo `CLAUDE.md` no root para documentar padrões de trabalho com Claude Code, comunicar restrições de infraestrutura e definir quando solicitar confirmação do usuário.

## Motivação

Como o projeto usa **Terraform** + **Cloudflare Workers** (infraestrutura complexa), precisávamos:

1. **Orientar automação**: Claude Code deve conhecer estrutura, padrões, fluxos de build
2. **Prevenir erros**: Evitar apply sem confirmação, quebra de bindings, deploy acidental
3. **Documentar decisões**: Manter guia de "como adicionar workers" e "quando testar"
4. **Padronizar colaboração**: Deixar claro quando o usuário quer autonomia vs. confirmação

Inicialmente, instruções viviam apenas em conversas prévias. Agora estão versionadas.

## Implementação

### Estrutura de CLAUDE.md

```markdown
# Claude Code Guide for wrapper-api

## Project Overview
[Visão de alto nível: Workers, D1, Terraform]

## Architecture
[Diagrama ASCII: Workers + Bindings + Databases]

## Development Workflow
[Build: npm run build:workers, Deploy: terraform apply]

## Worker Structure
[Padrão: src/ → esbuild → dist/ → Terraform]

## Key Files to Know
[terraform/main.tf, terraform.tfvars, scripts/build-workers.mjs, etc]

## Patterns & Guidelines
[Code style, error handling, autenticação, AI worker details]

## Common Tasks
[Add new worker, database migration, update docs]

## Testing
[REST Client extension, requests/call.http]

## Secrets & Environment
[JWT_SECRET, TF_VAR_*, nunca commitr .env]

## When to Ask For Confirmation
[terraform apply, novo workers, autenticação, deploy produção]
```

### Integração com Claude Code

O arquivo é **lido automaticamente** quando:

- Sessão inicia (context do projeto)
- Arquivo é editado (reloading de instruções)
- Claude Code precisa decidir autonomia vs. confirmação

**Exemplo prático:**
```
User: "add a new worker called 'notifications'"
Claude: [lê CLAUDE.md, vê "quando: adicionar novo worker"]
Claude: "Vou criar a estrutura. Preciso confirmar antes de fazer terraform apply? Sim ou não?"
```

### Conteúdo Específico Incluído

1. **Architecture Overview**: Diagrama ASCII, componentes
2. **Worker Pattern**: src/ → esbuild → dist/ → Terraform (sem JS inline em HCL)
3. **Database Strategy**: Múltiplos D1s, autenticação vs. ingredientes
4. **AI Worker Details**: OpenAI-compatível, system messages, modelos
5. **Common Tasks**: Receita step-by-step para adicionar workers, migrations
6. **When to Confirm**: terraform apply, novo workers, autenticação, produção
7. **Useful Commands**: Build, validate, logs, SQL shell

### Sincronização com ADRs

CLAUDE.md **referencia ADRs** para decisões complexas:

```markdown
- **0002**: Workers em ES Modules
- **0007**: RBAC + JWT authentication
- **0008**: AI Worker com OpenAI Compatibility
- **0009**: System message normalization
```

Usuário pode "ler antes de propor mudanças significativas".

## Trade-offs

| Abordagem | Vantagens | Desvantagens |
|-----------|-----------|--------------|
| **CLAUDE.md (escolhida)** | ✅ Versionado; ✅ Auto-reloading; ✅ Acessível; ✅ Integra com .claude/ | ⚠️ Outra arquivo para manter |
| Apenas conversas prévias | ✅ Sem overhead | ❌ Perde contexto; ❌ Não escalável |
| Embed em README | ✅ Centralizado | ❌ README fica enorme |
| .claude/settings.json | ✅ Mais estruturado | ❌ JSON é menos legível |

**Decisão**: CLAUDE.md como "project-scoped README for Claude Code"—padrão emergente.

## Próximos Passos

- [ ] Manter CLAUDE.md atualizado com novos workers/padrões
- [ ] Adicionar seção "Troubleshooting" conforme surgem issues
- [ ] Documentar fluxo de secrets/envvars em mais detalhe
- [ ] Considerar template de CLAUDE.md para outros projetos

## Referências

- **Arquivos relacionados**:
  - `.claude/settings.json` (local config, not versionned)
  - `.claude/settings.local.json` (personal overrides)
  - `docs/architecture.md` (architecture overview)

- **ADRs**: [[0002-workers-es-modules|0002]], [[0004-d1-multiple-databases|0004]], [[0007-rbac-jwt-permissions|0007]], [[0008-openai-compatible-ai-api|0008]], [[0009-system-message-normalization-in-cloudflare-workers-ai|0009]]

## Notas

- CLAUDE.md é **versionado em git** para que toda equipe tenha contexto
- Atualizado sempre que padrões mudam ou novos workers adicionados
- Reduz necessidade de conversas "qual é a estrutura do projeto?"
- Oferece autonomia clara: Claude sabe quando pedir confirmação
