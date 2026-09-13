---
name: adr-skill
description: Create or update Architecture Decision Records (ADRs) in /docs/decisions with deterministic numbering and consistent formatting.
---

# ADR Skill

Gerencia Architecture Decision Records (ADRs) na pasta `/docs/decisions/` com numeração automática e template consistente.

## Como Usar

Invoque o skill quando precisar:
- **Criar um novo ADR**: `/adr-skill create "Título da Decisão"`
- **Atualizar um ADR existente**: `/adr-skill update NNNN`
- **Listar ADRs**: `/adr-skill list`

## Funcionalidade

### 1. Create - Criar Novo ADR

Quando você executar `create`, o skill:

1. **Escaneia** `/docs/decisions/` para encontrar o próximo número disponível
2. **Valida** o título (min 5 caracteres, sem dígitos no início)
3. **Cria arquivo** nomeado como `NNNN-titulo-em-slug.md`
4. **Popula template** com:
   - Título formatado como `# ADR NNNN: Título da Decisão`
   - Seções padrão (Motivação, Implementação, etc)
   - Placeholders para o usuário preencher

**Formato do Filename:**
```
NNNN-titulo-em-kebab-case.md
```

**Template Padrão:**
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

### 2. Update - Atualizar ADR Existente

Quando você executar `update NNNN`:

1. **Valida** se o arquivo `NNNN-*.md` existe
2. **Abre** para edição com o template atual
3. **Preserva** conteúdo existente
4. **Formata** consistentemente (headers, referências internas, etc)

### 3. List - Listar ADRs

Exibe tabela com:
- Número (NNNN)
- Título
- Status (completo, em progresso, rascunho)
- Data de criação (se detectável)

## Determinismo

O skill é **determinístico** porque:

1. ✅ **Numeração automática**: Lê `/docs/decisions/` e deriva `NNNN` sequencialmente
2. ✅ **Naming consistente**: Converte título → kebab-case automaticamente
3. ✅ **Template fixo**: Sempre usa mesmas seções (Motivação, Implementação, Trade-offs)
4. ✅ **Sem variabilidade**: Não faz escolhas baseadas em contexto externo
5. ✅ **Idempotent**: Rodar 2x com mesmos inputs = mesmo resultado

## Validações

- ✅ Título deve ter min 5 caracteres
- ✅ Filename não pode conter números no início (apenas NNNN-)
- ✅ ADR com mesmo número não pode existir
- ✅ Referências internas usam formato `[[NNNN-slug|texto]]`

## Exemplo

```bash
/adr-skill create "Múltiplos D1s por domínio"
```

Resultado:
- Número detectado: 0009 (próximo após 0008)
- Arquivo criado: `/docs/decisions/0009-multiplos-d1s-por-dominio.md`
- Template populado com placeholder

## Integração com CLAUDE.md

O skill respeita:
- Padrão PT-BR (português brasileiro)
- Localização fixa: `/docs/decisions/`
- Nenhuma mudança em Terraform ou build config
- Commit message segue Conventional Commits
