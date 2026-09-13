# ADR 0002: Workers em arquivos `.mjs`

Workers usam ES Modules e são publicados a partir de `terraform/workers/**/*.mjs`. Os fontes modulares em `src/` são empacotados por esbuild em `dist/index.mjs`; Terraform referencia esse artefato com `file()` e marca seu nome como `main_module`. Não há JavaScript inline em HCL. Colocá-los dentro da raiz Terraform permite que HCP Terraform envie os fontes para execuções remotas, preservando a separação entre aplicação e HCL.

## Workers Existentes

- **API Worker** (`dev-api`): CRUD de ingredientes + endpoints protegidos
- **Auth Worker** (`dev-auth`): Login, signup, JWT generation
- **RAG Worker** (`dev-rag`): Query e ingestion de base de conhecimento
- **AI Worker** (`dev-ai`): [[0008-openai-compatible-ai-api|Chat completions OpenAI-compatível]]

Todos seguem o padrão: `src/index.mjs` → esbuild → `dist/index.mjs` → Terraform.
