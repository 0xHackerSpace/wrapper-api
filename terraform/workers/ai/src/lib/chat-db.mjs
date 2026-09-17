// D1 access for chat sessions (dev-chat, binding CHAT_DB). See
// docs/specs/chat-sessions.md and docs/specs/chat-sessions-sharing-and-pagination.md
// for the schema and endpoint contracts this module backs. Reuses ai.mjs's
// ValidationError instead of declaring a second one, mirroring how
// graph-db.mjs reuses AuthError from auth.mjs within the same worker.
// ConflictError, ROLE_RANK, requireRole() and the access CRUD helpers below
// mirror graph-db.mjs's ACL model (owner/editor/viewer, "always >=1 owner"
// invariant) adapted to chat_access instead of graph_access.
import { AuthError, ConflictError } from "./auth.mjs";
import { ValidationError } from "./ai.mjs";

export { ValidationError, ConflictError };

export const ROLE_RANK = { viewer: 1, editor: 2, owner: 3 };
const VALID_ROLES = ["owner", "editor", "viewer"];

const CONTEXT_WINDOW_SIZE = 20;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const MANUAL_TITLE_MAX_LENGTH = 200;

function mapSessionRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    user_id: row.user_id,
    title: row.title ?? null,
    agent_id: row.agent_id ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(row.role !== undefined ? { role: row.role } : {}),
  };
}

function mapMessageRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    session_id: row.session_id,
    role: row.role,
    content: row.content,
    created_at: row.created_at,
  };
}

// Opaque keyset-pagination cursor: plain base64 of "<value>|<id>" (not
// base64url -- docs/specs/chat-sessions-sharing-and-pagination.md just says
// "base64", unlike jwt.mjs which needs the url-safe variant for URLs).
function encodeCursor(value, id) {
  return btoa(`${value}|${id}`);
}

function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const decoded = atob(cursor);
    const separatorIndex = decoded.lastIndexOf("|");
    if (separatorIndex === -1) return null;
    return { value: decoded.slice(0, separatorIndex), id: decoded.slice(separatorIndex + 1) };
  } catch {
    return null;
  }
}

function clampLimit(limit) {
  const parsed = Number(limit);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.min(MAX_PAGE_SIZE, Math.trunc(parsed));
}

