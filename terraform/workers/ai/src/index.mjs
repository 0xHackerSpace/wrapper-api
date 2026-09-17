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
import { runToolCallingLoop } from "./lib/agent-turn.mjs";
import { requirePermission, AuthError } from "./lib/auth.mjs";
import {
  createSession,
  listSessionsForUser,
  getSessionById,
  getSessionAgentConfig,
  listMessagesPage,
  listRecentMessages,
  addMessage,
  touchSession,
  renameSession,
  deleteSession,
  requireRole as requireSessionRole,
  listChatAccess,
  upsertChatAccess,
  deleteChatAccess,
  ConflictError,
} from "./lib/chat-db.mjs";
import {
  createAgent,
  getAgentById,
  listAgentsForUser,
  updateAgent,
  deleteAgent,
  requireRole as requireAgentRole,
  listAgentAccess,
  upsertAgentAccess,
  deleteAgentAccess,
} from "./lib/agent-db.mjs";
import {
  createTeam,
  getTeamById,
  listTeamsForUser,
  updateTeam,
  deleteTeam,
  requireRole as requireTeamRole,
  listTeamAccess,
  upsertTeamAccess,
  deleteTeamAccess,
} from "./lib/team-db.mjs";
import { runTeamOrchestration } from "./lib/team-orchestration.mjs";

