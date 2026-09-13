import { WorkerEntrypoint } from "cloudflare:workers";
import { json, badRequest, notFound, internalError } from "./lib/response.mjs";
import { chatCompletion, getAvailableModels, validateChatCompletionRequest, ValidationError } from "./lib/ai.mjs";
import { requirePermission, AuthError } from "./lib/auth.mjs";
import {
  createSession,
  listSessionsForUser,
  getSessionForUser,
  listMessages,
  listRecentMessages,
  addMessage,
  touchSession,
  deleteSession,
} from "./lib/chat-db.mjs";

const TITLE_MAX_LENGTH = 50;

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

      if (pathname === "/v1/sessions" && request.method === "POST") {
        return await handleCreateSession(request, this.env);
      }
      if (pathname === "/v1/sessions" && request.method === "GET") {
        return await handleListSessions(request, this.env);
      }

      const sessionMatch = pathname.match(/^\/v1\/sessions\/([^/]+)(?:\/(messages))?$/);
      if (sessionMatch) {
        const sessionId = sessionMatch[1];
        const subresource = sessionMatch[2];

        if (!subresource && request.method === "GET") return await handleGetSession(request, this.env, sessionId);
        if (!subresource && request.method === "DELETE") return await handleDeleteSession(request, this.env, sessionId);
        if (subresource === "messages" && request.method === "POST") {
          return await handleSendMessage(request, this.env, sessionId);
        }
      }

      return notFound("Endpoint not found");
    } catch (error) {
      if (error instanceof AuthError) {
        return json({ error: { message: error.message, type: "invalid_request_error" } }, error.status);
      }
      if (error instanceof ValidationError) {
        return badRequest(error.message);
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
      create_session: "POST /v1/sessions (requires auth + ai:chat permission)",
      list_sessions: "GET /v1/sessions (requires auth + ai:chat permission, ordered by updated_at desc)",
      get_session: "GET /v1/sessions/:id (requires auth + ai:chat permission, includes full message history)",
      send_message: "POST /v1/sessions/:id/messages (requires auth + ai:chat permission)",
      delete_session: "DELETE /v1/sessions/:id (requires auth + ai:chat permission)",
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

async function handleCreateSession(request, env) {
  const payload = await requirePermission(request, env, "ai:chat");

  if (!env.CHAT_DB) {
    return internalError("Chat database not configured");
  }

  const session = await createSession(env.CHAT_DB, { userId: payload.sub });

  return json({ id: session.id, title: session.title, created_at: session.created_at }, 201);
}

async function handleListSessions(request, env) {
  const payload = await requirePermission(request, env, "ai:chat");

  if (!env.CHAT_DB) {
    return internalError("Chat database not configured");
  }

  const sessions = await listSessionsForUser(env.CHAT_DB, payload.sub);

  return json({ object: "list", data: sessions });
}

// 404 (not 403) whether the session doesn't exist or belongs to someone
// else -- getSessionForUser() enforces ownership in the query itself, so
// this never leaks whether a given session id exists at all.
async function handleGetSession(request, env, sessionId) {
  const payload = await requirePermission(request, env, "ai:chat");

  if (!env.CHAT_DB) {
    return internalError("Chat database not configured");
  }

  const session = await getSessionForUser(env.CHAT_DB, sessionId, payload.sub);
  if (!session) {
    return notFound("Session not found");
  }

  const messages = await listMessages(env.CHAT_DB, sessionId);

  return json({ ...session, messages });
}

async function handleDeleteSession(request, env, sessionId) {
  const payload = await requirePermission(request, env, "ai:chat");

  if (!env.CHAT_DB) {
    return internalError("Chat database not configured");
  }

  const removed = await deleteSession(env.CHAT_DB, sessionId, payload.sub);
  if (!removed) {
    return notFound("Session not found");
  }

  return json({ success: true });
}

async function handleSendMessage(request, env, sessionId) {
  const payload = await requirePermission(request, env, "ai:chat");

  if (!env.CHAT_DB) {
    return internalError("Chat database not configured");
  }
  if (!env.AI) {
    return internalError("AI binding not configured");
  }

  const session = await getSessionForUser(env.CHAT_DB, sessionId, payload.sub);
  if (!session) {
    return notFound("Session not found");
  }

  const body = await request.json();
  const { content, model } = body;

  if (typeof content !== "string" || !content.trim()) {
    throw new ValidationError("content is required and must be a non-empty string");
  }

  await addMessage(env.CHAT_DB, { sessionId, role: "user", content });

  // Persists everything, but only sends the last CONTEXT_WINDOW_SIZE messages
  // (already includes the message just persisted above) to the model, so
  // long sessions don't blow past the model's context limit.
  const recentMessages = await listRecentMessages(env.CHAT_DB, sessionId);
  const modelMessages = recentMessages.map((m) => ({ role: m.role, content: m.content }));

  const result = await chatCompletion(env.AI, modelMessages, { model });
  const assistantContent = result.choices[0].message.content;

  await addMessage(env.CHAT_DB, { sessionId, role: "assistant", content: assistantContent });
  await touchSession(env.CHAT_DB, sessionId, { title: content.slice(0, TITLE_MAX_LENGTH) });

  return json({
    session_id: sessionId,
    message: { role: "assistant", content: assistantContent },
    usage: result.usage,
  });
}
