// D1 access for agents (dev-agents, binding AGENTS_DB). See
// docs/specs/agent-registration.md and agent-registration-out-of-scope.md for
// the schema and endpoint contracts this module backs. Deliberately mirrors
// chat-db.mjs's ACL model (owner/editor/viewer, "always >=1 owner" invariant,
// keyset pagination via encodeCursor/decodeCursor) adapted to agents/agent_access
// instead of chat_sessions/chat_access -- same reasoning as chat-db.mjs mirroring
// graph-db.mjs: one ACL pattern, reused per domain rather than reinvented.
import { AuthError, ConflictError } from "./auth.mjs";
import { ValidationError } from "./ai.mjs";
import { isKnownTool } from "./tools.mjs";

export { ValidationError, ConflictError };

export const ROLE_RANK = { viewer: 1, editor: 2, owner: 3 };
const VALID_ROLES = ["owner", "editor", "viewer"];

// docs/specs/agent-tool-calling.md: ceiling on model->tool->model cycles
// before a message-processing loop forces a final, tool-less answer. Applied
// in application code (not relied on as a D1 column DEFAULT) because binding
// an explicit NULL would violate the column's NOT NULL constraint.
const DEFAULT_MAX_TOOL_ITERATIONS = 5;

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function mapAgentRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    system_prompt: row.system_prompt,
    model: row.model,
    temperature: row.temperature ?? null,
    max_tokens: row.max_tokens ?? null,
    top_p: row.top_p ?? null,
    tools: row.tools ? JSON.parse(row.tools) : null,
    max_tool_iterations: row.max_tool_iterations ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(row.role !== undefined ? { role: row.role } : {}),
  };
}

// Same opaque keyset-pagination cursor format as chat-db.mjs: plain base64 of
// "<value>|<id>".
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

function validateOptionalNumber(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ValidationError(`${field} must be a number`);
  }
  return value;
}

// Array of tool names (docs/specs/agent-tool-calling.md): each one must exist
// in the fixed TOOL_CATALOG (lib/tools.mjs) or the whole request is rejected
// with 400 -- same "reject unknown values outright" approach as roles in
// upsertAgentAccess(). An absent/null value means "no tools" and is left as
// null (not []) so it round-trips through the nullable `tools` D1 column.
function validateOptionalTools(tools) {
  if (tools === undefined || tools === null) return null;
  if (!Array.isArray(tools)) {
    throw new ValidationError("tools must be an array of tool names");
  }
  for (const name of tools) {
    if (typeof name !== "string" || !isKnownTool(name)) {
      throw new ValidationError(`Unknown tool: ${name}`);
    }
  }
  return tools;
}

function validateOptionalMaxToolIterations(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new ValidationError("max_tool_iterations must be a positive integer");
  }
  return value;
}

function validateAgentFields({ name, system_prompt, model, temperature, max_tokens, top_p, tools, max_tool_iterations }) {
  if (typeof name !== "string" || !name.trim()) {
    throw new ValidationError("name is required and must be a non-empty string");
  }
  if (typeof system_prompt !== "string" || !system_prompt.trim()) {
    throw new ValidationError("system_prompt is required and must be a non-empty string");
  }
  if (typeof model !== "string" || !model.trim()) {
    throw new ValidationError("model is required and must be a non-empty string");
  }

  return {
    name,
    system_prompt,
    model,
    temperature: validateOptionalNumber(temperature, "temperature"),
    max_tokens: validateOptionalNumber(max_tokens, "max_tokens"),
    top_p: validateOptionalNumber(top_p, "top_p"),
    tools: validateOptionalTools(tools),
    max_tool_iterations: validateOptionalMaxToolIterations(max_tool_iterations),
  };
}