const TITLE_MAX_LENGTH = 50;
// docs/specs/agent-tool-calling.md: fallback used only when a session's agent
// snapshot predates the max_tool_iterations column (agent-db.mjs already
// defaults it at agent creation/update time, so this should be rare).
const DEFAULT_MAX_TOOL_ITERATIONS = 5;

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

      if (pathname === "/v1/agents" && request.method === "POST") {
        return await handleCreateAgent(request, this.env);
      }
      if (pathname === "/v1/agents" && request.method === "GET") {
        return await handleListAgents(request, this.env, url);
      }

      const agentMatch = pathname.match(/^\/v1\/agents\/([^/]+)(?:\/(access)(?:\/([^/]+))?)?$/);
      if (agentMatch) {
        const agentId = agentMatch[1];
        const resource = agentMatch[2];
        const resourceId = agentMatch[3];

        if (!resource && request.method === "GET") return await handleGetAgent(request, this.env, agentId);
        if (!resource && request.method === "PATCH") return await handlePatchAgent(request, this.env, agentId);
        if (!resource && request.method === "DELETE") return await handleDeleteAgent(request, this.env, agentId);

        if (resource === "access") {
          if (!resourceId && request.method === "GET") return await handleListAgentAccess(request, this.env, agentId);
          if (resourceId && request.method === "PUT") return await handleGrantAgentAccess(request, this.env, agentId, resourceId);
          if (resourceId && request.method === "DELETE") return await handleRevokeAgentAccess(request, this.env, agentId, resourceId);
        }
      }

      if (pathname === "/v1/teams" && request.method === "POST") {
        return await handleCreateTeam(request, this.env);
      }
      if (pathname === "/v1/teams" && request.method === "GET") {
        return await handleListTeams(request, this.env, url);
      }

      const teamMatch = pathname.match(/^\/v1\/teams\/([^/]+)(?:\/(access)(?:\/([^/]+))?)?$/);
      if (teamMatch) {
        const teamId = teamMatch[1];
        const resource = teamMatch[2];
        const resourceId = teamMatch[3];

        if (!resource && request.method === "GET") return await handleGetTeam(request, this.env, teamId);
        if (!resource && request.method === "PATCH") return await handlePatchTeam(request, this.env, teamId);
        if (!resource && request.method === "DELETE") return await handleDeleteTeam(request, this.env, teamId);

        if (resource === "access") {
          if (!resourceId && request.method === "GET") return await handleListTeamAccess(request, this.env, teamId);
          if (resourceId && request.method === "PUT") return await handleGrantTeamAccess(request, this.env, teamId, resourceId);
          if (resourceId && request.method === "DELETE") return await handleRevokeTeamAccess(request, this.env, teamId, resourceId);
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
      create_session:
        "POST /v1/sessions (requires auth + ai:chat permission, creator becomes owner; optional body { agent_id } snapshots that agent's system_prompt/model/temperature/max_tokens/top_p onto the session, requires viewer+ role in agent_access, 404 if missing/no access; optional body { team_id } instead references a team live -- no snapshot, requires viewer+ role in team_access, 404 if missing/no access; agent_id and team_id are mutually exclusive, 400 if both are sent)",
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
      create_agent: "POST /v1/agents (requires auth + ai:agents permission, creator becomes owner)",
      list_agents: "GET /v1/agents?limit=&cursor= (requires auth + ai:agents permission, lists agents you have agent_access to, ordered by updated_at desc)",
      get_agent: "GET /v1/agents/:id (requires auth + ai:agents permission + viewer+ role)",
      patch_agent: "PATCH /v1/agents/:id (requires auth + ai:agents permission + editor/owner role, body may include name/system_prompt/model/temperature/max_tokens/top_p)",
      delete_agent: "DELETE /v1/agents/:id (requires auth + ai:agents permission + owner role)",
      grant_agent_access: "PUT /v1/agents/:id/access/:userId (requires auth + ai:agents permission + owner role, upserts a collaborator's role)",
      revoke_agent_access: "DELETE /v1/agents/:id/access/:userId (requires auth + ai:agents permission + owner role, or self-removal)",
      list_agent_access: "GET /v1/agents/:id/access (requires auth + ai:agents permission + viewer+ role)",
      create_team:
        "POST /v1/teams (requires auth + ai:teams permission, creator becomes owner; body { name, orchestration_mode, members, lead_agent_id, rounds, termination_strategy, max_orchestrator_steps } -- required fields vary by orchestration_mode, see docs/specs/agent-teams.md)",
      list_teams: "GET /v1/teams?limit=&cursor= (requires auth + ai:teams permission, lists teams you have team_access to, ordered by updated_at desc)",
      get_team: "GET /v1/teams/:id (requires auth + ai:teams permission + viewer+ role; includes the ordered members list)",
      patch_team: "PATCH /v1/teams/:id (requires auth + ai:teams permission + editor/owner role; sending members replaces the whole list)",
      delete_team: "DELETE /v1/teams/:id (requires auth + ai:teams permission + owner role; does not delete the member agents)",
      grant_team_access: "PUT /v1/teams/:id/access/:userId (requires auth + ai:teams permission + owner role, upserts a collaborator's role)",
      revoke_team_access: "DELETE /v1/teams/:id/access/:userId (requires auth + ai:teams permission + owner role, or self-removal)",
      list_team_access: "GET /v1/teams/:id/access (requires auth + ai:teams permission + viewer+ role)",
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

// Optional body { agent_id }: resolves and authorizes the agent (viewer+ in
// agent_access, via AGENTS_DB) and copies its config into a snapshot passed
// to createSession() -- see docs/specs/agent-registration.md. Missing agent
// or no access both return 404 (not 403), same non-leaking semantics as
// chat_access/agent_access elsewhere. Without agent_id, behavior is unchanged.
//
// Optional body { team_id } (docs/specs/agent-teams.md): same viewer+ ACL
// check, this time against team_access, but *no* snapshot -- team_id is
// stored as a live reference (createSession's teamId param), since a team
// always runs with its current members/config, never a frozen copy.
// Mutually exclusive with agent_id: sending both is a 400, checked before
// either DB lookup happens.
async function handleCreateSession(request, env) {
  const payload = await requirePermission(request, env, "ai:chat");

  if (!env.CHAT_DB) {
    return internalError("Chat database not configured");
  }

  const body = await request.json();
  const { agent_id: agentId, team_id: teamId } = body || {};

  if (agentId && teamId) {
    throw new ValidationError("agent_id and team_id are mutually exclusive");
  }

  let agentSnapshot = null;
  if (agentId) {
    if (!env.AGENTS_DB) {
      return internalError("Agents database not configured");
    }

    const role = await requireAgentRole(env.AGENTS_DB, agentId, payload.sub, "viewer");
    if (!role) {
      return notFound("Agent not found");
    }

    const agent = await getAgentById(env.AGENTS_DB, agentId);
    if (!agent) {
      return notFound("Agent not found");
    }

    agentSnapshot = {
      agentId,
      systemPrompt: agent.system_prompt,
      model: agent.model,
      temperature: agent.temperature,
      maxTokens: agent.max_tokens,
      topP: agent.top_p,
      tools: agent.tools,
      maxToolIterations: agent.max_tool_iterations,
      graphId: agent.graph_id,
    };
  }

  let resolvedTeamId = null;
  if (teamId) {
    if (!env.AGENTS_DB) {
      return internalError("Agents database not configured");
    }

    const role = await requireTeamRole(env.AGENTS_DB, teamId, payload.sub, "viewer");
    if (!role) {
      return notFound("Team not found");
    }

    resolvedTeamId = teamId;
  }

  const session = await createSession(env.CHAT_DB, { userId: payload.sub, agentSnapshot, teamId: resolvedTeamId });

  return json(
    { id: session.id, title: session.title, agent_id: session.agent_id, team_id: session.team_id, created_at: session.created_at },
    201
  );
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

  const role = await requireSessionRole(env.CHAT_DB, sessionId, payload.sub, "viewer");
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

  const role = await requireSessionRole(env.CHAT_DB, sessionId, payload.sub, "owner");
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

  const role = await requireSessionRole(env.CHAT_DB, sessionId, payload.sub, "editor");
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

  const role = await requireSessionRole(env.CHAT_DB, sessionId, payload.sub, "editor");
  if (!role) {
    return notFound("Session not found");
  }

  const body = await request.json();
  const { content, model, stream } = body;

  if (typeof content !== "string" || !content.trim()) {
    throw new ValidationError("content is required and must be a non-empty string");
  }

  await addMessage(env.CHAT_DB, { sessionId, role: "user", content });

  // docs/specs/agent-teams.md: a session with a team_id delegates the whole
  // request to the orchestration engine instead of the single-agent path
  // below. Sessions without a team_id (the overwhelming majority, and every
  // session that predates teams) fall straight through, unchanged.
  const session = await getSessionById(env.CHAT_DB, sessionId);
  if (session?.team_id) {
    return await handleTeamSendMessage(env, sessionId, session.team_id, {
      userContent: content,
      actorSub: payload.sub,
      stream: stream === true,
    });
  }

  // Persists everything, but only sends the last CONTEXT_WINDOW_SIZE messages
  // (already includes the message just persisted above) to the model, so
  // long sessions don't blow past the model's context limit.
  const recentMessages = await listRecentMessages(env.CHAT_DB, sessionId);
  const modelMessages = recentMessages.map((m) => ({ role: m.role, content: m.content }));

  // Sessions created with an agent_id carry a frozen config snapshot
  // (agent_system_prompt/model/temperature/max_tokens/top_p) -- dev-agents is
  // never queried again here, only the session's own copy (see
  // docs/specs/agent-registration.md). Without a snapshot, behavior is
  // unchanged: no fixed system prompt, model/params from the request or
  // chatCompletion()'s own defaults.
  const agentConfig = await getSessionAgentConfig(env.CHAT_DB, sessionId);
  if (agentConfig?.systemPrompt) {
    modelMessages.unshift({ role: "system", content: agentConfig.systemPrompt });
  }
  const aiOptions = buildAiOptions(agentConfig, model);

  // docs/specs/agent-tool-calling.md: a session's agent snapshot carrying a
  // non-empty `tools` list runs through the tool-calling loop instead of the
  // plain chatCompletion()/chatCompletionStream() path below. No tools (or no
  // agent at all) means this branch is never taken -- zero behavior change.
  const toolNames = agentConfig?.tools;
  if (Array.isArray(toolNames) && toolNames.length > 0) {
    return await handleToolCallingSendMessage(env, sessionId, modelMessages, {
      aiOptions,
      toolNames,
      maxIterations: agentConfig.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS,
      userContent: content,
      stream: stream === true,
      actorSub: payload.sub,
      graphId: agentConfig.graphId,
    });
  }

  if (stream === true) {
    return await streamSendMessageResponse(env, sessionId, modelMessages, { aiOptions, userContent: content });
  }

  const result = await chatCompletion(env.AI, modelMessages, aiOptions);
  const assistantContent = result.choices[0].message.content;

  await addMessage(env.CHAT_DB, { sessionId, role: "assistant", content: assistantContent });
  await touchSession(env.CHAT_DB, sessionId, { title: content.slice(0, TITLE_MAX_LENGTH) });

  return json({
    session_id: sessionId,
    message: { role: "assistant", content: assistantContent },
    usage: result.usage,
  });
}

// docs/specs/agent-teams.md: runs the full multi-agent orchestration (any of
// the 3 modes) for one incoming user message, then either returns the final
// answer as JSON or -- for stream: true -- replays the exact final prompt
// (messagesForFinalCall/aiOptions from runTeamOrchestration) through the
// existing streamSendMessageResponse() path, same "only the resolved final
// answer is ever streamed" rule already used by handleToolCallingSendMessage.
// Unlike the single-agent path, the non-streaming final content is *not*
// persisted again here: runTeamOrchestration's own per-turn calls (via
// lib/agent-turn.mjs's runAgentTurn) already persisted it, tagged with the
// producing agent's id -- adding a second, untagged copy here would just
// duplicate the last transcript entry.
async function handleTeamSendMessage(env, sessionId, teamId, { userContent, actorSub, stream }) {
  if (!env.AGENTS_DB) {
    return internalError("Agents database not configured");
  }

  const { content: assistantContent, usage, messagesForFinalCall, aiOptions } = await runTeamOrchestration(env, {
    sessionId,
    teamId,
    userContent,
    actorSub,
  });

  if (stream) {
    return await streamSendMessageResponse(env, sessionId, messagesForFinalCall, { aiOptions, userContent });
  }

  await touchSession(env.CHAT_DB, sessionId, { title: userContent.slice(0, TITLE_MAX_LENGTH) });

  return json({
    session_id: sessionId,
    message: { role: "assistant", content: assistantContent },
    usage,
  });
}

// Merges the session's agent snapshot (if any) with the per-request `model`
// override into the options object chatCompletion()/chatCompletionStream()
// expect. An explicit body.model always wins over the snapshot's model,
// mirroring the pre-existing per-call override; temperature/max_tokens/top_p
// have no per-request equivalent today, so they only ever come from the
// snapshot. Keys are omitted (not set to null) when absent so chatCompletion's
// own default parameter values still kick in -- default params only trigger
// on `undefined`, not `null`.
function buildAiOptions(agentConfig, explicitModel) {
  const options = {};
  const resolvedModel = explicitModel || agentConfig?.model;
  if (resolvedModel) options.model = resolvedModel;
  if (agentConfig?.temperature !== null && agentConfig?.temperature !== undefined) {
    options.temperature = agentConfig.temperature;
  }
  if (agentConfig?.maxTokens !== null && agentConfig?.maxTokens !== undefined) {
    options.max_tokens = agentConfig.maxTokens;
  }
  if (agentConfig?.topP !== null && agentConfig?.topP !== undefined) {
    options.top_p = agentConfig.topP;
  }
  return options;
}

// Buffer + forward: chunks stream to the client as they arrive, but the
// assistant message is only persisted (addMessage + touchSession, same as
// the non-streaming path above) once the stream ends successfully -- via
// onComplete, which createChatCompletionChunkStream runs after the last
// content event and before the finish_reason/usage/[DONE] chunks. If the
// stream fails mid-way, onComplete never runs, so nothing from the assistant
// is persisted; the user message (already persisted by the caller) stays.
async function streamSendMessageResponse(env, sessionId, modelMessages, { aiOptions, userContent }) {
  const { id, created, model: usedModel, events } = await chatCompletionStream(env.AI, modelMessages, aiOptions);

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

// docs/specs/agent-tool-calling.md, "Loop de tool calling" + "Streaming: só a
// resposta final": drives the loop to a final answer (always non-streaming
// internally, since each round needs the structured tool_calls field), then
// either persists+returns it as JSON (stream !== true) or replays the exact
// same final prompt through the existing chatCompletionStream()/
// createChatCompletionChunkStream() path with stream: true -- accepting one
// extra model call as the documented trade-off, rather than trying to stream
// the intermediate tool-calling rounds themselves (out of scope, see
// agent-tool-calling-out-of-scope.md).
async function handleToolCallingSendMessage(env, sessionId, modelMessages, { aiOptions, toolNames, maxIterations, userContent, stream, actorSub, graphId }) {
  const { result, messagesForFinalCall } = await runToolCallingLoop(env, sessionId, modelMessages, {
    ...aiOptions,
    toolNames,
    maxIterations,
    actorSub,
    graphId,
  });

  if (stream) {
    return await streamSendMessageResponse(env, sessionId, messagesForFinalCall, { aiOptions, userContent });
  }

  const assistantContent = result.content;

  await addMessage(env.CHAT_DB, { sessionId, role: "assistant", content: assistantContent });
  await touchSession(env.CHAT_DB, sessionId, { title: userContent.slice(0, TITLE_MAX_LENGTH) });

  return json({
    session_id: sessionId,
    message: { role: "assistant", content: assistantContent },
    usage: result.usage,
  });
}

async function handleListMessages(request, env, sessionId, url) {
  const payload = await requirePermission(request, env, "ai:chat");

  if (!env.CHAT_DB) {
    return internalError("Chat database not configured");
  }

  const role = await requireSessionRole(env.CHAT_DB, sessionId, payload.sub, "viewer");
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

  const role = await requireSessionRole(env.CHAT_DB, sessionId, payload.sub, "owner");
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
    const role = await requireSessionRole(env.CHAT_DB, sessionId, payload.sub, "owner");
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

  const role = await requireSessionRole(env.CHAT_DB, sessionId, payload.sub, "viewer");
  if (!role) {
    return notFound("Session not found");
  }

  const access = await listChatAccess(env.CHAT_DB, sessionId);

  return json({ success: true, data: access, count: access.length });
}

// --- Agents (docs/specs/agent-registration.md) ---
// Mirrors the /v1/sessions* handlers above: ai:agents is a separate RBAC
// permission from ai:chat (checked first, independent of any agent_access
// role), and agent_access follows the exact same owner/editor/viewer +
// "always >=1 owner" model as chat_access.

async function handleCreateAgent(request, env) {
  const payload = await requirePermission(request, env, "ai:agents");

  if (!env.AGENTS_DB) {
    return internalError("Agents database not configured");
  }

  const body = await request.json();
  const agent = await createAgent(env.AGENTS_DB, { userId: payload.sub, ...body });

  return json(agent, 201);
}

async function handleListAgents(request, env, url) {
  const payload = await requirePermission(request, env, "ai:agents");

  if (!env.AGENTS_DB) {
    return internalError("Agents database not configured");
  }

  const limit = url.searchParams.get("limit");
  const cursor = url.searchParams.get("cursor");

  const { data, next_cursor } = await listAgentsForUser(env.AGENTS_DB, payload.sub, { limit, cursor });

  return json({ object: "list", data, next_cursor });
}

// 404 (not 403) when the actor has no agent_access row at all for this agent
// -- requireAgentRole() returns null in that case rather than throwing, so an
// agent id never leaks to someone with zero access to it. Once the actor has
// *some* role, an insufficient one (e.g. viewer trying to PATCH) surfaces as
// 403 instead, since they already know the agent exists.
async function handleGetAgent(request, env, agentId) {
  const payload = await requirePermission(request, env, "ai:agents");

  if (!env.AGENTS_DB) {
    return internalError("Agents database not configured");
  }

  const role = await requireAgentRole(env.AGENTS_DB, agentId, payload.sub, "viewer");
  if (!role) {
    return notFound("Agent not found");
  }

  const agent = await getAgentById(env.AGENTS_DB, agentId);
  return json({ ...agent, role });
}

async function handlePatchAgent(request, env, agentId) {
  const payload = await requirePermission(request, env, "ai:agents");

  if (!env.AGENTS_DB) {
    return internalError("Agents database not configured");
  }

  const role = await requireAgentRole(env.AGENTS_DB, agentId, payload.sub, "editor");
  if (!role) {
    return notFound("Agent not found");
  }

  const body = await request.json();
  const agent = await updateAgent(env.AGENTS_DB, agentId, body);
  if (!agent) {
    return notFound("Agent not found");
  }

  return json({ ...agent, role });
}

async function handleDeleteAgent(request, env, agentId) {
  const payload = await requirePermission(request, env, "ai:agents");

  if (!env.AGENTS_DB) {
    return internalError("Agents database not configured");
  }

  const role = await requireAgentRole(env.AGENTS_DB, agentId, payload.sub, "owner");
  if (!role) {
    return notFound("Agent not found");
  }

  const removed = await deleteAgent(env.AGENTS_DB, agentId);
  if (!removed) {
    return notFound("Agent not found");
  }

  return json({ success: true });
}

async function handleGrantAgentAccess(request, env, agentId, targetUserId) {
  const payload = await requirePermission(request, env, "ai:agents");

  if (!env.AGENTS_DB) {
    return internalError("Agents database not configured");
  }

  const role = await requireAgentRole(env.AGENTS_DB, agentId, payload.sub, "owner");
  if (!role) {
    return notFound("Agent not found");
  }

  const body = await request.json();
  const { role: newRole } = body;

  const access = await upsertAgentAccess(env.AGENTS_DB, agentId, targetUserId, newRole);

  return json({ success: true, data: access });
}

async function handleRevokeAgentAccess(request, env, agentId, targetUserId) {
  const payload = await requirePermission(request, env, "ai:agents");

  if (!env.AGENTS_DB) {
    return internalError("Agents database not configured");
  }

  const isSelf = payload.sub === targetUserId;

  if (isSelf) {
    const agent = await getAgentById(env.AGENTS_DB, agentId);
    if (!agent) return notFound("Agent not found");
  } else {
    const role = await requireAgentRole(env.AGENTS_DB, agentId, payload.sub, "owner");
    if (!role) return notFound("Agent not found");
  }

  const removed = await deleteAgentAccess(env.AGENTS_DB, agentId, targetUserId);
  if (!removed) return notFound("Access not found");

  return json({ success: true });
}

async function handleListAgentAccess(request, env, agentId) {
  const payload = await requirePermission(request, env, "ai:agents");

  if (!env.AGENTS_DB) {
    return internalError("Agents database not configured");
  }

  const role = await requireAgentRole(env.AGENTS_DB, agentId, payload.sub, "viewer");
  if (!role) {
    return notFound("Agent not found");
  }

  const access = await listAgentAccess(env.AGENTS_DB, agentId);

  return json({ success: true, data: access, count: access.length });
}

// --- Teams (docs/specs/agent-teams.md) ---
// Mirrors the /v1/agents* handlers above: ai:teams is a separate RBAC
// permission from ai:agents/ai:chat (checked first, independent of any
// team_access role), and team_access follows the exact same
// owner/editor/viewer + "always >=1 owner" model as agent_access/chat_access.
// Lives in the same D1 binding as agents (AGENTS_DB) -- docs/specs/agent-teams.md:
// team_members.agent_id is a real FK within dev-agents, not a cross-database
// reference.

async function handleCreateTeam(request, env) {
  const payload = await requirePermission(request, env, "ai:teams");

  if (!env.AGENTS_DB) {
    return internalError("Agents database not configured");
  }

  const body = await request.json();
  const team = await createTeam(env.AGENTS_DB, { userId: payload.sub, ...body });

  return json(team, 201);
}

async function handleListTeams(request, env, url) {
  const payload = await requirePermission(request, env, "ai:teams");

  if (!env.AGENTS_DB) {
    return internalError("Agents database not configured");
  }

  const limit = url.searchParams.get("limit");
  const cursor = url.searchParams.get("cursor");

  const { data, next_cursor } = await listTeamsForUser(env.AGENTS_DB, payload.sub, { limit, cursor });

  return json({ object: "list", data, next_cursor });
}

// 404 (not 403) when the actor has no team_access row at all for this team --
// requireTeamRole() returns null in that case rather than throwing, so a team
// id never leaks to someone with zero access to it. Once the actor has *some*
// role, an insufficient one (e.g. viewer trying to PATCH) surfaces as 403
// instead, since they already know the team exists.
async function handleGetTeam(request, env, teamId) {
  const payload = await requirePermission(request, env, "ai:teams");

  if (!env.AGENTS_DB) {
    return internalError("Agents database not configured");
  }

  const role = await requireTeamRole(env.AGENTS_DB, teamId, payload.sub, "viewer");
  if (!role) {
    return notFound("Team not found");
  }

  const team = await getTeamById(env.AGENTS_DB, teamId);
  return json({ ...team, role });
}

async function handlePatchTeam(request, env, teamId) {
  const payload = await requirePermission(request, env, "ai:teams");

  if (!env.AGENTS_DB) {
    return internalError("Agents database not configured");
  }

  const role = await requireTeamRole(env.AGENTS_DB, teamId, payload.sub, "editor");
  if (!role) {
    return notFound("Team not found");
  }

  const body = await request.json();
  const team = await updateTeam(env.AGENTS_DB, teamId, body);
  if (!team) {
    return notFound("Team not found");
  }

  return json({ ...team, role });
}

async function handleDeleteTeam(request, env, teamId) {
  const payload = await requirePermission(request, env, "ai:teams");

  if (!env.AGENTS_DB) {
    return internalError("Agents database not configured");
  }

  const role = await requireTeamRole(env.AGENTS_DB, teamId, payload.sub, "owner");
  if (!role) {
    return notFound("Team not found");
  }

  const removed = await deleteTeam(env.AGENTS_DB, teamId);
  if (!removed) {
    return notFound("Team not found");
  }

  return json({ success: true });
}

async function handleGrantTeamAccess(request, env, teamId, targetUserId) {
  const payload = await requirePermission(request, env, "ai:teams");

  if (!env.AGENTS_DB) {
    return internalError("Agents database not configured");
  }

  const role = await requireTeamRole(env.AGENTS_DB, teamId, payload.sub, "owner");
  if (!role) {
    return notFound("Team not found");
  }

  const body = await request.json();
  const { role: newRole } = body;

  const access = await upsertTeamAccess(env.AGENTS_DB, teamId, targetUserId, newRole);

  return json({ success: true, data: access });
}

async function handleRevokeTeamAccess(request, env, teamId, targetUserId) {
  const payload = await requirePermission(request, env, "ai:teams");

  if (!env.AGENTS_DB) {
    return internalError("Agents database not configured");
  }

  const isSelf = payload.sub === targetUserId;

  if (isSelf) {
    const team = await getTeamById(env.AGENTS_DB, teamId);
    if (!team) return notFound("Team not found");
  } else {
    const role = await requireTeamRole(env.AGENTS_DB, teamId, payload.sub, "owner");
    if (!role) return notFound("Team not found");
  }

  const removed = await deleteTeamAccess(env.AGENTS_DB, teamId, targetUserId);
  if (!removed) return notFound("Access not found");

  return json({ success: true });
}

async function handleListTeamAccess(request, env, teamId) {
  const payload = await requirePermission(request, env, "ai:teams");

  if (!env.AGENTS_DB) {
    return internalError("Agents database not configured");
  }

  const role = await requireTeamRole(env.AGENTS_DB, teamId, payload.sub, "viewer");
  if (!role) {
    return notFound("Team not found");
  }

  const access = await listTeamAccess(env.AGENTS_DB, teamId);

  return json({ success: true, data: access, count: access.length });
}
