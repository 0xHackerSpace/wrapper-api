# ADR Skill

Gerencia **Architecture Decision Records (ADRs)** na pasta `/docs/decisions/` com numeração automática, nomes de arquivo consistentes e template estruturado.

## Características

✅ **Determinístico** — Numeração automática baseada em scan de arquivos existentes  
✅ **Nomes consistentes** — Converte títulos em kebab-case automaticamente  
✅ **Template fixo** — Mesma estrutura para todos os ADRs  
✅ **Validações** — Verifica título, formato e completude  
✅ **Bilíngue** — Suporta PT-BR (padrão) e EN

## Instalação

Já incluído em `/home/ianoliv/.claude/skills/adr-skill/`.

## Uso

### 1. Criar Novo ADR

```bash
adr-skill create "Título da Decisão"
```

**O que acontece:**
1. Scanneia `/docs/decisions/` para descobrir próximo número (ex: 0009)
2. Valida título (min 5 caracteres, sem dígitos no início)
3. Cria arquivo: `docs/decisions/0009-titulo-da-decisao.md`
4. Popula com template padrão

**Exemplo:**
```bash
adr-skill create "Migração para Durable Objects"
# ✅ ADR criado com sucesso!
# 📄 Arquivo: docs/decisions/0009-migracao-para-durable-objects.md
# 🔢 Número: 0009
# 📝 Título: Migração para Durable Objects
```

### 2. Atualizar ADR Existente

```bash
adr-skill update 0005
```

**O que acontece:**
1. Busca arquivo `0005-*.md`
2. Exibe conteúdo atual para referência
3. Dica: Edite o arquivo e a estrutura será preservada

**Exemplo:**
```bash
adr-skill update 0008
# 📝 ADR 0008 aberto para edição:
# 📄 Arquivo: docs/decisions/0008-openai-compatible-ai-api.md
# [exibe conteúdo]
```

### 3. Validar ADR

```bash
adr-skill validate 0005
```

**Verifica:**
- ✅ Título segue formato `# ADR NNNN: Título`
- ✅ Seções obrigatórias presentes
- ✅ Placeholders preenchidos
- ✅ Referências internas válidas

**Saída:**
```bash
# ✅ ADR 0005 está bem formatado!
# ou
# ⚠️  Problemas encontrados em ADR 0005:
#   ❌ Seção "Trade-offs" não encontrada
#   ⚠️  3 placeholder(s) ainda não preenchido(s)
```

### 4. Listar ADRs

```bash
adr-skill list
```

**Saída:**
```
📋 ADRs Existentes:

┌──────┬────────────────────────────────────────────────────────┐
│ Nº   │ Título                                                 │
├──────┼────────────────────────────────────────────────────────┤
│ 0001 │ Um Root Module, Valores Por Ambiente                  │
│ 0002 │ Workers Em Arquivos .Mjs                              │
│ 0003 │ Vectorize Api Provisioning                            │
│ 0004 │ D1 Multiple Databases                                 │
│ 0005 │ Jwt Secret Management                                 │
│ 0006 │ Ingredients Crud Api                                  │
│ 0007 │ Rbac Jwt Permissions                                  │
│ 0008 │ Openai Compatible Ai Api                              │
└──────┴────────────────────────────────────────────────────────┘
```

## Template Padrão

Todo ADR criado inclui:

```markdown
# ADR NNNN: Título da Decisão

[Descrição inicial - contexto ou resumo da decisão]

## Motivação

[Por que essa decisão foi tomada?]

## Implementação

[Como será implementado? Exemplos, arquivos, etc.]

## Trade-offs

[Quais foram as alternativas e por que escolhemos esta?]

## Próximos Passos

- [ ] [Item 1]
- [ ] [Item 2]
```

## Determinismo

O skill é **determinístico** porque:

| Aspecto | Como é Determinístico |
|---------|----------------------|
| **Numeração** | Lê `/docs/decisions/` e calcula `NNNN` sequencialmente |
| **Nomes de arquivo** | Converte título → kebab-case sem variabilidade |
| **Template** | Sempre mesmas seções na mesma ordem |
| **Saída** | Idempotente — executar 2x com mesmo input = mesmo resultado |

## Validações

| Validação | Regra |
|-----------|-------|
| Título | Mín. 5 caracteres, sem dígitos no início |
| Filename | `NNNN-kebab-case.md` |
| Duplicatas | Número de ADR não pode existir 2x |
| Referências | Formato: `[[0005-slug\|texto]]` |

## Exemplos de Títulos

✅ **Válidos:**
- "Migração para Durable Objects"
- "Cache Strategy for RAG Results"
- "Terraform State Remote Backend"

❌ **Inválidos:**
- "Cache" (< 5 caracteres)
- "123 New Feature" (começa com número)
- "a b c d" (muito curto)

## Estrutura de Pastas

```
docs/
└── decisions/
    ├── 0001-ambiente-roots.md
    ├── 0002-workers-es-modules.md
    ├── 0003-vectorize-api-provisioning.md
    ├── 0004-d1-multiple-databases.md
    ├── 0005-jwt-secret-management.md
    ├── 0006-ingredients-crud-api.md
    ├── 0007-rbac-jwt-permissions.md
    └── 0008-openai-compatible-ai-api.md
```

## Referências Internas

Para referenciar um ADR dentro de outro, use:

```markdown
Esta decisão complementa [[0005-jwt-secret-management|JWT Secret Management]]
```

Ou na lista de próximos passos:

```markdown
- [ ] Implementar conforme [[0008-openai-compatible-ai-api|ADR 0008]]
```

## FAQ

**P: Como atualizar um ADR que já existe?**  
R: Use `adr-skill update NNNN` e edite o arquivo normalmente. O skill apenas lê/exibe — não modifica estrutura.

**P: Posso renomear um ADR?**  
R: Sim, renomeie manualmente (ex: `0005-old-name.md` → `0005-new-name.md`) e mantenha o número.

**P: E se esquecer de preencher placeholders?**  
R: Use `adr-skill validate NNNN` para detectar placeholders ainda não preenchidos.

**P: Posso ter ADRs em inglês?**  
R: Sim! O skill detecta automaticamente o idioma do título e popula template em português ou inglês.

## Integração com Projeto

O skill é usado **via Skill do Claude Code**:

```bash
/adr-skill create "Novo Padrão de Cache"
```

Respeita:
- ✅ Pasta `/docs/decisions/` do projeto
- ✅ Nenhuma mudança em Terraform, config, build
- ✅ Commit messages seguem Conventional Commits
- ✅ Português brasileiro como padrão

## Próximas Melhorias

- [ ] Suporte a templates customizados por tipo (Arch, Data, API, etc)
- [ ] Auto-link para referências (backlinks)
- [ ] Git integration (auto-commit criação de ADRs)
- [ ] Status tracking (draft, accepted, superseded)
- [ ] Export to Markdown+HTML

---

**Criado para:** wrapper-api  
**Versão:** 1.0.0  
**Status:** Produção
