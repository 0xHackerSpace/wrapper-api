export class ValidationError extends Error {}

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

function mapNodeRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    label: row.label,
    properties: parseProperties(row.properties),
    source_document_id: row.source_document_id ?? null,
    created_at: row.created_at,
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
  };
}

export async function getNodeById(db, id) {
  if (!db) {
    throw new Error("Database not configured");
  }

  const row = await db
    .prepare("SELECT id, type, label, properties, source_document_id, created_at FROM nodes WHERE id = ?")
    .bind(id)
    .first();

  return mapNodeRow(row);
}

export async function listNodesByType(db, type) {
  if (!db) {
    throw new Error("Database not configured");
  }

  const results = await db
    .prepare("SELECT id, type, label, properties, source_document_id, created_at FROM nodes WHERE type = ? ORDER BY created_at")
    .bind(type)
    .all();

  return (results.results || []).map(mapNodeRow);
}

export async function createNode(db, { id, type, label, properties, source_document_id }) {
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

  const existing = await getNodeById(db, nodeId);
  if (existing) {
    throw new Error("Node with this id already exists");
  }

  const result = await db
    .prepare(
      "INSERT INTO nodes (id, type, label, properties, source_document_id) VALUES (?, ?, ?, ?, ?)"
    )
    .bind(nodeId, type, label, serializeProperties(properties), source_document_id || null)
    .run();

  if (!result.success) {
    throw new Error("Failed to create node");
  }

  return getNodeById(db, nodeId);
}

export async function getNeighbors(db, nodeId) {
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
       WHERE e.from_node_id = ? OR e.to_node_id = ?
       ORDER BY e.created_at`
    )
    .bind(nodeId, nodeId, nodeId)
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
      `SELECT id, from_node_id, to_node_id, relation, properties, created_at
       FROM edges
       WHERE (from_node_id = ? AND to_node_id = ?) OR (from_node_id = ? AND to_node_id = ?)
       ORDER BY created_at`
    )
    .bind(nodeId, otherId, otherId, nodeId)
    .all();

  return (results.results || []).map(mapEdgeRow);
}

export async function createEdge(db, { id, from_node_id, to_node_id, relation, properties }) {
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

  const fromNode = await getNodeById(db, from_node_id);
  if (!fromNode) {
    throw new ValidationError("from_node_id does not reference an existing node");
  }

  const toNode = await getNodeById(db, to_node_id);
  if (!toNode) {
    throw new ValidationError("to_node_id does not reference an existing node");
  }

  const edgeId = id || crypto.randomUUID();

  const result = await db
    .prepare(
      "INSERT INTO edges (id, from_node_id, to_node_id, relation, properties) VALUES (?, ?, ?, ?, ?)"
    )
    .bind(edgeId, from_node_id, to_node_id, relation, serializeProperties(properties))
    .run();

  if (!result.success) {
    throw new Error("Failed to create edge");
  }

  const created = await db
    .prepare("SELECT id, from_node_id, to_node_id, relation, properties, created_at FROM edges WHERE id = ?")
    .bind(edgeId)
    .first();

  return mapEdgeRow(created);
}
