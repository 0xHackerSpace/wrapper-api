// D1 access for agent teams (dev-agents, binding AGENTS_DB -- same D1 as
// agents, see docs/specs/agent-teams.md). Mirrors agent-db.mjs's shape
// (ROLE_RANK, ConflictError/AuthError imported from auth.mjs, requireRole()
// returning null vs throwing 403, keyset pagination via
// encodeCursor/decodeCursor) adapted to agent_teams/team_members/team_access
// instead of agents/agent_access -- same "one ACL pattern reused per domain"
// reasoning agent-db.mjs itself already documents.
//
// Field names on the public API (createTeam/updateTeam's `updates` and the
// mapped team objects) are snake_case, matching the JSON request body
// directly -- same convention as agent-db.mjs's system_prompt/
// max_tool_iterations, since index.mjs spreads `...body` straight into
// createTeam/updateTeam without a camelCase translation layer.
import { AuthError, ConflictError } from "./auth.mjs";
import { ValidationError } from "./ai.mjs";

export { ValidationError, ConflictError };

export const ROLE_RANK = { viewer: 1, editor: 2, owner: 3 };
const VALID_ROLES = ["owner", "editor", "viewer"];

const VALID_MODES = ["pipeline", "debate", "orchestrator"];
const VALID_TERMINATION_STRATEGIES = ["fixed_rounds", "moderator"];

// docs/specs/agent-teams.md, "orchestrator": teto de segurança default
// quando orchestration_mode = 'orchestrator' e max_orchestrator_steps é
// omitido. Applied in application code (not a D1 column DEFAULT) for the
// same reason agent-db.mjs applies DEFAULT_MAX_TOOL_ITERATIONS in code: an
// explicit NULL bound for another mode still has to satisfy this column's
// nullability rules cleanly.
const DEFAULT_MAX_ORCHESTRATOR_STEPS = 10;

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

// `members`, when provided (getTeamById's detail view), is included as-is;
// omitted entirely (not defaulted to []) for list rows, where fetching each
// team's members would mean an extra query per row -- docs/specs/agent-teams.md
// doesn't require the members array in the list response, only the detail one.
function mapTeamRow(row, members) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    orchestration_mode: row.orchestration_mode,
    lead_agent_id: row.lead_agent_id ?? null,
    rounds: row.rounds ?? null,
    termination_strategy: row.termination_strategy ?? null,
    max_orchestrator_steps: row.max_orchestrator_steps ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(members !== undefined ? { members } : {}),
    ...(row.role !== undefined ? { role: row.role } : {}),
  };
}

// Same opaque keyset-pagination cursor format as agent-db.mjs/chat-db.mjs:
// plain base64 of "<value>|<id>".
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

// Normalizes + validates `members` (required, non-empty): each entry needs a
// non-empty agent_id; order_index defaults to the entry's position in the
// array when omitted (docs/specs/agent-teams.md: "ignorado (mas preenchido)
// em orchestrator" -- every member always gets an order_index, even when the
// mode doesn't use it for sequencing). Duplicate agent_id across members is
// rejected here too, ahead of the schema's UNIQUE(team_id, agent_id), so the
// error comes back as a clean 400 instead of a raw D1 constraint failure.
function validateMembers(members) {
  if (!Array.isArray(members) || members.length === 0) {
    throw new ValidationError("members is required and must be a non-empty array");
  }

  const normalized = members.map((member, index) => {
    if (!member || typeof member.agent_id !== "string" || !member.agent_id.trim()) {
      throw new ValidationError("each member requires a non-empty agent_id");
    }
    const orderIndex = member.order_index !== undefined && member.order_index !== null ? member.order_index : index;
    if (typeof orderIndex !== "number" || !Number.isInteger(orderIndex)) {
      throw new ValidationError("order_index must be an integer");
    }
    return { agent_id: member.agent_id, order_index: orderIndex };
  });

  const agentIds = normalized.map((m) => m.agent_id);
  if (new Set(agentIds).size !== agentIds.length) {
    throw new ValidationError("members must not contain duplicate agent_id values");
  }

  return normalized;
}

