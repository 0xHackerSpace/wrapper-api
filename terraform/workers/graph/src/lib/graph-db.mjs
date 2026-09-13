import { AuthError } from "./auth.mjs";

export class ValidationError extends Error {}
export class ConflictError extends Error {}

export const ROLE_RANK = { viewer: 1, editor: 2, owner: 3 };

function isUniqueConstraintError(error) {
  return typeof error.message === "string" && error.message.includes("UNIQUE constraint failed");
}

function serializeProperties(properties) {
  if (properties === undefined || properties === null) {
    return null;
  }
  return JSON.stringify(properties);
}

function parseProperties(raw) {
  if (raw === undefined || raw === null) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function mapGraphRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    created_by: row.created_by,
    created_at: row.created_at,
    ...(row.role !== undefined ? { role: row.role } : {}),
  };
}

function mapNodeRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    graph_id: row.graph_id,
    type: row.type,
    label: row.label,
    properties: parseProperties(row.properties),
    source_document_id: row.source_document_id ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapEdgeRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    from_node_id: row.from_node_id,
    to_node_id: row.to_node_id,
    relation: row.relation,
    properties: parseProperties(row.properties),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function createGraph(db, { id, name, createdBy }) {
  if (!db) {
    throw new Error("Database not configured");
  }
  if (!name) {
    throw new ValidationError("Missing required field: name");
  }

  const graphId = id || crypto.randomUUID();

  const existing = await getGraphById(db, graphId);
  if (existing) {
    throw new ConflictError("Graph with this id already exists");
  }

  let result;
  try {
    result = await db
      .prepare("INSERT INTO graphs (id, name, created_by) VALUES (?, ?, ?)")
      .bind(graphId, name, createdBy)
      .run();
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new ConflictError("Graph with this id already exists");
    }
    throw error;
  }

  if (!result.success) {
    throw new Error("Failed to create graph");
  }

  await db
    .prepare("INSERT INTO graph_access (id, graph_id, user_id, role) VALUES (?, ?, ?, ?)")
    .bind(crypto.randomUUID(), graphId, createdBy, "owner")
    .run();

  return getGraphById(db, graphId);
}

export async function getGraphById(db, id) {
  if (!db) {
    throw new Error("Database not configured");
  }

  const row = await db
    .prepare("SELECT id, name, created_by, created_at FROM graphs WHERE id = ?")
    .bind(id)
    .first();

  return mapGraphRow(row);
}

export async function listGraphsForUser(db, userId) {
  if (!db) {
    throw new Error("Database not configured");
  }

  const results = await db
    .prepare(
      `SELECT g.id, g.name, g.created_by, g.created_at, ga.role
       FROM graphs g
       JOIN graph_access ga ON ga.graph_id = g.id
       WHERE ga.user_id = ?
       ORDER BY g.created_at`
    )
    .bind(userId)
    .all();

  return (results.results || []).map(mapGraphRow);
}

export async function getGraphAccess(db, graphId, userId) {
  if (!db) {
    throw new Error("Database not configured");
  }

  const row = await db
    .prepare("SELECT role FROM graph_access WHERE graph_id = ? AND user_id = ?")
    .bind(graphId, userId)
    .first();

  return row?.role ?? null;
}

// Core per-graph ACL check (owner/editor/viewer), shared by both call paths:
// - HTTP: requireGraphMembership() in index.mjs derives actorSub from the JWT.
// - RPC (Service Bindings): callers pass actorSub explicitly, since there is no
//   JWT on that path. Either way, this is the only place the role/rank lookup lives.
export async function requireRole(db, graphId, actorSub, minRole) {
  const role = await getGraphAccess(db, graphId, actorSub);
  if (!role || ROLE_RANK[role] < ROLE_RANK[minRole]) {
    throw new AuthError(403, "No access to this graph");
  }
  return role;
}

const VALID_ROLES = ["owner", "editor", "viewer"];

