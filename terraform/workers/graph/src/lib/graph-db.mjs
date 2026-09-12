export class ValidationError extends Error {}
export class ConflictError extends Error {}

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

export async function listNodesByType(db, graphId, type) {
  if (!db) {
    throw new Error("Database not configured");
  }

  const results = await db
    .prepare(
      "SELECT id, graph_id, type, label, properties, source_document_id, created_at, updated_at FROM nodes WHERE graph_id = ? AND type = ? ORDER BY created_at"
    )
    .bind(graphId, type)
    .all();

  return (results.results || []).map(mapNodeRow);
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

export async function getNeighbors(db, graphId, nodeId) {
  if (!db) {
    throw new Error("Database not configured");
  }

  const results = await db
    .prepare(
      `SELECT e.id AS edge_id, e.relation, e.properties AS edge_properties,
              e.from_node_id, e.to_node_id,
              n.id AS neighbor_id, n.type AS neighbor_type, n.label AS neighbor_label,
              n.properties AS neighbor_properties, n.source_document_id AS neighbor_source_document_id
       FROM edges e
       JOIN nodes n ON n.id = (CASE WHEN e.from_node_id = ? THEN e.to_node_id ELSE e.from_node_id END)
       WHERE (e.from_node_id = ? OR e.to_node_id = ?) AND n.graph_id = ?
       ORDER BY e.created_at`
    )
    .bind(nodeId, nodeId, nodeId, graphId)
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
