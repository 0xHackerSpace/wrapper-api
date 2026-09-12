// terraform/workers/ai/src/lib/response.mjs
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
function error(message, status = 400) {
  return json({ error: { message, type: "invalid_request_error" } }, status);
}
function badRequest(message) {
  return error(message, 400);
}
function notFound(message = "Not found") {
  return error(message, 404);
}
function internalError(message) {
  return error(message, 500);
}

// terraform/workers/ai/src/lib/ai.mjs
async function chatCompletion(ai, messages, options = {}) {
  const {
    model = "@cf/meta/llama-2-7b-chat-int8",
    temperature = 0.7,
    max_tokens = 1024,
    top_p = 1
  } = options;
  try {
    const response = await ai.run(model, {
      messages: messages.map((msg) => ({
        role: msg.role,
        content: msg.content
      })),
      temperature,
      max_tokens,
      top_p
    });
    return {
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1e3),
      model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: response.response || response
          },
          finish_reason: "stop"
        }
      ],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0
      }
    };
  } catch (error2) {
    throw new Error(`AI model error: ${error2.message}`);
  }
}
function getAvailableModels() {
  return {
    object: "list",
    data: [
      {
        id: "@cf/meta/llama-2-7b-chat-int8",
        object: "model",
        owned_by: "cloudflare",
        permission: []
      },
      {
        id: "@cf/mistral/mistral-7b-instruct-v0.1",
        object: "model",
        owned_by: "cloudflare",
        permission: []
      },
      {
        id: "@cf/baai/bge-base-en-v1.5",
        object: "model",
        owned_by: "cloudflare",
        permission: []
      }
    ]
  };
}
function validateChatCompletionRequest(body) {
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
    top_p: body.top_p || 1
  };
}

// terraform/workers/ai/src/index.mjs
var index_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;
    try {
      if (pathname === "/health") return handleHealth();
      if (pathname === "/" || pathname === "/v1") return handleInfo();
      if (pathname === "/v1/models" && request.method === "GET") {
        return handleListModels();
      }
      if (pathname === "/v1/chat/completions" && request.method === "POST") {
        return await handleChatCompletion(request, env);
      }
      return notFound("Endpoint not found");
    } catch (error2) {
      console.error("Error:", error2);
      return internalError(error2.message);
    }
  }
};
function handleHealth() {
  return json({
    status: "ok",
    service: "ai",
    version: "1.0.0"
  });
}
function handleInfo() {
  return json({
    service: "ai",
    version: "1.0.0",
    description: "OpenAI-compatible AI API powered by Cloudflare Workers AI",
    endpoints: {
      health: "GET /health",
      info: "GET /",
      models: "GET /v1/models",
      chat_completions: "POST /v1/chat/completions"
    },
    documentation: "https://platform.openai.com/docs/api-reference"
  });
}
function handleListModels() {
  return json(getAvailableModels());
}
async function handleChatCompletion(request, env) {
  if (!env.AI) {
    return internalError("AI binding not configured");
  }
  try {
    const body = await request.json();
    const validated = validateChatCompletionRequest(body);
    const result = await chatCompletion(env.AI, validated.messages, {
      model: validated.model,
      temperature: validated.temperature,
      max_tokens: validated.max_tokens,
      top_p: validated.top_p
    });
    return json(result);
  } catch (error2) {
    if (error2.message.includes("required")) {
      return badRequest(error2.message);
    }
    return internalError(error2.message);
  }
}
export {
  index_default as default
};