// docs/specs/agent-teams.md, "Decisões de baixo nível": per-mode validation
// of lead_agent_id/rounds/termination_strategy/max_orchestrator_steps, plus
// the "lead_agent_id must be one of team_members" invariant that applies to
// every mode that has one. Used identically by createTeam (against the raw
// input) and updateTeam (against the merged existing+updates view), same
// pattern as agent-db.mjs's validateAgentFields().
function validateTeamFields({ name, orchestration_mode, lead_agent_id, rounds, termination_strategy, max_orchestrator_steps, members }) {
  if (typeof name !== "string" || !name.trim()) {
    throw new ValidationError("name is required and must be a non-empty string");
  }
  if (!VALID_MODES.includes(orchestration_mode)) {
    throw new ValidationError(`orchestration_mode must be one of ${VALID_MODES.join(", ")}`);
  }

  const normalizedMembers = validateMembers(members);
  const agentIds = normalizedMembers.map((m) => m.agent_id);

  let leadAgentId = null;
  let roundsValue = null;
  let terminationStrategyValue = null;
  let maxOrchestratorStepsValue = null;

  if (orchestration_mode === "pipeline") {
    if (lead_agent_id !== undefined && lead_agent_id !== null) {
      throw new ValidationError("lead_agent_id is not allowed for orchestration_mode 'pipeline'");
    }
    if (rounds !== undefined && rounds !== null) {
      throw new ValidationError("rounds is not allowed for orchestration_mode 'pipeline'");
    }
    if (termination_strategy !== undefined && termination_strategy !== null) {
      throw new ValidationError("termination_strategy is not allowed for orchestration_mode 'pipeline'");
    }
    if (max_orchestrator_steps !== undefined && max_orchestrator_steps !== null) {
      throw new ValidationError("max_orchestrator_steps is not allowed for orchestration_mode 'pipeline'");
    }
  } else if (orchestration_mode === "debate") {
    if (typeof lead_agent_id !== "string" || !lead_agent_id.trim()) {
      throw new ValidationError("lead_agent_id is required for orchestration_mode 'debate'");
    }
    if (typeof rounds !== "number" || !Number.isInteger(rounds) || rounds <= 0) {
      throw new ValidationError("rounds is required and must be a positive integer for orchestration_mode 'debate'");
    }
    if (!VALID_TERMINATION_STRATEGIES.includes(termination_strategy)) {
      throw new ValidationError(`termination_strategy is required and must be one of ${VALID_TERMINATION_STRATEGIES.join(", ")} for orchestration_mode 'debate'`);
    }
    if (max_orchestrator_steps !== undefined && max_orchestrator_steps !== null) {
      throw new ValidationError("max_orchestrator_steps is not allowed for orchestration_mode 'debate'");
    }
    leadAgentId = lead_agent_id;
    roundsValue = rounds;
    terminationStrategyValue = termination_strategy;
  } else {
    // orchestrator
    if (typeof lead_agent_id !== "string" || !lead_agent_id.trim()) {
      throw new ValidationError("lead_agent_id is required for orchestration_mode 'orchestrator'");
    }
    if (rounds !== undefined && rounds !== null) {
      throw new ValidationError("rounds is not allowed for orchestration_mode 'orchestrator'");
    }
    if (termination_strategy !== undefined && termination_strategy !== null) {
      throw new ValidationError("termination_strategy is not allowed for orchestration_mode 'orchestrator'");
    }
    leadAgentId = lead_agent_id;
    maxOrchestratorStepsValue = max_orchestrator_steps ?? DEFAULT_MAX_ORCHESTRATOR_STEPS;
    if (typeof maxOrchestratorStepsValue !== "number" || !Number.isInteger(maxOrchestratorStepsValue) || maxOrchestratorStepsValue <= 0) {
      throw new ValidationError("max_orchestrator_steps must be a positive integer");
    }
  }

  if (leadAgentId !== null && !agentIds.includes(leadAgentId)) {
    throw new ValidationError("lead_agent_id must be one of the team's members");
  }

  return {
    name,
    orchestration_mode,
    lead_agent_id: leadAgentId,
    rounds: roundsValue,
    termination_strategy: terminationStrategyValue,
    max_orchestrator_steps: maxOrchestratorStepsValue,
    members: normalizedMembers,
  };
}

async function insertTeamMembers(db, teamId, members) {
  for (const member of members) {
    await db
      .prepare("INSERT INTO team_members (id, team_id, agent_id, order_index) VALUES (?, ?, ?, ?)")
      .bind(crypto.randomUUID(), teamId, member.agent_id, member.order_index)
      .run();
  }
}