export async function listGraphAccess(db, graphId) {
  if (!db) {
    throw new Error("Database not configured");
  }

  const results = await db
    .prepare("SELECT user_id, role, created_at FROM graph_access WHERE graph_id = ? ORDER BY created_at")
    .bind(graphId)
    .all();

  return (results.results || []).map((row) => ({
    user_id: row.user_id,
    role: row.role,
    created_at: row.created_at,
  }));
}

async function countOwners(db, graphId) {
  const access = await listGraphAccess(db, graphId);
  return access.filter((a) => a.role === "owner").length;
}

// Shared invariant: a graph can never end up with zero owners. Used by both
// the PUT downgrade path and both DELETE paths (self-removal and removal by
// another owner) so the rule is enforced identically everywhere.
async function assertNotLastOwner(db, graphId, currentRole, keepsOwnerRole) {
  if (currentRole !== "owner" || keepsOwnerRole) {
    return;
  }

  const owners = await countOwners(db, graphId);
  if (owners <= 1) {
    throw new ConflictError("Graph must have at least one owner");
  }
}

export async function upsertGraphAccess(db, graphId, userId, role) {
  if (!db) {
    throw new Error("Database not configured");
  }

  if (!VALID_ROLES.includes(role)) {
    throw new ValidationError(`Invalid role: must be one of ${VALID_ROLES.join(", ")}`);
  }

  const currentRole = await getGraphAccess(db, graphId, userId);

  await assertNotLastOwner(db, graphId, currentRole, role === "owner");

  if (currentRole) {
    await db
      .prepare("UPDATE graph_access SET role = ? WHERE graph_id = ? AND user_id = ?")
      .bind(role, graphId, userId)
      .run();
  } else {
    await db
      .prepare("INSERT INTO graph_access (id, graph_id, user_id, role) VALUES (?, ?, ?, ?)")
      .bind(crypto.randomUUID(), graphId, userId, role)
      .run();
  }

  return { graph_id: graphId, user_id: userId, role };
}

export async function deleteGraphAccess(db, graphId, userId) {
  if (!db) {
    throw new Error("Database not configured");
  }

  const currentRole = await getGraphAccess(db, graphId, userId);
  if (!currentRole) {
    return false;
  }

  await assertNotLastOwner(db, graphId, currentRole, false);

  await db
    .prepare("DELETE FROM graph_access WHERE graph_id = ? AND user_id = ?")
    .bind(graphId, userId)
    .run();

  return true;
}

export async function getNodeById(db, graphId, id) {
  if (!db) {
    throw new Error("Database not configured");
  }

  const row = await db
    .prepare(
      "SELECT id, graph_id, type, label, properties, source_document_id, created_at, updated_at FROM nodes WHERE id = ? AND graph_id = ?"
    )
    .bind(id, graphId)
    .first();

  return mapNodeRow(row);
}

export async function listNodesByType(db, graphId, type, label) {
  if (!db) {
    throw new Error("Database not configured");
  }

  const labelClause = label ? "AND LOWER(label) = LOWER(?)" : "";
  const binds = label ? [graphId, type, label] : [graphId, type];

  const results = await db
    .prepare(
      `SELECT id, graph_id, type, label, properties, source_document_id, created_at, updated_at FROM nodes WHERE graph_id = ? AND type = ? ${labelClause} ORDER BY created_at`
    )
    .bind(...binds)
    .all();

  return (results.results || []).map(mapNodeRow);
}

// Case-insensitive lookup by (type, label), used for "find-or-create" dedup:
// both the HTTP `?label=` filter on GET /nodes and the RPC upsertNode()/
// findNodeByLabel() paths (Fases 2-4 of the GraphRAG roadmap) rely on this.
export async function findNodeByLabel(db, graphId, type, label) {
  if (!db) {
    throw new Error("Database not configured");
  }

  const row = await db
    .prepare(
      "SELECT id, graph_id, type, label, properties, source_document_id, created_at, updated_at FROM nodes WHERE graph_id = ? AND type = ? AND LOWER(label) = LOWER(?) LIMIT 1"
    )
    .bind(graphId, type, label)
    .first();

  return mapNodeRow(row);
}

