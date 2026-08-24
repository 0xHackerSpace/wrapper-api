# ADR 0002: Workers em arquivos `.mjs`

Workers usam ES Modules e são publicados a partir de `workers/**/*.mjs`. Terraform referencia o arquivo com `file()` e marca seu nome como `main_module`; não há JavaScript inline em HCL. Essa separação mantém revisão, testes e empacotamento de aplicação independentes do provisionamento.
