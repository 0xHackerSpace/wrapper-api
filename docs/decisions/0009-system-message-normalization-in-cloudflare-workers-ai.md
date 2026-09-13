# ADR 0009: System Message Normalization in Cloudflare Workers AI

Cloudflare Workers AI models require strict user/assistant role alternation and do not natively support system messages. To maintain OpenAI API compatibility while working within these constraints, system messages are normalized and concatenated with the first user message.

## Motivação

Quando integramos a API OpenAI-compatível com Cloudflare Workers AI, encontramos uma incompatibilidade crítica:

- **OpenAI**: Suporta `role: "system"` em qualquer posição da conversa
- **Cloudflare AI**: Exige que roles alternem estritamente entre `user` e `assistant`, começando com `user`
- **Resultado**: Requisições com sistema mensagens falhavam com erro `3030: Roles must alternate`

Precisávamos manter compatibilidade OpenAI para SDKs existentes enquanto trabalhávamos dentro das limitações do Cloudflare.

## Implementação

### Normalização de Mensagens

Função `normalizeMessages()` em `terraform/workers/ai/src/lib/ai.mjs`:

```javascript
function normalizeMessages(messages) {
  const normalized = [];
  let systemPrompt = "";

  // 1. Extrai todas as mensagens "system"
  for (const msg of messages) {
    if (msg.role === "system") {
      systemPrompt += (systemPrompt ? "\n\n" : "") + msg.content;
    } else {
      normalized.push(msg);
    }
  }

  // 2. Concatena prompt de sistema com primeira mensagem "user"
  if (systemPrompt && normalized.length > 0 && normalized[0].role === "user") {
    normalized[0] = {
      role: "user",
      content: `${systemPrompt}\n\n${normalized[0].content}`,
    };
  }

  return normalized;
}
```

### Fluxo de Request

1. Cliente envia requisição OpenAI-compatível com `system` messages
2. `chatCompletion()` chama `normalizeMessages()` antes do AI run
3. Prompt de sistema é prefixado à primeira mensagem de usuário
4. Cloudflare AI recebe sequência válida `[user, assistant, user, ...]`
5. Resposta formatada como OpenAI (com `choices`, `usage`, `finish_reason`)

### Exemplos

**Request com system message:**
```json
{
  "messages": [
    {"role": "system", "content": "Você é um assistente útil."},
    {"role": "user", "content": "Como fazer alho?"}
  ]
}
```

**Após normalização (enviado ao Cloudflare):**
```json
{
  "messages": [
    {"role": "user", "content": "Você é um assistente útil.\n\nComo fazer alho?"}
  ]
}
```

## Trade-offs

| Abordagem | Vantagens | Desvantagens |
|-----------|-----------|--------------|
| **System message normalization (escolhida)** | ✅ Compatível OpenAI; ✅ Simples; ✅ Sem custo extra | ⚠️ System prompt misturado com user content |
| Ignorar system messages | ✅ Compatível Cloudflare nativo | ❌ Quebra compatibilidade OpenAI |
| Multiple requests | ✅ Mantém separação | ❌ Custo duplo; latência alta |
| Wrapper customizado | ✅ Controle total | ❌ Reinventar a roda; manutenção |

**Decisão**: Normalização é o trade-off ideal entre compatibilidade e simplicidade.

## Próximos Passos

- [ ] Testar com múltiplas system messages
- [ ] Adicionar rate limiting baseado em prompt size
- [ ] Documentar limitações em exemplos de API
- [ ] Considerar streaming responses (requer handling especial)

## Referências

- [[0008-openai-compatible-ai-api|ADR 0008: AI Worker com OpenAI Compatibility]]
- Cloudflare Workers AI Docs: https://developers.cloudflare.com/workers-ai/models/
