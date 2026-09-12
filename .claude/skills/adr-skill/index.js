#!/usr/bin/env node

/**
 * ADR Skill - Gerencia Architecture Decision Records
 *
 * Uso:
 *   adr-skill create "Título da Decisão"
 *   adr-skill update NNNN
 *   adr-skill list
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const DOCS_DECISIONS_PATH = './docs/decisions';

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Converte string para kebab-case
 */
function toKebabCase(str) {
  return str
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/^-+|-+$/g, '');
}

/**
 * Valida título de ADR
 */
function validateTitle(title) {
  if (!title || title.trim().length < 5) {
    throw new Error('❌ Título deve ter no mínimo 5 caracteres');
  }
  if (/^\d/.test(title)) {
    throw new Error('❌ Título não pode começar com número');
  }
  return true;
}

/**
 * Lê arquivos da pasta /docs/decisions e retorna números existentes
 */
function getExistingADRNumbers() {
  if (!fs.existsSync(DOCS_DECISIONS_PATH)) {
    fs.mkdirSync(DOCS_DECISIONS_PATH, { recursive: true });
    return [];
  }

  const files = fs.readdirSync(DOCS_DECISIONS_PATH);
  const numbers = files
    .map((file) => {
      const match = file.match(/^(\d{4})-/);
      return match ? parseInt(match[1], 10) : null;
    })
    .filter((n) => n !== null)
    .sort((a, b) => a - b);

  return numbers;
}

/**
 * Calcula o próximo número de ADR
 */
function getNextADRNumber() {
  const existing = getExistingADRNumbers();
  const nextNum = existing.length > 0 ? Math.max(...existing) + 1 : 1;
  return String(nextNum).padStart(4, '0');
}

/**
 * Gera filename a partir do número e título
 */
function generateFilename(adrNumber, title) {
  const slug = toKebabCase(title);
  return `${adrNumber}-${slug}.md`;
}

/**
 * Template padrão de ADR
 */
function getADRTemplate(adrNumber, title) {
  return `# ADR ${adrNumber}: ${title}

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
`;
}

/**
 * Lista ADRs existentes
 */
function listADRs() {
  const files = fs.readdirSync(DOCS_DECISIONS_PATH).sort();

  if (files.length === 0) {
    console.log('📋 Nenhum ADR encontrado.');
    return;
  }

  console.log('\n📋 ADRs Existentes:\n');
  console.log('┌──────┬────────────────────────────────────────────────────────┐');
  console.log('│ Nº   │ Título                                                 │');
  console.log('├──────┼────────────────────────────────────────────────────────┤');

  files.forEach((file) => {
    const match = file.match(/^(\d{4})-(.+)\.md$/);
    if (match) {
      const num = match[1];
      const slug = match[2]
        .split('-')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
      const display = slug.length > 56 ? slug.substring(0, 53) + '...' : slug;
      console.log(`│ ${num} │ ${display.padEnd(56)} │`);
    }
  });

  console.log('└──────┴────────────────────────────────────────────────────────┘\n');
}

/**
 * Cria novo ADR
 */
function createADR(title) {
  validateTitle(title);

  const adrNumber = getNextADRNumber();
  const filename = generateFilename(adrNumber, title);
  const filepath = path.join(DOCS_DECISIONS_PATH, filename);

  if (fs.existsSync(filepath)) {
    throw new Error(`❌ ADR ${adrNumber} já existe: ${filename}`);
  }

  const template = getADRTemplate(adrNumber, title);
  fs.writeFileSync(filepath, template, 'utf8');

  console.log(`\n✅ ADR criado com sucesso!\n`);
  console.log(`📄 Arquivo: ${filepath}`);
  console.log(`🔢 Número: ${adrNumber}`);
  console.log(`📝 Título: ${title}\n`);

  return { adrNumber, filename, filepath };
}

/**
 * Atualiza ADR existente
 */