export async function createNode(db, graphId, { id, type, label, properties, source_document_id }) {
  if (!db) {
    throw new Error("Database not configured");
  }

  if (!type) {
    throw new ValidationError("Missing required field: type");
  }
  if (!label) {
    throw new ValidationError("Missing required field: label");
  }

  const nodeId = id || crypto.randomUUID();

  const existing = await getNodeById(db, graphId, nodeId);
  if (existing) {
    throw new ConflictError("Node with this id already exists");
  }

  let result;
  try {
    result = await db
      .prepare(
        "INSERT INTO nodes (id, graph_id, type, label, properties, source_document_id) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .bind(nodeId, graphId, type, label, serializeProperties(properties), source_document_id || null)
      .run();
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new ConflictError("Node with this id already exists");
    }
    throw error;
  }

  if (!result.success) {
    throw new Error("Failed to create node");
  }

  return getNodeById(db, graphId, nodeId);
}

// Updates only label/properties -- type and graph_id are immutable by design
// (a node cannot change what it represents or move between graphs).
export async function updateNode(db, graphId, id, { label, properties } = {}) {
  if (!db) {
    throw new Error("Database not configured");
  }

  const existing = await getNodeById(db, graphId, id);
  if (!existing) {
    return null;
  }

  const nextLabel = label !== undefined ? label : existing.label;
  if (!nextLabel) {
    throw new ValidationError("Missing required field: label");
  }
  const nextProperties = properties !== undefined ? properties : existing.properties;

  await db
    .prepare("UPDATE nodes SET label = ?, properties = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND graph_id = ?")
    .bind(nextLabel, serializeProperties(nextProperties), id, graphId)
    .run();

  return getNodeById(db, graphId, id);
}

// Edges referencing this node are removed by the ON DELETE CASCADE constraint
// already declared on edges.from_node_id/to_node_id (migration 0007) -- no
// manual cleanup needed here.
export async function deleteNode(db, graphId, id) {
  if (!db) {
    throw new Error("Database not configured");
  }

  const existing = await getNodeById(db, graphId, id);
  if (!existing) {
    return false;
  }

  await db.prepare("DELETE FROM nodes WHERE id = ? AND graph_id = ?").bind(id, graphId).run();
  return true;
}

export async function getNeighbors(db, graphId, nodeId, { relation, type } = {}) {
  if (!db) {
    throw new Error("Database not configured");
  }

  const conditions = [];
  const binds = [nodeId, nodeId, nodeId, graphId];
  if (relation) {
    conditions.push("e.relation = ?");
    binds.push(relation);
  }
  if (type) {
    conditions.push("n.type = ?");
    binds.push(type);
  }
  const extraClause = conditions.length ? `AND ${conditions.join(" AND ")}` : "";

  const results = await db
    .prepare(
      `SELECT e.id AS edge_id, e.relation, e.properties AS edge_properties,
              e.from_node_id, e.to_node_id,
              n.id AS neighbor_id, n.type AS neighbor_type, n.label AS neighbor_label,
              n.properties AS neighbor_properties, n.source_document_id AS neighbor_source_document_id
       FROM edges e
       JOIN nodes n ON n.id = (CASE WHEN e.from_node_id = ? THEN e.to_node_id ELSE e.from_node_id END)
       WHERE (e.from_node_id = ? OR e.to_node_id = ?) AND n.graph_id = ? ${extraClause}
       ORDER BY e.created_at`
    )
    .bind(...binds)
    .all();

  return (results.results || []).map((row) => ({
    edge_id: row.edge_id,
    relation: row.relation,
    direction: row.from_node_id === nodeId ? "outgoing" : "incoming",
    properties: parseProperties(row.edge_properties),
    neighbor: {
      id: row.neighbor_id,
      type: row.neighbor_type,
      label: row.neighbor_label,
      properties: parseProperties(row.neighbor_properties),
      source_document_id: row.neighbor_source_document_id ?? null,
    },
  }));
}