export async function createAgent(db, { userId, name, system_prompt, model, temperature, max_tokens, top_p, tools, max_tool_iterations }) {
  if (!db) {
    throw new Error("Database not configured");
  }

  const fields = validateAgentFields({ name, system_prompt, model, temperature, max_tokens, top_p, tools, max_tool_iterations });
  const id = crypto.randomUUID();
  const toolsJson = fields.tools ? JSON.stringify(fields.tools) : null;
  const maxToolIterations = fields.max_tool_iterations ?? DEFAULT_MAX_TOOL_ITERATIONS;

  await db
    .prepare(
      `INSERT INTO agents (id, name, system_prompt, model, temperature, max_tokens, top_p, tools, max_tool_iterations)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      fields.name,
      fields.system_prompt,
      fields.model,
      fields.temperature,
      fields.max_tokens,
      fields.top_p,
      toolsJson,
      maxToolIterations
    )
    .run();

  // The creator becomes the sole owner in agent_access -- same pattern as
  // createSession() in chat-db.mjs.
  await db
    .prepare("INSERT INTO agent_access (id, agent_id, user_id, role) VALUES (?, ?, ?, ?)")
    .bind(crypto.randomUUID(), id, userId, "owner")
    .run();

  const agent = await getAgentById(db, id);
  return { ...agent, role: "owner" };
}

export async function getAgentById(db, id) {
  if (!db) {
    throw new Error("Database not configured");
  }

  const row = await db
    .prepare(
      "SELECT id, name, system_prompt, model, temperature, max_tokens, top_p, tools, max_tool_iterations, created_at, updated_at FROM agents WHERE id = ?"
    )
    .bind(id)
    .first();

  return mapAgentRow(row);
}

// Keyset pagination ordered by updated_at desc (ties broken by id desc), same
// shape as listSessionsForUser() in chat-db.mjs.
export async function listAgentsForUser(db, userId, { limit, cursor } = {}) {
  if (!db) {
    throw new Error("Database not configured");
  }

  const pageSize = clampLimit(limit);
  const decoded = decodeCursor(cursor);
  const cursorClause = decoded ? "AND (a.updated_at < ? OR (a.updated_at = ? AND a.id < ?))" : "";

  const binds = [userId];
  if (decoded) binds.push(decoded.value, decoded.value, decoded.id);
  binds.push(pageSize + 1);

  const results = await db
    .prepare(
      `SELECT a.id, a.name, a.system_prompt, a.model, a.temperature, a.max_tokens, a.top_p, a.tools, a.max_tool_iterations, a.created_at, a.updated_at, aa.role
       FROM agents a
       JOIN agent_access aa ON aa.agent_id = a.id
       WHERE aa.user_id = ? ${cursorClause}
       ORDER BY a.updated_at DESC, a.id DESC
       LIMIT ?`
    )
    .bind(...binds)
    .all();

  const rows = results.results || [];
  const hasMore = rows.length > pageSize;
  const page = rows.slice(0, pageSize);
  const last = page[page.length - 1];

  return {
    data: page.map(mapAgentRow),
    next_cursor: hasMore && last ? encodeCursor(last.updated_at, last.id) : null,
  };
}

// Partial update: fetches the existing row first and merges in only the
// fields present in `updates`, then overwrites the row wholesale -- avoids a
// dynamic SET clause (keeps the query shape fixed and easy to mock in tests,
// same reasoning as touchSession()'s COALESCE trick in chat-db.mjs, but done
// in JS here since unlike touchSession this needs per-field validation).
export async function updateAgent(db, id, updates) {
  if (!db) {
    throw new Error("Database not configured");
  }

  const existing = await getAgentById(db, id);
  if (!existing) {
    return null;
  }

  const merged = validateAgentFields({
    name: updates.name !== undefined ? updates.name : existing.name,
    system_prompt: updates.system_prompt !== undefined ? updates.system_prompt : existing.system_prompt,
    model: updates.model !== undefined ? updates.model : existing.model,
    temperature: updates.temperature !== undefined ? updates.temperature : existing.temperature,
    max_tokens: updates.max_tokens !== undefined ? updates.max_tokens : existing.max_tokens,
    top_p: updates.top_p !== undefined ? updates.top_p : existing.top_p,
    tools: updates.tools !== undefined ? updates.tools : existing.tools,
    max_tool_iterations: updates.max_tool_iterations !== undefined ? updates.max_tool_iterations : existing.max_tool_iterations,
  });
  const toolsJson = merged.tools ? JSON.stringify(merged.tools) : null;
  const maxToolIterations = merged.max_tool_iterations ?? DEFAULT_MAX_TOOL_ITERATIONS;

  await db
    .prepare(
      `UPDATE agents SET name = ?, system_prompt = ?, model = ?, temperature = ?, max_tokens = ?, top_p = ?, tools = ?, max_tool_iterations = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    )
    .bind(
      merged.name,
      merged.system_prompt,
      merged.model,
      merged.temperature,
      merged.max_tokens,
      merged.top_p,
      toolsJson,
      maxToolIterations,
      id
    )
    .run();

  return getAgentById(db, id);
}

