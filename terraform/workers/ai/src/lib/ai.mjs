function normalizeMessages(messages) {
  const normalized = [];
  let systemPrompt = "";

  for (const msg of messages) {
    if (msg.role === "system") {
      systemPrompt += (systemPrompt ? "\n\n" : "") + msg.content;
    } else {
      normalized.push(msg);
    }
  }

  if (systemPrompt && normalized.length > 0 && normalized[0].role === "user") {
    normalized[0] = {
      role: "user",
      content: `${systemPrompt}\n\n${normalized[0].content}`,
    };
  }

  return normalized;
}

export async function chatCompletion(ai, messages, options = {}) {
  const {
    model = "@cf/meta/llama-2-7b-chat-int8",
    temperature = 0.7,
    max_tokens = 1024,
    top_p = 1,
  } = options;

  try {
    const normalizedMessages = normalizeMessages(messages);

    const response = await ai.run(model, {
      messages: normalizedMessages.map(msg => ({
        role: msg.role,
        content: msg.content,
      })),
      temperature,
      max_tokens,
      top_p,
    });

    return {
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: response.response || response,
          },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: response.usage?.prompt_tokens || 0,
        completion_tokens: response.usage?.completion_tokens || 0,
        total_tokens: response.usage?.total_tokens || 0,
      },
    };
  } catch (error) {
    throw new Error(`AI model error: ${error.message}`);
  }
}

export function getAvailableModels() {
  return {
    object: "list",
    data: [
      {
        id: "@cf/meta/llama-2-7b-chat-int8",
        object: "model",
        owned_by: "cloudflare",
        permission: [],
      },
      {
        id: "@cf/mistral/mistral-7b-instruct-v0.1",
        object: "model",
        owned_by: "cloudflare",
        permission: [],
      },
      {
        id: "@cf/baai/bge-base-en-v1.5",
        object: "model",
        owned_by: "cloudflare",
        permission: [],
      },
    ],
  };
}

export function validateChatCompletionRequest(body) {
  if (!body.messages || !Array.isArray(body.messages)) {
    throw new Error("messages is required and must be an array");
  }

  if (body.messages.length === 0) {
    throw new Error("messages array cannot be empty");
  }

  for (const msg of body.messages) {
    if (!msg.role || !msg.content) {
      throw new Error("each message must have role and content");
    }

    if (!["user", "assistant", "system"].includes(msg.role)) {
      throw new Error("message role must be user, assistant, or system");
    }
  }

  return {
    model: body.model || "@cf/meta/llama-2-7b-chat-int8",
    messages: body.messages,
    temperature: body.temperature || 0.7,
    max_tokens: body.max_tokens || 1024,
    top_p: body.top_p || 1,
  };
}