export async function getRelationsBetween(db, nodeId, otherId) {
  if (!db) {
    throw new Error("Database not configured");
  }

  const results = await db
    .prepare(
      `SELECT id, from_node_id, to_node_id, relation, properties, created_at, updated_at
       FROM edges
       WHERE (from_node_id = ? AND to_node_id = ?) OR (from_node_id = ? AND to_node_id = ?)
       ORDER BY created_at`
    )
    .bind(nodeId, otherId, otherId, nodeId)
    .all();

  return (results.results || []).map(mapEdgeRow);
}

export async function createEdge(db, graphId, { id, from_node_id, to_node_id, relation, properties }) {
  if (!db) {
    throw new Error("Database not configured");
  }

  if (!from_node_id) {
    throw new ValidationError("Missing required field: from_node_id");
  }
  if (!to_node_id) {
    throw new ValidationError("Missing required field: to_node_id");
  }
  if (!relation) {
    throw new ValidationError("Missing required field: relation");
  }

  const fromNode = await getNodeById(db, graphId, from_node_id);
  if (!fromNode) {
    throw new ValidationError("from_node_id does not reference an existing node in this graph");
  }

  const toNode = await getNodeById(db, graphId, to_node_id);
  if (!toNode) {
    throw new ValidationError("to_node_id does not reference an existing node in this graph");
  }

  const duplicate = await db
    .prepare("SELECT id FROM edges WHERE from_node_id = ? AND to_node_id = ? AND relation = ?")
    .bind(from_node_id, to_node_id, relation)
    .first();
  if (duplicate) {
    throw new ConflictError("An edge with this from_node_id, to_node_id, and relation already exists");
  }

  const edgeId = id || crypto.randomUUID();

  let result;
  try {
    result = await db
      .prepare(
        "INSERT INTO edges (id, from_node_id, to_node_id, relation, properties) VALUES (?, ?, ?, ?, ?)"
      )
      .bind(edgeId, from_node_id, to_node_id, relation, serializeProperties(properties))
      .run();
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new ConflictError("An edge with this from_node_id, to_node_id, and relation already exists");
    }
    throw error;
  }

  if (!result.success) {
    throw new Error("Failed to create edge");
  }

  const created = await db
    .prepare("SELECT id, from_node_id, to_node_id, relation, properties, created_at, updated_at FROM edges WHERE id = ?")
    .bind(edgeId)
    .first();

  return mapEdgeRow(created);
}

const MIN_TRAVERSAL_DEPTH = 1;
const MAX_TRAVERSAL_DEPTH = 6;
const DEFAULT_TRAVERSAL_DEPTH = 3;
const TRAVERSAL_ROW_LIMIT = 200;
const VALID_DIRECTIONS = ["any", "out", "in"];

function clampMaxDepth(maxDepth) {
  const parsed = Number(maxDepth);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_TRAVERSAL_DEPTH;
  }
  return Math.min(MAX_TRAVERSAL_DEPTH, Math.max(MIN_TRAVERSAL_DEPTH, Math.trunc(parsed)));
}

function normalizeRelationFilter(relation) {
  if (!relation) return null;
  const list = relation
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
  return list.length ? list : null;
}

function normalizeDirection(direction) {
  if (!direction) return "any";
  if (!VALID_DIRECTIONS.includes(direction)) {
    throw new ValidationError(`Invalid direction: must be one of ${VALID_DIRECTIONS.join(", ")}`);
  }
  return direction;
}

function buildDirectionClause(direction) {
  if (direction === "out") return "(e.from_node_id = t.node_id)";
  if (direction === "in") return "(e.to_node_id = t.node_id)";
  return "(e.from_node_id = t.node_id OR e.to_node_id = t.node_id)";
}