export async function createTeam(db, { userId, name, orchestration_mode, lead_agent_id, rounds, termination_strategy, max_orchestrator_steps, members }) {
  if (!db) {
    throw new Error("Database not configured");
  }

  const fields = validateTeamFields({ name, orchestration_mode, lead_agent_id, rounds, termination_strategy, max_orchestrator_steps, members });
  const id = crypto.randomUUID();

  await db
    .prepare(
      `INSERT INTO agent_teams (id, name, orchestration_mode, lead_agent_id, rounds, termination_strategy, max_orchestrator_steps)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(id, fields.name, fields.orchestration_mode, fields.lead_agent_id, fields.rounds, fields.termination_strategy, fields.max_orchestrator_steps)
    .run();

  await insertTeamMembers(db, id, fields.members);

  // The creator becomes the sole owner in team_access -- same pattern as
  // createAgent()/createSession().
  await db
    .prepare("INSERT INTO team_access (id, team_id, user_id, role) VALUES (?, ?, ?, ?)")
    .bind(crypto.randomUUID(), id, userId, "owner")
    .run();

  const team = await getTeamById(db, id);
  return { ...team, role: "owner" };
}

export async function getTeamById(db, id) {
  if (!db) {
    throw new Error("Database not configured");
  }

  const row = await db
    .prepare(
      "SELECT id, name, orchestration_mode, lead_agent_id, rounds, termination_strategy, max_orchestrator_steps, created_at, updated_at FROM agent_teams WHERE id = ?"
    )
    .bind(id)
    .first();

  if (!row) return null;

  const membersResult = await db
    .prepare("SELECT agent_id, order_index FROM team_members WHERE team_id = ? ORDER BY order_index ASC")
    .bind(id)
    .all();

  const members = (membersResult.results || []).map((m) => ({ agent_id: m.agent_id, order_index: m.order_index }));

  return mapTeamRow(row, members);
}

// Keyset pagination ordered by updated_at desc (ties broken by id desc), same
// shape as listAgentsForUser() in agent-db.mjs. Deliberately omits `members`
// (see mapTeamRow's comment) -- callers needing the full member list use
// GET /v1/teams/:id.
export async function listTeamsForUser(db, userId, { limit, cursor } = {}) {
  if (!db) {
    throw new Error("Database not configured");
  }

  const pageSize = clampLimit(limit);
  const decoded = decodeCursor(cursor);
  const cursorClause = decoded ? "AND (t.updated_at < ? OR (t.updated_at = ? AND t.id < ?))" : "";

  const binds = [userId];
  if (decoded) binds.push(decoded.value, decoded.value, decoded.id);
  binds.push(pageSize + 1);

  const results = await db
    .prepare(
      `SELECT t.id, t.name, t.orchestration_mode, t.lead_agent_id, t.rounds, t.termination_strategy, t.max_orchestrator_steps, t.created_at, t.updated_at, ta.role
       FROM agent_teams t
       JOIN team_access ta ON ta.team_id = t.id
       WHERE ta.user_id = ? ${cursorClause}
       ORDER BY t.updated_at DESC, t.id DESC
       LIMIT ?`
    )
    .bind(...binds)
    .all();

  const rows = results.results || [];
  const hasMore = rows.length > pageSize;
  const page = rows.slice(0, pageSize);
  const last = page[page.length - 1];

  return {
    data: page.map((row) => mapTeamRow(row)),
    next_cursor: hasMore && last ? encodeCursor(last.updated_at, last.id) : null,
  };
}

// Partial update: fetches the existing team (fields + members) first and
// merges in only what's present in `updates`, then revalidates the merged
// result against the exact same per-mode rules as createTeam -- same
// "merge then fully revalidate" approach as agent-db.mjs's updateAgent().
// When `updates.members` is omitted, the existing members list is reused
// as-is for revalidation (so e.g. changing orchestration_mode without
// resupplying members still gets checked against who's actually a member);
// members are only replaced (delete+insert) in D1 when the caller actually
// sends a new list.
export async function updateTeam(db, id, updates) {
  if (!db) {
    throw new Error("Database not configured");
  }

  const existing = await getTeamById(db, id);
  if (!existing) {
    return null;
  }

  const merged = validateTeamFields({
    name: updates.name !== undefined ? updates.name : existing.name,
    orchestration_mode: updates.orchestration_mode !== undefined ? updates.orchestration_mode : existing.orchestration_mode,
    lead_agent_id: updates.lead_agent_id !== undefined ? updates.lead_agent_id : existing.lead_agent_id,
    rounds: updates.rounds !== undefined ? updates.rounds : existing.rounds,
    termination_strategy: updates.termination_strategy !== undefined ? updates.termination_strategy : existing.termination_strategy,
    max_orchestrator_steps: updates.max_orchestrator_steps !== undefined ? updates.max_orchestrator_steps : existing.max_orchestrator_steps,
    members: updates.members !== undefined ? updates.members : existing.members,
  });

  await db
    .prepare(
      `UPDATE agent_teams SET name = ?, orchestration_mode = ?, lead_agent_id = ?, rounds = ?, termination_strategy = ?, max_orchestrator_steps = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    )
    .bind(merged.name, merged.orchestration_mode, merged.lead_agent_id, merged.rounds, merged.termination_strategy, merged.max_orchestrator_steps, id)
    .run();

  if (updates.members !== undefined) {
    await db.prepare("DELETE FROM team_members WHERE team_id = ?").bind(id).run();
    await insertTeamMembers(db, id, merged.members);
  }

  return getTeamById(db, id);
}

