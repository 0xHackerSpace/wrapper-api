import { WorkerEntrypoint } from "cloudflare:workers";
import { json, badRequest, notFound, internalError } from "./lib/response.mjs";
import { chatCompletion, getAvailableModels, validateChatCompletionRequest, ValidationError } from "./lib/ai.mjs";
import { requirePermission, AuthError } from "./lib/auth.mjs";

export default class extends WorkerEntrypoint {
  async fetch(request) {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      if (pathname === "/health") return handleHealth();
      if (pathname === "/" || pathname === "/v1") return handleInfo();

      if (pathname === "/v1/models" && request.method === "GET") {
        return handleListModels();
      }

      if (pathname === "/v1/chat/completions" && request.method === "POST") {
        return await handleChatCompletion(request, this.env);
      }

      return notFound("Endpoint not found");
    } catch (error) {
      if (error instanceof AuthError) {
        return json({ error: { message: error.message, type: "invalid_request_error" } }, error.status);
      }
      console.error("Error:", error);
      return internalError(error.message);
    }
  }

  // RPC entrypoint for other workers via Service Bindings. No requirePermission here:
  // Service Bindings are only reachable from within the same Cloudflare account, so
  // RBAC (ai:chat) enforcement stays exclusive to the HTTP path above.
  async chat(messages, options = {}) {
    const validated = validateChatCompletionRequest({ messages, ...options });

    return chatCompletion(this.env.AI, validated.messages, {
      model: validated.model,
      temperature: validated.temperature,
      max_tokens: validated.max_tokens,
      top_p: validated.top_p,
    });
  }
}

function handleHealth() {
  return json({
    status: "ok",
    service: "ai",
    version: "1.0.0",
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
      chat_completions: "POST /v1/chat/completions (requires auth + ai:chat permission)",
    },
    documentation: "https://platform.openai.com/docs/api-reference",
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
      top_p: validated.top_p,
    });

    return json(result);
  } catch (error) {
    if (error instanceof ValidationError) {
      return badRequest(error.message);
    }
    return internalError(error.message);
  }
}
