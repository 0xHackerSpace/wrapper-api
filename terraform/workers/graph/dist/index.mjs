// terraform/workers/graph/src/lib/response.mjs
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
function error(message, status = 400) {
  return json({ error: { message, type: "invalid_request_error" } }, status);
}
function badRequest(message) {
  return error(message, 400);
}
function notFound(message = "Not found") {
  return error(message, 404);
}
function internalError(message) {
  return error(message, 500);
}

// terraform/workers/graph/src/lib/jwt.mjs
var encoder = new TextEncoder();
var decoder = new TextDecoder();
async function verifyToken(token, secret) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [headerEncoded, payloadEncoded, signatureEncoded] = parts;
    const message = `${headerEncoded}.${payloadEncoded}`;
    const expectedSignature = await sign(message, secret);
    if (signatureEncoded !== expectedSignature) return null;
    const payload = JSON.parse(base64urlDecode(payloadEncoded));
    const now = Math.floor(Date.now() / 1e3);
    if (payload.exp && payload.exp < now) return null;
    return payload;
  } catch {
    return null;
  }
}
async function sign(message, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return base64url(String.fromCharCode(...new Uint8Array(signature)));
}
function base64url(str) {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
function base64urlDecode(str) {
  str += "===".slice((str.length + 3) % 4);
  return decoder.decode(
    Uint8Array.from(
      atob(str.replace(/-/g, "+").replace(/_/g, "/")),
      (c) => c.charCodeAt(0)
    )
  );
}

// terraform/workers/graph/src/lib/auth.mjs
var AuthError = class extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
};
async function extractToken(request) {
  const authHeader = request.headers.get("authorization");
  if (!authHeader) {
    return null;
  }
  if (!authHeader.startsWith("Bearer ")) {
    throw new AuthError(401, "Invalid authorization header format");
  }
  return authHeader.slice(7);
}
async function requireAuth(request, env) {
  if (!env.JWT_SECRET) {
    throw new AuthError(500, "JWT_SECRET not configured");
  }
  const token = await extractToken(request);
  if (!token) {
    throw new AuthError(401, "Missing authorization token");
  }
  const payload = await verifyToken(token, env.JWT_SECRET);
  if (!payload) {
    throw new AuthError(401, "Invalid or expired token");
  }
  return payload;
}

// terraform/workers/graph/src/lib/graph-db.mjs
var ValidationError = class extends Error {
};
function serializeProperties(properties) {
  if (properties === void 0 || properties === null) {
    return null;
  }
  return JSON.stringify(properties);
}
function parseProperties(raw) {
  if (raw === void 0 || raw === null) {
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
    created_at: row.created_at
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
    created_at: row.created_at
  };
}
async function getNodeById(db, id) {
  if (!db) {
    throw new Error("Database not configured");
  }
  const row = await db.prepare("SELECT id, type, label, properties, source_document_id, created_at FROM nodes WHERE id = ?").bind(id).first();
  return mapNodeRow(row);
}
async function listNodesByType(db, type) {
  if (!db) {
    throw new Error("Database not configured");
  }
  const results = await db.prepare("SELECT id, type, label, properties, source_document_id, created_at FROM nodes WHERE type = ? ORDER BY created_at").bind(type).all();
  return (results.results || []).map(mapNodeRow);
}
async function createNode(db, { id, type, label, properties, source_document_id }) {
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
  const result = await db.prepare(
    "INSERT INTO nodes (id, type, label, properties, source_document_id) VALUES (?, ?, ?, ?, ?)"
  ).bind(nodeId, type, label, serializeProperties(properties), source_document_id || null).run();
  if (!result.success) {
    throw new Error("Failed to create node");
  }
  return getNodeById(db, nodeId);
}
async function getNeighbors(db, nodeId) {
  if (!db) {
    throw new Error("Database not configured");
  }
  const results = await db.prepare(
    `SELECT e.id AS edge_id, e.relation, e.properties AS edge_properties,
              e.from_node_id, e.to_node_id,
              n.id AS neighbor_id, n.type AS neighbor_type, n.label AS neighbor_label,
              n.properties AS neighbor_properties, n.source_document_id AS neighbor_source_document_id
       FROM edges e
       JOIN nodes n ON n.id = (CASE WHEN e.from_node_id = ? THEN e.to_node_id ELSE e.from_node_id END)
       WHERE e.from_node_id = ? OR e.to_node_id = ?
       ORDER BY e.created_at`
  ).bind(nodeId, nodeId, nodeId).all();
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
      source_document_id: row.neighbor_source_document_id ?? null
    }
  }));
}
async function getRelationsBetween(db, nodeId, otherId) {
  if (!db) {
    throw new Error("Database not configured");
  }
  const results = await db.prepare(
    `SELECT id, from_node_id, to_node_id, relation, properties, created_at
       FROM edges
       WHERE (from_node_id = ? AND to_node_id = ?) OR (from_node_id = ? AND to_node_id = ?)
       ORDER BY created_at`
  ).bind(nodeId, otherId, otherId, nodeId).all();
  return (results.results || []).map(mapEdgeRow);
}
async function createEdge(db, { id, from_node_id, to_node_id, relation, properties }) {
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
  const result = await db.prepare(
    "INSERT INTO edges (id, from_node_id, to_node_id, relation, properties) VALUES (?, ?, ?, ?, ?)"
  ).bind(edgeId, from_node_id, to_node_id, relation, serializeProperties(properties)).run();
  if (!result.success) {
    throw new Error("Failed to create edge");
  }
  const created = await db.prepare("SELECT id, from_node_id, to_node_id, relation, properties, created_at FROM edges WHERE id = ?").bind(edgeId).first();
  return mapEdgeRow(created);
}