// Cascade to team_members and team_access is declared at the schema level
// (ON DELETE CASCADE, migration 0023) -- no manual cleanup needed here.
// Authorization (must be an owner) is enforced by the caller via
// requireRole() before this runs; this function only checks existence.
// Does not touch the member agents themselves (docs/specs/agent-teams.md:
// deleting a team never deletes its agents).
export async function deleteTeam(db, id) {
  if (!db) {
    throw new Error("Database not configured");
  }

  const existing = await getTeamById(db, id);
  if (!existing) {
    return false;
  }

  await db.prepare("DELETE FROM agent_teams WHERE id = ?").bind(id).run();
  return true;
}

export async function getTeamAccess(db, teamId, userId) {
  if (!db) {
    throw new Error("Database not configured");
  }

  const row = await db
    .prepare("SELECT role FROM team_access WHERE team_id = ? AND user_id = ?")
    .bind(teamId, userId)
    .first();

  return row?.role ?? null;
}

// Same two-case split as agent-db.mjs/chat-db.mjs's requireRole(): returns
// null when the actor has no team_access row at all (caller turns that into
// a 404, so a team id never leaks to someone with zero access to it), and
// only throws AuthError(403) when the actor has a role but it's below
// minRole.
export async function requireRole(db, teamId, actorSub, minRole) {
  const role = await getTeamAccess(db, teamId, actorSub);
  if (!role) {
    return null;
  }
  if (ROLE_RANK[role] < ROLE_RANK[minRole]) {
    throw new AuthError(403, "Insufficient role for this team");
  }
  return role;
}

export async function listTeamAccess(db, teamId) {
  if (!db) {
    throw new Error("Database not configured");
  }

  const results = await db
    .prepare("SELECT user_id, role, created_at FROM team_access WHERE team_id = ? ORDER BY created_at")
    .bind(teamId)
    .all();

  return (results.results || []).map((row) => ({
    user_id: row.user_id,
    role: row.role,
    created_at: row.created_at,
  }));
}

async function countOwners(db, teamId) {
  const access = await listTeamAccess(db, teamId);
  return access.filter((a) => a.role === "owner").length;
}

// Shared invariant: a team can never end up with zero owners. Used by both
// the PUT downgrade path and both DELETE paths (self-removal and removal by
// another owner) so the rule is enforced identically everywhere.
async function assertNotLastOwner(db, teamId, currentRole, keepsOwnerRole) {
  if (currentRole !== "owner" || keepsOwnerRole) {
    return;
  }

  const owners = await countOwners(db, teamId);
  if (owners <= 1) {
    throw new ConflictError("Team must have at least one owner");
  }
}

export async function upsertTeamAccess(db, teamId, userId, role) {
  if (!db) {
    throw new Error("Database not configured");
  }

  if (!VALID_ROLES.includes(role)) {
    throw new ValidationError(`Invalid role: must be one of ${VALID_ROLES.join(", ")}`);
  }

  const currentRole = await getTeamAccess(db, teamId, userId);

  await assertNotLastOwner(db, teamId, currentRole, role === "owner");

  if (currentRole) {
    await db
      .prepare("UPDATE team_access SET role = ? WHERE team_id = ? AND user_id = ?")
      .bind(role, teamId, userId)
      .run();
  } else {
    await db
      .prepare("INSERT INTO team_access (id, team_id, user_id, role) VALUES (?, ?, ?, ?)")
      .bind(crypto.randomUUID(), teamId, userId, role)
      .run();
  }

  return { team_id: teamId, user_id: userId, role };
}

export async function deleteTeamAccess(db, teamId, userId) {
  if (!db) {
    throw new Error("Database not configured");
  }

  const currentRole = await getTeamAccess(db, teamId, userId);
  if (!currentRole) {
    return false;
  }

  await assertNotLastOwner(db, teamId, currentRole, false);

  await db.prepare("DELETE FROM team_access WHERE team_id = ? AND user_id = ?").bind(teamId, userId).run();

  return true;
}