// agentSnapshot, when present, is copied verbatim into the new row's
// agent_* columns (docs/specs/agent-registration.md) -- the caller
// (index.mjs's handleCreateSession) is responsible for resolving and
// authorizing the agent via agent-db.mjs *before* calling this; createSession
// itself never touches AGENTS_DB.
export async function createSession(db, { userId, agentSnapshot = null }) {
  if (!db) {
    throw new Error("Database not configured");
  }

  const id = crypto.randomUUID();
  const agentId = agentSnapshot?.agentId ?? null;
  const agentSystemPrompt = agentSnapshot?.systemPrompt ?? null;
  const agentModel = agentSnapshot?.model ?? null;
  const agentTemperature = agentSnapshot?.temperature ?? null;
  const agentMaxTokens = agentSnapshot?.maxTokens ?? null;
  const agentTopP = agentSnapshot?.topP ?? null;
  const agentTools =
    agentSnapshot?.tools && agentSnapshot.tools.length > 0 ? JSON.stringify(agentSnapshot.tools) : null;
  const agentMaxToolIterations = agentSnapshot?.maxToolIterations ?? null;

  await db
    .prepare(
      `INSERT INTO chat_sessions (id, user_id, agent_id, agent_system_prompt, agent_model, agent_temperature, agent_max_tokens, agent_top_p, agent_tools, agent_max_tool_iterations)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      userId,
      agentId,
      agentSystemPrompt,
      agentModel,
      agentTemperature,
      agentMaxTokens,
      agentTopP,
      agentTools,
      agentMaxToolIterations
    )
    .run();

  // The creator becomes the sole owner in chat_access -- same pattern as
  // createGraph() in graph-db.mjs. D1's HTTP API has no real multi-statement
  // transaction anyway, so this stays two sequential .run() calls rather than
  // reaching for .batch() (no other worker in this repo uses .batch() either).
  await db
    .prepare("INSERT INTO chat_access (id, session_id, user_id, role) VALUES (?, ?, ?, ?)")
    .bind(crypto.randomUUID(), id, userId, "owner")
    .run();

  const session = await getSessionById(db, id);
  return { ...session, role: "owner" };
}

export async function getSessionById(db, id) {
  if (!db) {
    throw new Error("Database not configured");
  }

  const row = await db
    .prepare("SELECT id, user_id, title, agent_id, created_at, updated_at FROM chat_sessions WHERE id = ?")
    .bind(id)
    .first();

  return mapSessionRow(row);
}

// Read-only accessor for the agent_* snapshot columns, used exclusively by
// POST /v1/sessions/:id/messages to build the Workers AI call -- deliberately
// separate from getSessionById()/mapSessionRow() so the raw system prompt
// snapshot never leaks into the public session JSON (which only exposes
// agent_id, mirroring how chat_access roles are surfaced but access details
// aren't inlined into the session either). Never re-reads AGENTS_DB: once
// copied at session-creation time, the snapshot lives entirely in chat_sessions.
export async function getSessionAgentConfig(db, id) {
  if (!db) {
    throw new Error("Database not configured");
  }

  const row = await db
    .prepare(
      "SELECT agent_system_prompt, agent_model, agent_temperature, agent_max_tokens, agent_top_p, agent_tools, agent_max_tool_iterations FROM chat_sessions WHERE id = ?"
    )
    .bind(id)
    .first();

  if (!row) return null;

  return {
    systemPrompt: row.agent_system_prompt ?? null,
    model: row.agent_model ?? null,
    temperature: row.agent_temperature ?? null,
    maxTokens: row.agent_max_tokens ?? null,
    topP: row.agent_top_p ?? null,
    tools: row.agent_tools ? JSON.parse(row.agent_tools) : null,
    maxToolIterations: row.agent_max_tool_iterations ?? null,
  };
}

// Keyset pagination ordered by updated_at desc (ties broken by id desc so the
// cursor is stable even when two sessions share a timestamp). Fetches one
// extra row to detect whether there is a next page without a separate COUNT.
export async function listSessionsForUser(db, userId, { limit, cursor } = {}) {
  if (!db) {
    throw new Error("Database not configured");
  }

  const pageSize = clampLimit(limit);
  const decoded = decodeCursor(cursor);
  const cursorClause = decoded ? "AND (cs.updated_at < ? OR (cs.updated_at = ? AND cs.id < ?))" : "";

  const binds = [userId];
  if (decoded) binds.push(decoded.value, decoded.value, decoded.id);
  binds.push(pageSize + 1);

  const results = await db
    .prepare(
      `SELECT cs.id, cs.user_id, cs.title, cs.agent_id, cs.created_at, cs.updated_at, ca.role
       FROM chat_sessions cs
       JOIN chat_access ca ON ca.session_id = cs.id
       WHERE ca.user_id = ? ${cursorClause}
       ORDER BY cs.updated_at DESC, cs.id DESC
       LIMIT ?`
    )
    .bind(...binds)
    .all();

  const rows = results.results || [];
  const hasMore = rows.length > pageSize;
  const page = rows.slice(0, pageSize);
  const last = page[page.length - 1];

  return {
    data: page.map(mapSessionRow),
    next_cursor: hasMore && last ? encodeCursor(last.updated_at, last.id) : null,
  };
}

// Keyset pagination ordered by created_at asc (ties broken by id asc), used
// by GET /v1/sessions/:id/messages. Persisted messages are never dropped;
// only the context sent to the model is windowed (see listRecentMessages).
export async function listMessagesPage(db, sessionId, { limit, cursor } = {}) {
  if (!db) {
    throw new Error("Database not configured");
  }

  const pageSize = clampLimit(limit);
  const decoded = decodeCursor(cursor);
  const cursorClause = decoded ? "AND (cm.created_at > ? OR (cm.created_at = ? AND cm.id > ?))" : "";

  const binds = [sessionId];
  if (decoded) binds.push(decoded.value, decoded.value, decoded.id);
  binds.push(pageSize + 1);

  const results = await db
    .prepare(
      `SELECT cm.id, cm.session_id, cm.role, cm.content, cm.created_at
       FROM chat_messages cm
       WHERE cm.session_id = ? ${cursorClause}
       ORDER BY cm.created_at ASC, cm.id ASC
       LIMIT ?`
    )
    .bind(...binds)
    .all();

  const rows = results.results || [];
  const hasMore = rows.length > pageSize;
  const page = rows.slice(0, pageSize);
  const last = page[page.length - 1];

  return {
    data: page.map(mapMessageRow),
    next_cursor: hasMore && last ? encodeCursor(last.created_at, last.id) : null,
  };
}

// Context window for AI.run(): last N messages (default 20, i.e. 10
// exchanges), oldest first. Fetched DESC + LIMIT then reversed so the query
// only ever has to scan the tail of a long session, not the whole table.
export async function listRecentMessages(db, sessionId, limit = CONTEXT_WINDOW_SIZE) {
  if (!db) {
    throw new Error("Database not configured");
  }

  const results = await db
    .prepare("SELECT id, session_id, role, content, created_at FROM chat_messages WHERE session_id = ? ORDER BY created_at DESC LIMIT ?")
    .bind(sessionId, limit)
    .all();

  return (results.results || []).map(mapMessageRow).reverse();
}

export async function addMessage(db, { sessionId, role, content }) {
  if (!db) {
    throw new Error("Database not configured");
  }

  const id = crypto.randomUUID();

  await db
    .prepare("INSERT INTO chat_messages (id, session_id, role, content) VALUES (?, ?, ?, ?)")
    .bind(id, sessionId, role, content)
    .run();

  const row = await db
    .prepare("SELECT id, session_id, role, content, created_at FROM chat_messages WHERE id = ?")
    .bind(id)
    .first();

  return mapMessageRow(row);
}

// Bumps updated_at (so GET /v1/sessions can order by recent activity) and
// fills title only if it is still null -- COALESCE keeps whatever title
// already exists, so this is safe to call after every message unconditionally.
export async function touchSession(db, id, { title } = {}) {
  if (!db) {
    throw new Error("Database not configured");
  }

  await db
    .prepare("UPDATE chat_sessions SET updated_at = CURRENT_TIMESTAMP, title = COALESCE(title, ?) WHERE id = ?")
    .bind(title ?? null, id)
    .run();
}

// Explicit rename (PATCH /v1/sessions/:id), distinct from touchSession's
// auto-fill-if-null behavior: this always overwrites the title, and enforces
// the more generous 200-char cap (vs the 50-char auto-truncation of the
// first message) since it's an explicit user choice.
export async function renameSession(db, id, title) {
  if (!db) {
    throw new Error("Database not configured");
  }

  if (typeof title !== "string" || !title.trim()) {
    throw new ValidationError("title is required and must be a non-empty string");
  }
  if (title.length > MANUAL_TITLE_MAX_LENGTH) {
    throw new ValidationError(`title must be at most ${MANUAL_TITLE_MAX_LENGTH} characters`);
  }

  await db
    .prepare("UPDATE chat_sessions SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(title, id)
    .run();

  return getSessionById(db, id);
}

// Cascade to chat_messages and chat_access is declared at the schema level
// (ON DELETE CASCADE, migrations 0014 and 0015) -- no manual cleanup needed
// here. Authorization (must be an owner) is enforced by the caller via
// requireRole() before this runs; this function only checks existence.
export async function deleteSession(db, id) {
  if (!db) {
    throw new Error("Database not configured");
  }

  const existing = await getSessionById(db, id);
  if (!existing) {
    return false;
  }

  await db.prepare("DELETE FROM chat_sessions WHERE id = ?").bind(id).run();
  return true;
}

export async function getChatAccess(db, sessionId, userId) {
  if (!db) {
    throw new Error("Database not configured");
  }

  const row = await db
    .prepare("SELECT role FROM chat_access WHERE session_id = ? AND user_id = ?")
    .bind(sessionId, userId)
    .first();

  return row?.role ?? null;
}

// Core per-session ACL check (owner/editor/viewer). Unlike graph-db.mjs's
// requireRole() (which always throws 403 when access is missing or too low),
// this distinguishes the two cases on purpose: returns null when the actor
// has no chat_access row at all (caller turns that into a 404, so a session
// id never leaks to someone with zero access to it -- same reasoning as the
// original getSessionForUser()), and only throws AuthError(403) when the
// actor does have a role but it's below minRole (they already know the
// session exists, so 403 doesn't leak anything new).
export async function requireRole(db, sessionId, actorSub, minRole) {
  const role = await getChatAccess(db, sessionId, actorSub);
  if (!role) {
    return null;
  }
  if (ROLE_RANK[role] < ROLE_RANK[minRole]) {
    throw new AuthError(403, "Insufficient role for this session");
  }
  return role;
}

export async function listChatAccess(db, sessionId) {
  if (!db) {
    throw new Error("Database not configured");
  }

  const results = await db
    .prepare("SELECT user_id, role, created_at FROM chat_access WHERE session_id = ? ORDER BY created_at")
    .bind(sessionId)
    .all();

  return (results.results || []).map((row) => ({
    user_id: row.user_id,
    role: row.role,
    created_at: row.created_at,
  }));
}

async function countOwners(db, sessionId) {
  const access = await listChatAccess(db, sessionId);
  return access.filter((a) => a.role === "owner").length;
}

// Shared invariant: a session can never end up with zero owners. Used by
// both the PUT downgrade path and both DELETE paths (self-removal and
// removal by another owner) so the rule is enforced identically everywhere.
async function assertNotLastOwner(db, sessionId, currentRole, keepsOwnerRole) {
  if (currentRole !== "owner" || keepsOwnerRole) {
    return;
  }

  const owners = await countOwners(db, sessionId);
  if (owners <= 1) {
    throw new ConflictError("Session must have at least one owner");
  }
}

export async function upsertChatAccess(db, sessionId, userId, role) {
  if (!db) {
    throw new Error("Database not configured");
  }

  if (!VALID_ROLES.includes(role)) {
    throw new ValidationError(`Invalid role: must be one of ${VALID_ROLES.join(", ")}`);
  }

  const currentRole = await getChatAccess(db, sessionId, userId);

  await assertNotLastOwner(db, sessionId, currentRole, role === "owner");

  if (currentRole) {
    await db
      .prepare("UPDATE chat_access SET role = ? WHERE session_id = ? AND user_id = ?")
      .bind(role, sessionId, userId)
      .run();
  } else {
    await db
      .prepare("INSERT INTO chat_access (id, session_id, user_id, role) VALUES (?, ?, ?, ?)")
      .bind(crypto.randomUUID(), sessionId, userId, role)
      .run();
  }

  return { session_id: sessionId, user_id: userId, role };
}

export async function deleteChatAccess(db, sessionId, userId) {
  if (!db) {
    throw new Error("Database not configured");
  }

  const currentRole = await getChatAccess(db, sessionId, userId);
  if (!currentRole) {
    return false;
  }

  await assertNotLastOwner(db, sessionId, currentRole, false);

  await db
    .prepare("DELETE FROM chat_access WHERE session_id = ? AND user_id = ?")
    .bind(sessionId, userId)
    .run();

  return true;
}