// hop_path accumulates "edgeId:fromId:toId:relation;" segments as the
// recursive CTE walks the graph, so the full edge trail for a path can be
// reconstructed here without a second round-trip to the database.
function parseHopPath(hopPath) {
  if (!hopPath) return [];
  return hopPath
    .split(";")
    .filter(Boolean)
    .map((segment) => {
      const [edge_id, from_node_id, to_node_id, relation] = segment.split(":");
      return { edge_id, from_node_id, to_node_id, relation };
    });
}

// Multi-hop traversal via a SQLite/D1 recursive CTE. Two modes:
//   - no toId: "reachable" -- every node reachable from fromId within maxDepth,
//     one row per node (the shortest path found), with distance + edge path.
//   - toId given: "paths" -- every distinct path from fromId to toId within
//     maxDepth (there can be more than one).
// Cycle detection accumulates node_path as a delimited string ('|id1|id2|')
// and refuses to expand into a node already present in it. maxDepth is
// clamped to [1,6] and the query carries a hard LIMIT as a CPU safety net for
// dense graphs, independent of maxDepth.
export async function findPaths(db, graphId, fromId, { toId, maxDepth, relation, direction } = {}) {
  if (!db) {
    throw new Error("Database not configured");
  }

  const depth = clampMaxDepth(maxDepth);
  const relations = normalizeRelationFilter(relation);
  const directionClause = buildDirectionClause(normalizeDirection(direction));
  const relationClause = relations ? `AND e.relation IN (${relations.map(() => "?").join(", ")})` : "";

  const sql = `
    WITH RECURSIVE traversal(node_id, depth, node_path, hop_path) AS (
      SELECT ? AS node_id, 0 AS depth, '|' || ? || '|' AS node_path, '' AS hop_path
      UNION ALL
      SELECT
        CASE WHEN e.from_node_id = t.node_id THEN e.to_node_id ELSE e.from_node_id END,
        t.depth + 1,
        t.node_path || (CASE WHEN e.from_node_id = t.node_id THEN e.to_node_id ELSE e.from_node_id END) || '|',
        t.hop_path || e.id || ':' || e.from_node_id || ':' || e.to_node_id || ':' || e.relation || ';'
      FROM traversal t
      JOIN edges e ON ${directionClause}
      JOIN nodes n2 ON n2.id = (CASE WHEN e.from_node_id = t.node_id THEN e.to_node_id ELSE e.from_node_id END)
      WHERE t.depth < ?
        AND n2.graph_id = ?
        AND instr(t.node_path, '|' || (CASE WHEN e.from_node_id = t.node_id THEN e.to_node_id ELSE e.from_node_id END) || '|') = 0
        ${relationClause}
    )
    SELECT t.node_id, n.type, n.label, n.properties, n.source_document_id, t.depth AS depth, t.node_path, t.hop_path
    FROM traversal t
    JOIN nodes n ON n.id = t.node_id
    WHERE t.depth > 0
    ORDER BY t.depth
    LIMIT ${TRAVERSAL_ROW_LIMIT}
  `;

  const binds = [fromId, fromId, depth, graphId, ...(relations || [])];

  const results = await db.prepare(sql).bind(...binds).all();
  const rows = results.results || [];

  if (toId) {
    return rows
      .filter((row) => row.node_id === toId)
      .map((row) => ({ depth: row.depth, path: parseHopPath(row.hop_path) }));
  }

  const seen = new Map();
  for (const row of rows) {
    if (!seen.has(row.node_id)) {
      seen.set(row.node_id, row);
    }
  }

  return [...seen.values()].map((row) => ({
    node: {
      id: row.node_id,
      graph_id: graphId,
      type: row.type,
      label: row.label,
      properties: parseProperties(row.properties),
      source_document_id: row.source_document_id ?? null,
    },
    distance: row.depth,
    path: parseHopPath(row.hop_path),
  }));
}
