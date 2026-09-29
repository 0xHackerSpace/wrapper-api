# Spec: Worker Hugging Face — Itens fora de escopo

Complementa [huggingface-worker.md](huggingface-worker.md). Lista o que foi deliberadamente adiado, e por quê.

## Integração com `ai-worker`/agents/teams

Este worker é totalmente segmentado — não é consumido por `ai-worker` via Service Binding, não vira uma tool de agent (ADR 0023), não é uma opção de `model` reconhecida em `agent-db.mjs`.

**Por quê**: decisão explícita (Q1 da entrevista) — o pedido foi por um worker especializado e separado, não um backend alternativo plugado no que já existe.

**Quando revisitar**: se surgir demanda concreta de um agent/tool precisar rodar inference via HF em vez de/além da Workers AI, isso vira uma spec própria (provavelmente um Service Binding novo `HUGGINGFACE_WORKER` no `ai-worker`, e uma tool nova no catálogo de `lib/tools.mjs`).

## Dependency oficial (`@huggingface/inference`)

O worker usa fetch cru contra `router.huggingface.co`, não o SDK oficial.

**Por quê**: mantém o padrão de zero dependencies de produção já estabelecido no projeto; ver decisão principal.

**Quando revisitar**: se as nuances entre providers nas 18 tasks não-chat se mostrarem grandes demais pra manter à mão (muitos casos especiais por provider descobertos durante os "Casos a verificar"), reconsiderar a dependency vira uma opção mais atraente.

## Cache, rate limiting e controle de custo

Nenhuma chamada é cacheada; não há limite de requests por usuário além do que a permission RBAC já controla (tudo ou nada); não há visibilidade de quanto cada chamada custa na conta HF por trás.

**Por quê**: nenhuma das 19 tasks tem uma razão óbvia pra precisar disso agora — mesmo raciocínio já usado pra não implementar orçamento agregado em teams de agents (`agent-teams-out-of-scope.md`).

**Quando revisitar**: se o custo de uso em produção virar um problema real observado.

## Model listing / catálogo de modelos disponíveis

Não existe uma rota `GET /v1/models` (diferente do `ai-worker`, que expõe seu catálogo fixo) que liste os modelos da HF disponíveis por task/provider.

**Por quê**: o catálogo de modelos da HF é grande e dinâmico (a própria doc menciona `GET /v1/models` do endpoint OpenAI-compatible retornando isso pra chat, mas replicar isso pras outras 18 tasks exigiria uma chamada adicional à HF por request ou um cache — nenhum dos dois foi decidido).

**Quando revisitar**: se o consumidor precisar descobrir modelos disponíveis programaticamente em vez de já saber o `model` que quer usar.

## Seleção automática de fallback entre providers no nível do worker

O worker repassa `provider: "auto"` (ou o que for enviado) direto pra HF — não implementa lógica própria de retry/fallback entre providers se um falhar (além do que a própria HF já faz internamente com `provider: "auto"`).

**Por quê**: a HF já oferece "Automatic Failover" quando `provider: "auto"` é usado (documentado); duplicar essa lógica no worker seria redundante sem um caso de uso que a HF não cubra.

**Quando revisitar**: se `provider: "auto"` da HF se mostrar insuficiente em produção (ex.: falhas não recuperadas automaticamente).

## Validação/normalização de parâmetros específicos por task

O worker repassa `parameters` como veio no corpo, sem validar campos específicos de cada task (ex.: não valida que `width`/`height` de `text-to-image` são múltiplos de 8, ou que `candidate_labels` de `zero-shot-classification` é um array não-vazio).

**Por quê**: replicar a validação completa de 19 schemas de parâmetros diferentes é um trabalho grande por si só; a própria HF já valida e retorna erro claro quando o parâmetro é inválido — o worker só precisa traduzir esse erro pro formato do projeto (já coberto na spec principal).

**Quando revisitar**: se erros genéricos da HF (sem contexto de qual campo especificamente) se mostrarem confusos demais pros consumidores do worker.