// Cascade to agent_access is declared at the schema level (ON DELETE CASCADE,
// migration 0016) -- no manual cleanup needed here. Authorization (must be an
// owner) is enforced by the caller via requireRole() before this runs; this
// function only checks existence.
export async function deleteAgent(db, id) {
  if (!db) {
    throw new Error("Database not configured");
  }

  const existing = await getAgentById(db, id);
  if (!existing) {
    return false;
  }

  await db.prepare("DELETE FROM agents WHERE id = ?").bind(id).run();
  return true;
}

export async function getAgentAccess(db, agentId, userId) {
  if (!db) {
    throw new Error("Database not configured");
  }

  const row = await db
    .prepare("SELECT role FROM agent_access WHERE agent_id = ? AND user_id = ?")
    .bind(agentId, userId)
    .first();

  return row?.role ?? null;
}

// Same two-case split as chat-db.mjs's requireRole(): returns null when the
// actor has no agent_access row at all (caller turns that into a 404, so an
// agent id never leaks to someone with zero access to it), and only throws
// AuthError(403) when the actor has a role but it's below minRole.
export async function requireRole(db, agentId, actorSub, minRole) {
  const role = await getAgentAccess(db, agentId, actorSub);
  if (!role) {
    return null;
  }
  if (ROLE_RANK[role] < ROLE_RANK[minRole]) {
    throw new AuthError(403, "Insufficient role for this agent");
  }
  return role;
}

export async function listAgentAccess(db, agentId) {
  if (!db) {
    throw new Error("Database not configured");
  }

  const results = await db
    .prepare("SELECT user_id, role, created_at FROM agent_access WHERE agent_id = ? ORDER BY created_at")
    .bind(agentId)
    .all();

  return (results.results || []).map((row) => ({
    user_id: row.user_id,
    role: row.role,
    created_at: row.created_at,
  }));
}

async function countOwners(db, agentId) {
  const access = await listAgentAccess(db, agentId);
  return access.filter((a) => a.role === "owner").length;
}

// Shared invariant: an agent can never end up with zero owners. Used by both
// the PUT downgrade path and both DELETE paths (self-removal and removal by
// another owner) so the rule is enforced identically everywhere.
async function assertNotLastOwner(db, agentId, currentRole, keepsOwnerRole) {
  if (currentRole !== "owner" || keepsOwnerRole) {
    return;
  }

  const owners = await countOwners(db, agentId);
  if (owners <= 1) {
    throw new ConflictError("Agent must have at least one owner");
  }
}

export async function upsertAgentAccess(db, agentId, userId, role) {
  if (!db) {
    throw new Error("Database not configured");
  }

  if (!VALID_ROLES.includes(role)) {
    throw new ValidationError(`Invalid role: must be one of ${VALID_ROLES.join(", ")}`);
  }

  const currentRole = await getAgentAccess(db, agentId, userId);

  await assertNotLastOwner(db, agentId, currentRole, role === "owner");

  if (currentRole) {
    await db
      .prepare("UPDATE agent_access SET role = ? WHERE agent_id = ? AND user_id = ?")
      .bind(role, agentId, userId)
      .run();
  } else {
    await db
      .prepare("INSERT INTO agent_access (id, agent_id, user_id, role) VALUES (?, ?, ?, ?)")
      .bind(crypto.randomUUID(), agentId, userId, role)
      .run();
  }

  return { agent_id: agentId, user_id: userId, role };
}

export async function deleteAgentAccess(db, agentId, userId) {
  if (!db) {
    throw new Error("Database not configured");
  }

  const currentRole = await getAgentAccess(db, agentId, userId);
  if (!currentRole) {
    return false;
  }

  await assertNotLastOwner(db, agentId, currentRole, false);

  await db.prepare("DELETE FROM agent_access WHERE agent_id = ? AND user_id = ?").bind(agentId, userId).run();

  return true;
}