function updateADR(adrNumber) {
  const paddedNum = String(adrNumber).padStart(4, '0');
  const files = fs.readdirSync(DOCS_DECISIONS_PATH);
  const targetFile = files.find((f) => f.startsWith(paddedNum + '-'));

  if (!targetFile) {
    throw new Error(`❌ ADR ${paddedNum} não encontrado.`);
  }

  const filepath = path.join(DOCS_DECISIONS_PATH, targetFile);
  const content = fs.readFileSync(filepath, 'utf8');

  console.log(`\n📝 ADR ${paddedNum} aberto para edição:\n`);
  console.log(`📄 Arquivo: ${filepath}\n`);
  console.log('─'.repeat(60));
  console.log(content);
  console.log('─'.repeat(60));
  console.log(
    '\n💡 Edite o arquivo e execute novamente para salvar.\n'
  );

  return { adrNumber: paddedNum, filepath, content };
}

/**
 * Valida ADR (verifica formato, referências, etc)
 */
function validateADR(adrNumber) {
  const paddedNum = String(adrNumber).padStart(4, '0');
  const files = fs.readdirSync(DOCS_DECISIONS_PATH);
  const targetFile = files.find((f) => f.startsWith(paddedNum + '-'));

  if (!targetFile) {
    throw new Error(`❌ ADR ${paddedNum} não encontrado.`);
  }

  const filepath = path.join(DOCS_DECISIONS_PATH, targetFile);
  const content = fs.readFileSync(filepath, 'utf8');

  const issues = [];

  // Verifica título
  if (!content.match(/^# ADR \d{4}: /m)) {
    issues.push('❌ Título deve seguir formato: # ADR NNNN: Descrição');
  }

  // Verifica seções principais
  const sections = [
    'Motivação',
    'Implementação',
    'Trade-offs',
    'Próximos Passos',
  ];
  sections.forEach((section) => {
    if (!content.includes(`## ${section}`)) {
      issues.push(`⚠️  Seção "${section}" não encontrada`);
    }
  });

  // Verifica placeholders ainda preenchidos
  const placeholders = content.match(/\[.*?\]/g) || [];
  const realPlaceholders = placeholders.filter(
    (p) => p.includes('Descrição inicial') ||
            p.includes('Por que') ||
            p.includes('Como será') ||
            p.includes('Quais foram')
  );

  if (realPlaceholders.length > 0) {
    issues.push(`⚠️  ${realPlaceholders.length} placeholder(s) ainda não preenchido(s)`);
  }

  if (issues.length === 0) {
    console.log(`\n✅ ADR ${paddedNum} está bem formatado!\n`);
  } else {
    console.log(`\n⚠️  Problemas encontrados em ADR ${paddedNum}:\n`);
    issues.forEach((issue) => console.log(`  ${issue}`));
    console.log();
  }

  return issues;
}

// ============================================================================
// Main
// ============================================================================

function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  try {
    switch (command) {
      case 'create': {
        if (!args[1]) {
          throw new Error('❌ Use: adr-skill create "Título da Decisão"');
        }
        const title = args.slice(1).join(' ');
        createADR(title);
        break;
      }

      case 'update': {
        if (!args[1]) {
          throw new Error('❌ Use: adr-skill update NNNN');
        }
        updateADR(args[1]);
        break;
      }

      case 'validate': {
        if (!args[1]) {
          throw new Error('❌ Use: adr-skill validate NNNN');
        }
        validateADR(args[1]);
        break;
      }

      case 'list': {
        listADRs();
        break;
      }

      default: {
        console.log(`
🏗️  ADR Skill - Architecture Decision Records

Comandos disponíveis:

  create <título>    Cria novo ADR com próximo número
  update <NNNN>      Abre ADR para edição
  validate <NNNN>    Valida formato do ADR
  list               Lista todos os ADRs

Exemplos:

  adr-skill create "Múltiplos D1s por domínio"
  adr-skill update 0008
  adr-skill validate 0005
  adr-skill list
        `);
      }
    }
  } catch (err) {
    console.error(`\n${err.message}\n`);
    process.exit(1);
  }
}

main();
