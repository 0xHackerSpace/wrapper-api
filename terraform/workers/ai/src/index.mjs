import { WorkerEntrypoint } from "cloudflare:workers";
import { json, badRequest, notFound, internalError, conflict } from "./lib/response.mjs";
import {
  chatCompletion,
  chatCompletionStream,
  createChatCompletionChunkStream,
  getAvailableModels,
  validateChatCompletionRequest,
  ValidationError,
} from "./lib/ai.mjs";
import { requirePermission, AuthError } from "./lib/auth.mjs";
import {
  createSession,
  listSessionsForUser,
  getSessionById,
  listMessagesPage,
  listRecentMessages,
  addMessage,
  touchSession,
  renameSession,
  deleteSession,
  requireRole,
  listChatAccess,
  upsertChatAccess,
  deleteChatAccess,
  ConflictError,
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
        return await handleListSessions(request, this.env, url);
      }

      const sessionMatch = pathname.match(/^\/v1\/sessions\/([^/]+)(?:\/(messages|access)(?:\/([^/]+))?)?$/);
      if (sessionMatch) {
        const sessionId = sessionMatch[1];
        const resource = sessionMatch[2];
        const resourceId = sessionMatch[3];

        if (!resource && request.method === "GET") return await handleGetSession(request, this.env, sessionId);
        if (!resource && request.method === "DELETE") return await handleDeleteSession(request, this.env, sessionId);
        if (!resource && request.method === "PATCH") return await handlePatchSession(request, this.env, sessionId);

        if (resource === "messages" && !resourceId && request.method === "POST") {
          return await handleSendMessage(request, this.env, sessionId);
        }
        if (resource === "messages" && !resourceId && request.method === "GET") {
          return await handleListMessages(request, this.env, sessionId, url);
        }

        if (resource === "access") {
          if (!resourceId && request.method === "GET") return await handleListAccess(request, this.env, sessionId);
          if (resourceId && request.method === "PUT") return await handleGrantAccess(request, this.env, sessionId, resourceId);
          if (resourceId && request.method === "DELETE") return await handleRevokeAccess(request, this.env, sessionId, resourceId);
        }
      }

      return notFound("Endpoint not found");
    } catch (error) {
      if (error instanceof AuthError) {
        return json({ error: { message: error.message, type: "invalid_request_error" } }, error.status);
      }
      if (error instanceof ConflictError) {
        return conflict(error.message);
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
      chat_completions:
        "POST /v1/chat/completions (requires auth + ai:chat permission; body { stream: true } returns text/event-stream chat.completion.chunk events instead of a single JSON response)",
      create_session: "POST /v1/sessions (requires auth + ai:chat permission, creator becomes owner)",
      list_sessions: "GET /v1/sessions?limit=&cursor= (requires auth + ai:chat permission, lists sessions you have chat_access to, ordered by updated_at desc)",
      get_session: "GET /v1/sessions/:id (requires auth + ai:chat permission + viewer+ role; metadata only, no messages)",
      rename_session: "PATCH /v1/sessions/:id (requires auth + ai:chat permission + editor/owner role, body { title })",
      send_message:
        "POST /v1/sessions/:id/messages (requires auth + ai:chat permission + editor/owner role; body { stream: true } streams the reply via SSE and persists the full assistant message only after the stream ends successfully)",
      list_messages: "GET /v1/sessions/:id/messages?limit=&cursor= (requires auth + ai:chat permission + viewer+ role, ordered by created_at asc)",
      delete_session: "DELETE /v1/sessions/:id (requires auth + ai:chat permission + owner role)",
      grant_access: "PUT /v1/sessions/:id/access/:userId (requires auth + ai:chat permission + owner role, upserts a collaborator's role)",
      revoke_access: "DELETE /v1/sessions/:id/access/:userId (requires auth + ai:chat permission + owner role, or self-removal)",
      list_access: "GET /v1/sessions/:id/access (requires auth + ai:chat permission + viewer+ role)",
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

    if (body.stream === true) {
      return await streamChatCompletionResponse(env.AI, validated);
    }

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

// Setup (ai.run() itself failing, e.g. binding down) throws before this
// returns, so it's still caught by handleChatCompletion's try/catch above and
// surfaces as a normal JSON error response -- headers/status for the SSE
// response are only sent once this Response is actually returned.
async function streamChatCompletionResponse(ai, validated) {
  const { id, created, model, events } = await chatCompletionStream(ai, validated.messages, {
    model: validated.model,
    temperature: validated.temperature,
    max_tokens: validated.max_tokens,
    top_p: validated.top_p,
  });

  const stream = createChatCompletionChunkStream(events, { id, created, model });

  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
  });
}