// terraform/workers/graph/src/index.mjs
var index_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;
    try {
      if (pathname === "/health") return handleHealth(env);
      if (pathname === "/" || pathname === "/v1") return handleInfo(env);
      const nodeMatch = pathname.match(/^\/v1\/nodes(?:\/([^/]+)(?:\/(neighbors|relations))?)?$/);
      if (nodeMatch) {
        const nodeId = nodeMatch[1];
        const subresource = nodeMatch[2];
        if (!nodeId && pathname === "/v1/nodes" && request.method === "GET") {
          return await handleListNodes(request, env, url);
        }
        if (!nodeId && pathname === "/v1/nodes" && request.method === "POST") {
          return await handleCreateNode(request, env);
        }
        if (nodeId && !subresource && request.method === "GET") {
          return await handleGetNode(request, env, nodeId);
        }
        if (nodeId && subresource === "neighbors" && request.method === "GET") {
          return await handleGetNeighbors(request, env, nodeId);
        }
        if (nodeId && subresource === "relations" && request.method === "GET") {
          return await handleGetRelations(request, env, nodeId, url);
        }
      }
      if (pathname === "/v1/edges" && request.method === "POST") {
        return await handleCreateEdge(request, env);
      }
      return notFound("Endpoint not found");
    } catch (error2) {
      if (error2 instanceof AuthError) {
        return json({ error: { message: error2.message, type: "invalid_request_error" } }, error2.status);
      }
      if (error2 instanceof ValidationError) {
        return badRequest(error2.message);
      }
      console.error(error2);
      return internalError(error2.message);
    }
  }
};
function handleHealth(env) {
  return json({
    service: "graph",
    status: "ok",
    environment: env.ENVIRONMENT ?? "unknown"
  });
}
function handleInfo(env) {
  return json({
    service: "graph",
    version: "1.0.0",
    description: "Knowledge graph API: entities (nodes) and relations (edges) extracted from documents",
    environment: env.ENVIRONMENT ?? "unknown",
    endpoints: {
      health: "GET /health",
      info: "GET /v1",
      create_node: "POST /v1/nodes (requires auth)",
      list_nodes: "GET /v1/nodes?type=X (requires auth)",
      get_node: "GET /v1/nodes/:id (requires auth)",
      create_edge: "POST /v1/edges (requires auth)",
      neighbors: "GET /v1/nodes/:id/neighbors (requires auth)",
      relations: "GET /v1/nodes/:id/relations?to=:otherId (requires auth)"
    },
    authentication: {
      type: "JWT Bearer Token",
      header: "Authorization: Bearer {token}"
    }
  });
}
async function handleCreateNode(request, env) {
  await requireAuth(request, env);
  if (!env.GRAPH_DB) {
    return internalError("Graph database not configured");
  }
  const body = await request.json();
  const { id, type, label, properties, source_document_id } = body;
  const node = await createNode(env.GRAPH_DB, {
    id: id || null,
    type,
    label,
    properties: properties ?? null,
    source_document_id: source_document_id || null
  });
  return json({ success: true, data: node }, 201);
}
async function handleListNodes(request, env, url) {
  await requireAuth(request, env);
  if (!env.GRAPH_DB) {
    return internalError("Graph database not configured");
  }
  const type = url.searchParams.get("type");
  if (!type) {
    return badRequest("Missing required query parameter: type");
  }
  const nodes = await listNodesByType(env.GRAPH_DB, type);
  return json({ success: true, data: nodes, count: nodes.length });
}
async function handleGetNode(request, env, nodeId) {
  await requireAuth(request, env);
  if (!env.GRAPH_DB) {
    return internalError("Graph database not configured");
  }
  const node = await getNodeById(env.GRAPH_DB, nodeId);
  if (!node) {
    return notFound("Node not found");
  }
  return json({ success: true, data: node });
}
async function handleGetNeighbors(request, env, nodeId) {
  await requireAuth(request, env);
  if (!env.GRAPH_DB) {
    return internalError("Graph database not configured");
  }
  const node = await getNodeById(env.GRAPH_DB, nodeId);
  if (!node) {
    return notFound("Node not found");
  }
  const neighbors = await getNeighbors(env.GRAPH_DB, nodeId);
  return json({ success: true, data: neighbors, count: neighbors.length });
}
async function handleGetRelations(request, env, nodeId, url) {
  await requireAuth(request, env);
  if (!env.GRAPH_DB) {
    return internalError("Graph database not configured");
  }
  const otherId = url.searchParams.get("to");
  if (!otherId) {
    return badRequest("Missing required query parameter: to");
  }
  const node = await getNodeById(env.GRAPH_DB, nodeId);
  if (!node) {
    return notFound("Node not found");
  }
  const relations = await getRelationsBetween(env.GRAPH_DB, nodeId, otherId);
  return json({ success: true, data: relations, count: relations.length });
}
async function handleCreateEdge(request, env) {
  await requireAuth(request, env);
  if (!env.GRAPH_DB) {
    return internalError("Graph database not configured");
  }
  const body = await request.json();
  const { id, from_node_id, to_node_id, relation, properties } = body;
  const edge = await createEdge(env.GRAPH_DB, {
    id: id || null,
    from_node_id,
    to_node_id,
    relation,
    properties: properties ?? null
  });
  return json({ success: true, data: edge }, 201);
}
export {
  index_default as default
};
