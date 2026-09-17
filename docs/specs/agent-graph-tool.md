# Spec: Tool `find_node` (Grafo) para Agents

Gerado via interview (`/grilling`). Complementa [agent-tool-calling.md](agent-tool-calling.md); resolve o item "Tool `find_node` / escrita no grafo" de [agent-tool-calling-out-of-scope.md](agent-tool-calling-out-of-scope.md) — só a parte de leitura (`find_node`); escrita no grafo via tool calling continua fora de escopo (ver seção própria abaixo).

## Contexto

A ADR 0023 introduziu tool calling para agents com uma única tool (`query_knowledge_base`, via `rag-worker`), que não tem problema de multi-tenancy (índice Vectorize único). `graph-worker.findNodeByLabel(graphId, actorSub, type, label)` (RPC já existente, `terraform/workers/graph/src/index.mjs`) é diferente: grafos são isolados por `graph_id`, com ACL própria (`graph_access`, ADR 0012), então virar tool exige decidir **qual grafo** e **de quem é o acesso** checado a cada chamada — isso ficou registrado como gap na ADR 0023 e é resolvido aqui.

## Decisão

### Escopo: só leitura (`find_node`)

Escrita no grafo (`upsertNode`, `createEdge`, etc.) via tool calling **não** é resolvida nesta spec — um modelo decidindo mutar dados do grafo sozinho é um risco de escopo maior, que merece sua própria validação depois que o mecanismo de "qual grafo/actorSub" (resolvido aqui) estiver rodando em produção. Ver [Fora de escopo](#fora-de-escopo).

### `graph_id` fixo no agent, escolhido pelo dono

Novo campo `graph_id` (opcional, string) no agent — o dono escolhe, ao cadastrar/editar, a qual grafo a tool `find_node` desse agent se conecta. Não é um parâmetro que o modelo escolhe a cada chamada: expor uma lista de grafos disponíveis pro modelo decidir exigiria uma tool adicional ("listar grafos") e complexidade desproporcional ao valor. Um agent só consulta um grafo fixo.

**Sem validação no cadastro**: `POST`/`PATCH /v1/agents` aceita qualquer string em `graph_id`, sem checar se o grafo existe ou se quem está criando/editando o agent tem acesso a ele. A validação real acontece em runtime (ver abaixo) — porque o agent pode ser compartilhado (`agent_access`, ADR 0022) e usado por pessoas diferentes de quem o cadastrou; validar no cadastro só garantiria acesso de quem criou, não de quem for efetivamente conversar com o agent depois.

### `actorSub` da checagem de acesso: o usuário da sessão

Cada chamada da tool usa `payload.sub` (o usuário autenticado que está enviando a mensagem na sessão) como `actorSub` para `graph-worker.findNodeByLabel(graphId, actorSub, type, label)` — não um service account fixo. Reflete o acesso real de quem está conversando: um agent nunca dá acesso a um grafo que o usuário não teria diretamente. Isso é consistente com o resto do projeto, onde ACL é sempre avaliada pelo usuário real, nunca por uma identidade compartilhada.

**Sem acesso, vira erro de tool, não trava a resposta**: `graph-worker`'s `findNodeByLabel` RPC já chama `requireRole(GRAPH_DB, graphId, actorSub, "viewer")` internamente, que lança `AuthError(403)` quando o `actorSub` não tem nenhum papel (ou papel insuficiente) no grafo. Isso encaixa direto no padrão de erro de tool já estabelecido na ADR 0023 (`try/catch` em volta de `tool.execute()`, resultado vira `{ error: message }` na mensagem `role: "tool"`, loop continua) — nenhum tratamento especial necessário além de deixar a exceção propagar até esse `catch` existente.

### Parâmetros da tool: `type` + `label`, match exato

`findNodeByLabel` faz um lookup exato (case-insensitive só no `label`) por `type` + `label` — não é busca difusa/semântica. Definição da tool:

```json
{
  "type": "function",
  "function": {
    "name": "find_node",
    "description": "Busca um node específico no grafo de conhecimento pelo tipo e rótulo exatos.",
    "parameters": {
      "type": "object",
      "properties": {
        "type": { "type": "string", "description": "O tipo do node (ex.: 'Ingredient', 'Recipe')." },
        "label": { "type": "string", "description": "O rótulo/nome exato do node a ser encontrado." }
      },
      "required": ["type", "label"]
    }
  }
}
```

**Limitação conhecida, aceita**: como é match exato, o modelo precisa "acertar" o `type`/`label` corretos (não há fuzzy matching) — resultado mais comum será "node não encontrado" quando o modelo não souber o rótulo exato. Isso não é resolvido aqui (ver Fora de escopo); a tool já é útil quando o modelo tem informação razoavelmente precisa (ex.: extraída de uma resposta anterior do `query_knowledge_base`).

Resultado devolvido ao modelo (mensagem `role: "tool"`): o node encontrado (`{ id, type, label, properties, ... }`, mesmo shape de `mapNodeRow`) ou `null`/mensagem indicando que não foi encontrado.

### Contexto extra em `execute()`: `tool.execute(env, args, context)`

Hoje `terraform/workers/ai/src/index.mjs` chama `tool.execute(env, args)` (`args` = só o que o modelo forneceu). `find_node` precisa também do `graph_id` (do snapshot da sessão) e do `actorSub` (usuário da sessão) — nenhum dos dois vem do modelo. A assinatura de `execute` em `lib/tools.mjs` passa a ser `execute(env, args, context)`, onde `context` é um objeto `{ actorSub, graphId }` (ou superset, se outra tool futura precisar de outro campo) montado pelo chamador (`runToolCallingLoop()`) a partir da sessão/usuário atuais, não dos argumentos do modelo. `query_knowledge_base.execute()` simplesmente ignora o terceiro parâmetro (não muda).

### Schema: `graph_id` no agent + snapshot na sessão

Migration `0021_add_graph_id_to_agents.sql` (D1 `dev-agents`): `ALTER TABLE agents ADD COLUMN graph_id TEXT` (nullable).

Migration `0022_add_agent_graph_id_snapshot_to_chat_sessions.sql` (D1 `dev-chat`): `ALTER TABLE chat_sessions ADD COLUMN agent_graph_id TEXT` (nullable, sem FK — mesmo raciocínio cross-database já usado para as demais colunas `agent_*`, migrations 0018/0020).

`AgentInput`/`AgentUpdateInput` (código) ganham o campo opcional `graph_id`. Faz parte do snapshot copiado em `POST /v1/sessions` junto com os demais campos do agent (ADR 0022/0023).

### Novo Service Binding: `ai-worker` → `graph-worker`

`terraform/environments/dev/terraform.tfvars`: `workers.ai.service_bindings` ganha `{ name = "GRAPH_WORKER", target_worker = "graph" }`, ao lado do `RAG_WORKER` já adicionado pela ADR 0023.

### Habilitação: `find_node` entra no catálogo fixo de tools

`find_node` é adicionado a `TOOL_CATALOG` (`lib/tools.mjs`), igual a `query_knowledge_base`. Um agent habilita via `tools: ["find_node"]` (ou junto com outras), mesmo mecanismo de opt-in já existente — nenhuma mudança no formato do campo `tools`.

**Agent com `find_node` habilitada mas sem `graph_id` configurado**: a tool falha em runtime com um erro (`{ error: "Agent has no graph_id configured" }`), mesmo tratamento de erro-de-tool de sempre — não é validado no cadastro (ver decisão de "sem validação no cadastro" acima, mesmo raciocínio se estende a "tools habilitada sem os campos que ela precisa").

## Decisões de baixo nível (sem necessidade de validação)

- Numeração de migrations: `0021` (dev-agents: `graph_id`), `0022` (dev-chat: `agent_graph_id` snapshot).
- Nome da tool no catálogo: `find_node` (mesmo nome já usado nos docs de fora-de-escopo, sem necessidade de renomear).
- `context` passado a `execute()` é montado uma vez por chamada de `runToolCallingLoop()` (não por tool call individual dentro do mesmo loop) — `actorSub`/`graphId` não mudam no meio de uma mesma mensagem.

## Casos a verificar

- Usuário sem `graph_access` no `graph_id` do agent: `find_node` retorna erro pro modelo (não trava a mensagem), mesmo comportamento de qualquer outro erro de tool.
- Agent com `find_node` habilitada e `graph_id` nulo: erro claro pro modelo, não um crash/500.
- `type`/`label` que não correspondem a nenhum node: resultado indica "não encontrado" de forma que o modelo consiga comunicar isso ao usuário, não um erro.
- `execute(env, args, context)`: `query_knowledge_base` continua funcionando sem receber/usar `context` (parâmetro adicional não quebra a tool existente).
- Dois agents diferentes, cada um com seu próprio `graph_id`, funcionando de forma independente na mesma conversa/worker (sem vazamento de contexto entre eles).

## Fora de escopo

### Escrita no grafo via tool calling

`upsertNode`, `updateNode`, `deleteNode`, `createEdge` continuam fora do catálogo de tools. **Por quê**: risco de um modelo mutar dados do grafo por conta própria é qualitativamente diferente de leitura — merece uma spec própria com sua própria validação de segurança (ex.: confirmação explícita do usuário antes de aplicar? rate limiting? qual role mínimo o `actorSub` precisa ter — `editor` em vez de `viewer`?). **Quando revisitar**: quando houver um caso de uso concreto (ex.: agent que constrói/expande o grafo a partir da conversa).

### Busca difusa/semântica de nodes

`find_node` é só o match exato que `findNodeByLabel` já oferece — sem normalização de texto, sem fuzzy matching, sem busca por similaridade. **Por quê**: `graph-worker` não expõe hoje nenhuma RPC de busca difusa por node; adicionar uma seria mudança de escopo no `graph-worker`, não só no `ai-worker`. **Quando revisitar**: se a taxa de "não encontrado" na prática for alta o suficiente para incomodar, considerar um RPC novo de busca no `graph-worker` primeiro.

### Outras RPCs de leitura do grafo (`getNeighbors`, `findPaths`)

Só `findNodeByLabel` vira tool nesta spec. **Por quê**: escopo mínimo pra validar o mecanismo de "grafo fixo no agent + actorSub do usuário" primeiro; `getNeighbors`/`findPaths` podem reusar exatamente o mesmo `graph_id`/`context` já resolvido aqui, sem nenhuma decisão de design nova — extensão mecânica quando houver interesse. **Quando revisitar**: se `find_node` sozinho se mostrar limitado (ex.: usuários querendo "o que está conectado a X"), adicionar como tools extras no mesmo catálogo.