async function handleCreateSession(request, env) {
  const payload = await requirePermission(request, env, "ai:chat");

  if (!env.CHAT_DB) {
    return internalError("Chat database not configured");
  }

  const session = await createSession(env.CHAT_DB, { userId: payload.sub });

  return json({ id: session.id, title: session.title, created_at: session.created_at }, 201);
}

async function handleListSessions(request, env, url) {
  const payload = await requirePermission(request, env, "ai:chat");

  if (!env.CHAT_DB) {
    return internalError("Chat database not configured");
  }

  const limit = url.searchParams.get("limit");
  const cursor = url.searchParams.get("cursor");

  const { data, next_cursor } = await listSessionsForUser(env.CHAT_DB, payload.sub, { limit, cursor });

  return json({ object: "list", data, next_cursor });
}

// 404 (not 403) when the actor has no chat_access row at all for this session
// -- requireRole() returns null in that case rather than throwing, so a
// session id never leaks to someone with zero access to it. Once the actor
// has *some* role, an insufficient one (e.g. viewer trying to send a message)
// surfaces as 403 instead, since they already know the session exists.
async function handleGetSession(request, env, sessionId) {
  const payload = await requirePermission(request, env, "ai:chat");

  if (!env.CHAT_DB) {
    return internalError("Chat database not configured");
  }

  const role = await requireRole(env.CHAT_DB, sessionId, payload.sub, "viewer");
  if (!role) {
    return notFound("Session not found");
  }

  const session = await getSessionById(env.CHAT_DB, sessionId);
  return json({ ...session, role });
}

async function handleDeleteSession(request, env, sessionId) {
  const payload = await requirePermission(request, env, "ai:chat");

  if (!env.CHAT_DB) {
    return internalError("Chat database not configured");
  }

  const role = await requireRole(env.CHAT_DB, sessionId, payload.sub, "owner");
  if (!role) {
    return notFound("Session not found");
  }

  const removed = await deleteSession(env.CHAT_DB, sessionId);
  if (!removed) {
    return notFound("Session not found");
  }

  return json({ success: true });
}

async function handlePatchSession(request, env, sessionId) {
  const payload = await requirePermission(request, env, "ai:chat");

  if (!env.CHAT_DB) {
    return internalError("Chat database not configured");
  }

  const role = await requireRole(env.CHAT_DB, sessionId, payload.sub, "editor");
  if (!role) {
    return notFound("Session not found");
  }

  const body = await request.json();
  const session = await renameSession(env.CHAT_DB, sessionId, body.title);

  return json({ ...session, role });
}

