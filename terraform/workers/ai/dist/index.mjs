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
var ValidationError = class extends Error {
};
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
      content: `${systemPrompt}

${normalized[0].content}`
    };
  }
  return normalized;
}
async function chatCompletion(ai, messages, options = {}) {
  const {
    model = "@cf/mistral/mistral-7b-instruct-v0.1",
    temperature = 0.7,
    max_tokens = 1024,
    top_p = 1
  } = options;
  try {
    const normalizedMessages = normalizeMessages(messages);
    const response = await ai.run(model, {
      messages: normalizedMessages,
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
        prompt_tokens: response.usage?.prompt_tokens || 0,
        completion_tokens: response.usage?.completion_tokens || 0,
        total_tokens: response.usage?.total_tokens || 0
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
    throw new ValidationError("messages is required and must be an array");
  }
  if (body.messages.length === 0) {
    throw new ValidationError("messages array cannot be empty");
  }
  for (const msg of body.messages) {
    if (!msg.role || !msg.content) {
      throw new ValidationError("each message must have role and content");
    }
    if (!["user", "assistant", "system"].includes(msg.role)) {
      throw new ValidationError("message role must be user, assistant, or system");
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

// terraform/workers/ai/src/lib/jwt.mjs
var encoder = new TextEncoder();
var decoder = new TextDecoder();
async function verifyToken(token, secret) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [headerEncoded, payloadEncoded, signatureEncoded] = parts;
    const message = `${headerEncoded}.${payloadEncoded}`;
    const expectedSignature = await sign(message, secret);
    if (signatureEncoded !== expectedSignature) return null;
    const payload = JSON.parse(base64urlDecode(payloadEncoded));
    const now = Math.floor(Date.now() / 1e3);
    if (payload.exp && payload.exp < now) return null;
    return payload;
  } catch {
    return null;
  }
}
async function sign(message, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return base64url(String.fromCharCode(...new Uint8Array(signature)));
}
function base64url(str) {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
function base64urlDecode(str) {
  str += "===".slice((str.length + 3) % 4);
  return decoder.decode(
    Uint8Array.from(
      atob(str.replace(/-/g, "+").replace(/_/g, "/")),
      (c) => c.charCodeAt(0)
    )
  );
}

// terraform/workers/ai/src/lib/auth.mjs
var AuthError = class extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
};
async function extractToken(request) {
  const authHeader = request.headers.get("authorization");
  if (!authHeader) {
    return null;
  }
  if (!authHeader.startsWith("Bearer ")) {
    throw new AuthError(401, "Invalid authorization header format");
  }
  return authHeader.slice(7);
}
async function requireAuth(request, env) {
  if (!env.JWT_SECRET) {
    throw new AuthError(500, "JWT_SECRET not configured");
  }
  const token = await extractToken(request);
  if (!token) {
    throw new AuthError(401, "Missing authorization token");
  }
  const payload = await verifyToken(token, env.JWT_SECRET);
  if (!payload) {
    throw new AuthError(401, "Invalid or expired token");
  }
  return payload;
}
async function requirePermission(request, env, permission) {
  const payload = await requireAuth(request, env);
  if (!Array.isArray(payload.permissions) || !payload.permissions.includes(permission)) {
    throw new AuthError(403, `Missing required permission: ${permission}`);
  }
  return payload;
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
      if (error2 instanceof AuthError) {
        return json({ error: { message: error2.message, type: "invalid_request_error" } }, error2.status);
      }
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
      chat_completions: "POST /v1/chat/completions (requires auth + ai:chat permission)"
    },
    documentation: "https://platform.openai.com/docs/api-reference"
  });
}
function handleListModels() {
  return json(getAvailableModels());
}
async function handleChatCompletion(request, env) {
  await requirePermission(request, env, "ai:chat");
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
    if (error2 instanceof ValidationError) {
      return badRequest(error2.message);
    }
    return internalError(error2.message);
  }
}
export {
  index_default as default
};