async function handleSendMessage(request, env, sessionId) {
  const payload = await requirePermission(request, env, "ai:chat");

  if (!env.CHAT_DB) {
    return internalError("Chat database not configured");
  }
  if (!env.AI) {
    return internalError("AI binding not configured");
  }

  const role = await requireRole(env.CHAT_DB, sessionId, payload.sub, "editor");
  if (!role) {
    return notFound("Session not found");
  }

  const body = await request.json();
  const { content, model, stream } = body;

  if (typeof content !== "string" || !content.trim()) {
    throw new ValidationError("content is required and must be a non-empty string");
  }

  await addMessage(env.CHAT_DB, { sessionId, role: "user", content });

  // Persists everything, but only sends the last CONTEXT_WINDOW_SIZE messages
  // (already includes the message just persisted above) to the model, so
  // long sessions don't blow past the model's context limit.
  const recentMessages = await listRecentMessages(env.CHAT_DB, sessionId);
  const modelMessages = recentMessages.map((m) => ({ role: m.role, content: m.content }));

  if (stream === true) {
    return await streamSendMessageResponse(env, sessionId, modelMessages, { model, userContent: content });
  }

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

// Buffer + forward: chunks stream to the client as they arrive, but the
// assistant message is only persisted (addMessage + touchSession, same as
// the non-streaming path above) once the stream ends successfully -- via
// onComplete, which createChatCompletionChunkStream runs after the last
// content event and before the finish_reason/usage/[DONE] chunks. If the
// stream fails mid-way, onComplete never runs, so nothing from the assistant
// is persisted; the user message (already persisted by the caller) stays.
async function streamSendMessageResponse(env, sessionId, modelMessages, { model, userContent }) {
  const { id, created, model: usedModel, events } = await chatCompletionStream(env.AI, modelMessages, { model });

  const stream = createChatCompletionChunkStream(events, { id, created, model: usedModel }, {
    onComplete: async (assistantContent) => {
      await addMessage(env.CHAT_DB, { sessionId, role: "assistant", content: assistantContent });
      await touchSession(env.CHAT_DB, sessionId, { title: userContent.slice(0, TITLE_MAX_LENGTH) });
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
  });
}

async function handleListMessages(request, env, sessionId, url) {
  const payload = await requirePermission(request, env, "ai:chat");

  if (!env.CHAT_DB) {
    return internalError("Chat database not configured");
  }

  const role = await requireRole(env.CHAT_DB, sessionId, payload.sub, "viewer");
  if (!role) {
    return notFound("Session not found");
  }

  const limit = url.searchParams.get("limit");
  const cursor = url.searchParams.get("cursor");

  const { data, next_cursor } = await listMessagesPage(env.CHAT_DB, sessionId, { limit, cursor });

  return json({ object: "list", data, next_cursor });
}

async function handleGrantAccess(request, env, sessionId, targetUserId) {
  const payload = await requirePermission(request, env, "ai:chat");

  if (!env.CHAT_DB) {
    return internalError("Chat database not configured");
  }

  const role = await requireRole(env.CHAT_DB, sessionId, payload.sub, "owner");
  if (!role) {
    return notFound("Session not found");
  }

  const body = await request.json();
  const { role: newRole } = body;

  const access = await upsertChatAccess(env.CHAT_DB, sessionId, targetUserId, newRole);

  return json({ success: true, data: access });
}

async function handleRevokeAccess(request, env, sessionId, targetUserId) {
  const payload = await requirePermission(request, env, "ai:chat");

  if (!env.CHAT_DB) {
    return internalError("Chat database not configured");
  }

  const isSelf = payload.sub === targetUserId;

  if (isSelf) {
    const session = await getSessionById(env.CHAT_DB, sessionId);
    if (!session) return notFound("Session not found");
  } else {
    const role = await requireRole(env.CHAT_DB, sessionId, payload.sub, "owner");
    if (!role) return notFound("Session not found");
  }

  const removed = await deleteChatAccess(env.CHAT_DB, sessionId, targetUserId);
  if (!removed) return notFound("Access not found");

  return json({ success: true });
}

async function handleListAccess(request, env, sessionId) {
  const payload = await requirePermission(request, env, "ai:chat");

  if (!env.CHAT_DB) {
    return internalError("Chat database not configured");
  }

  const role = await requireRole(env.CHAT_DB, sessionId, payload.sub, "viewer");
  if (!role) {
    return notFound("Session not found");
  }

  const access = await listChatAccess(env.CHAT_DB, sessionId);

  return json({ success: true, data: access, count: access.length });
}
