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
function conflict(message) {
  return error(message, 409);
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
async function requirePermission(request, env, permission) {
  const payload = await requireAuth(request, env);
  if (!Array.isArray(payload.permissions) || !payload.permissions.includes(permission)) {
    throw new AuthError(403, `Missing required permission: ${permission}`);
  }
  return payload;
}

// terraform/workers/graph/src/lib/graph-db.mjs
var ValidationError = class extends Error {
};
var ConflictError = class extends Error {
};
function isUniqueConstraintError(error2) {
  return typeof error2.message === "string" && error2.message.includes("UNIQUE constraint failed");
}
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
function mapGraphRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    created_by: row.created_by,
    created_at: row.created_at,
    ...row.role !== void 0 ? { role: row.role } : {}
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
    updated_at: row.updated_at
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
    updated_at: row.updated_at
  };
}
async function createGraph(db, { id, name, createdBy }) {
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
    result = await db.prepare("INSERT INTO graphs (id, name, created_by) VALUES (?, ?, ?)").bind(graphId, name, createdBy).run();
  } catch (error2) {
    if (isUniqueConstraintError(error2)) {
      throw new ConflictError("Graph with this id already exists");
    }
    throw error2;
  }
  if (!result.success) {
    throw new Error("Failed to create graph");
  }
  await db.prepare("INSERT INTO graph_access (id, graph_id, user_id, role) VALUES (?, ?, ?, ?)").bind(crypto.randomUUID(), graphId, createdBy, "owner").run();
  return getGraphById(db, graphId);
}
async function getGraphById(db, id) {
  if (!db) {
    throw new Error("Database not configured");
  }
  const row = await db.prepare("SELECT id, name, created_by, created_at FROM graphs WHERE id = ?").bind(id).first();
  return mapGraphRow(row);
}
async function listGraphsForUser(db, userId) {
  if (!db) {
    throw new Error("Database not configured");
  }
  const results = await db.prepare(
    `SELECT g.id, g.name, g.created_by, g.created_at, ga.role
       FROM graphs g
       JOIN graph_access ga ON ga.graph_id = g.id
       WHERE ga.user_id = ?
       ORDER BY g.created_at`
  ).bind(userId).all();
  return (results.results || []).map(mapGraphRow);
}
async function getGraphAccess(db, graphId, userId) {
  if (!db) {
    throw new Error("Database not configured");
  }
  const row = await db.prepare("SELECT role FROM graph_access WHERE graph_id = ? AND user_id = ?").bind(graphId, userId).first();
  return row?.role ?? null;
}
var VALID_ROLES = ["owner", "editor", "viewer"];
async function listGraphAccess(db, graphId) {
  if (!db) {
    throw new Error("Database not configured");
  }
  const results = await db.prepare("SELECT user_id, role, created_at FROM graph_access WHERE graph_id = ? ORDER BY created_at").bind(graphId).all();
  return (results.results || []).map((row) => ({
    user_id: row.user_id,
    role: row.role,
    created_at: row.created_at
  }));
}
async function countOwners(db, graphId) {
  const access = await listGraphAccess(db, graphId);
  return access.filter((a) => a.role === "owner").length;
}
async function assertNotLastOwner(db, graphId, currentRole, keepsOwnerRole) {
  if (currentRole !== "owner" || keepsOwnerRole) {
    return;
  }
  const owners = await countOwners(db, graphId);
  if (owners <= 1) {
    throw new ConflictError("Graph must have at least one owner");
  }
}
async function upsertGraphAccess(db, graphId, userId, role) {
  if (!db) {
    throw new Error("Database not configured");
  }
  if (!VALID_ROLES.includes(role)) {
    throw new ValidationError(`Invalid role: must be one of ${VALID_ROLES.join(", ")}`);
  }
  const currentRole = await getGraphAccess(db, graphId, userId);
  await assertNotLastOwner(db, graphId, currentRole, role === "owner");
  if (currentRole) {
    await db.prepare("UPDATE graph_access SET role = ? WHERE graph_id = ? AND user_id = ?").bind(role, graphId, userId).run();
  } else {
    await db.prepare("INSERT INTO graph_access (id, graph_id, user_id, role) VALUES (?, ?, ?, ?)").bind(crypto.randomUUID(), graphId, userId, role).run();
  }
  return { graph_id: graphId, user_id: userId, role };
}
async function deleteGraphAccess(db, graphId, userId) {
  if (!db) {
    throw new Error("Database not configured");
  }
  const currentRole = await getGraphAccess(db, graphId, userId);
  if (!currentRole) {
    return false;
  }
  await assertNotLastOwner(db, graphId, currentRole, false);
  await db.prepare("DELETE FROM graph_access WHERE graph_id = ? AND user_id = ?").bind(graphId, userId).run();
  return true;
}
async function getNodeById(db, graphId, id) {
  if (!db) {
    throw new Error("Database not configured");
  }
  const row = await db.prepare(
    "SELECT id, graph_id, type, label, properties, source_document_id, created_at, updated_at FROM nodes WHERE id = ? AND graph_id = ?"
  ).bind(id, graphId).first();
  return mapNodeRow(row);
}
async function listNodesByType(db, graphId, type) {
  if (!db) {
    throw new Error("Database not configured");
  }
  const results = await db.prepare(
    "SELECT id, graph_id, type, label, properties, source_document_id, created_at, updated_at FROM nodes WHERE graph_id = ? AND type = ? ORDER BY created_at"
  ).bind(graphId, type).all();
  return (results.results || []).map(mapNodeRow);
}
async function createNode(db, graphId, { id, type, label, properties, source_document_id }) {
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
    result = await db.prepare(
      "INSERT INTO nodes (id, graph_id, type, label, properties, source_document_id) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(nodeId, graphId, type, label, serializeProperties(properties), source_document_id || null).run();
  } catch (error2) {
    if (isUniqueConstraintError(error2)) {
      throw new ConflictError("Node with this id already exists");
    }
    throw error2;
  }
  if (!result.success) {
    throw new Error("Failed to create node");
  }
  return getNodeById(db, graphId, nodeId);
}
async function getNeighbors(db, graphId, nodeId) {
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
       WHERE (e.from_node_id = ? OR e.to_node_id = ?) AND n.graph_id = ?
       ORDER BY e.created_at`
  ).bind(nodeId, nodeId, nodeId, graphId).all();
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
    `SELECT id, from_node_id, to_node_id, relation, properties, created_at, updated_at
       FROM edges
       WHERE (from_node_id = ? AND to_node_id = ?) OR (from_node_id = ? AND to_node_id = ?)
       ORDER BY created_at`
  ).bind(nodeId, otherId, otherId, nodeId).all();
  return (results.results || []).map(mapEdgeRow);
}
async function createEdge(db, graphId, { id, from_node_id, to_node_id, relation, properties }) {
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
  const duplicate = await db.prepare("SELECT id FROM edges WHERE from_node_id = ? AND to_node_id = ? AND relation = ?").bind(from_node_id, to_node_id, relation).first();
  if (duplicate) {
    throw new ConflictError("An edge with this from_node_id, to_node_id, and relation already exists");
  }
  const edgeId = id || crypto.randomUUID();
  let result;
  try {
    result = await db.prepare(
      "INSERT INTO edges (id, from_node_id, to_node_id, relation, properties) VALUES (?, ?, ?, ?, ?)"
    ).bind(edgeId, from_node_id, to_node_id, relation, serializeProperties(properties)).run();
  } catch (error2) {
    if (isUniqueConstraintError(error2)) {
      throw new ConflictError("An edge with this from_node_id, to_node_id, and relation already exists");
    }
    throw error2;
  }
  if (!result.success) {
    throw new Error("Failed to create edge");
  }
  const created = await db.prepare("SELECT id, from_node_id, to_node_id, relation, properties, created_at, updated_at FROM edges WHERE id = ?").bind(edgeId).first();
  return mapEdgeRow(created);
}

// terraform/workers/graph/src/index.mjs
var ROLE_RANK = { viewer: 1, editor: 2, owner: 3 };
var index_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;
    try {
      if (pathname === "/health") return handleHealth(env);
      if (pathname === "/" || pathname === "/v1") return handleInfo(env);
      if (pathname === "/v1/graphs" && request.method === "POST") return await handleCreateGraph(request, env);
      if (pathname === "/v1/graphs" && request.method === "GET") return await handleListGraphs(request, env);
      const graphMatch = pathname.match(/^\/v1\/graphs\/([^/]+)(?:\/(nodes|edges|access)(?:\/([^/]+)(?:\/(neighbors|relations))?)?)?$/);
      if (graphMatch) {
        const graphId = graphMatch[1];
        const resource = graphMatch[2];
        const resourceId = graphMatch[3];
        const subresource = graphMatch[4];
        if (resource === "nodes") {
          if (!resourceId && request.method === "GET") return await handleListNodes(request, env, graphId, url);
          if (!resourceId && request.method === "POST") return await handleCreateNode(request, env, graphId);
          if (resourceId && !subresource && request.method === "GET") return await handleGetNode(request, env, graphId, resourceId);
          if (resourceId && subresource === "neighbors" && request.method === "GET") return await handleGetNeighbors(request, env, graphId, resourceId);
          if (resourceId && subresource === "relations" && request.method === "GET") return await handleGetRelations(request, env, graphId, resourceId, url);
        }
        if (resource === "edges" && !resourceId && request.method === "POST") {
          return await handleCreateEdge(request, env, graphId);
        }
        if (resource === "access") {
          if (!resourceId && request.method === "GET") return await handleListAccess(request, env, graphId);
          if (resourceId && request.method === "PUT") return await handleGrantAccess(request, env, graphId, resourceId);
          if (resourceId && request.method === "DELETE") return await handleRevokeAccess(request, env, graphId, resourceId);
        }
      }
      return notFound("Endpoint not found");
    } catch (error2) {
      if (error2 instanceof AuthError) {
        return json({ error: { message: error2.message, type: "invalid_request_error" } }, error2.status);
      }
      if (error2 instanceof ValidationError) {
        return badRequest(error2.message);
      }
      if (error2 instanceof ConflictError) {
        return conflict(error2.message);
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
    description: "Knowledge graph API: isolated graphs of entities (nodes) and relations (edges) extracted from documents",
    environment: env.ENVIRONMENT ?? "unknown",
    endpoints: {
      health: "GET /health",
      info: "GET /v1",
      create_graph: "POST /v1/graphs (requires auth, creator becomes owner)",
      list_graphs: "GET /v1/graphs (requires auth, lists graphs you have access to)",
      create_node: "POST /v1/graphs/:graphId/nodes (requires auth + editor/owner access)",
      list_nodes: "GET /v1/graphs/:graphId/nodes?type=X (requires auth + viewer+ access)",
      get_node: "GET /v1/graphs/:graphId/nodes/:id (requires auth + viewer+ access)",
      create_edge: "POST /v1/graphs/:graphId/edges (requires auth + editor/owner access)",
      neighbors: "GET /v1/graphs/:graphId/nodes/:id/neighbors (requires auth + viewer+ access)",
      relations: "GET /v1/graphs/:graphId/nodes/:id/relations?to=:otherId (requires auth + viewer+ access)",
      grant_access: "PUT /v1/graphs/:graphId/access/:userId (requires auth + owner access, upserts a collaborator's role)",
      revoke_access: "DELETE /v1/graphs/:graphId/access/:userId (requires auth + owner access, or self-removal with graph:read)",
      list_access: "GET /v1/graphs/:graphId/access (requires auth + viewer+ access)"
    },
    authentication: {
      type: "JWT Bearer Token",
      header: "Authorization: Bearer {token}"
    }
  });
}
async function requireGraphMembership(env, graphId, userId, minRole) {
  const graph = await getGraphById(env.GRAPH_DB, graphId);
  if (!graph) {
    return null;
  }
  const role = await getGraphAccess(env.GRAPH_DB, graphId, userId);
  if (!role || ROLE_RANK[role] < ROLE_RANK[minRole]) {
    throw new AuthError(403, "No access to this graph");
  }
  return graph;
}
async function handleCreateGraph(request, env) {
  const payload = await requirePermission(request, env, "graph:write");
  if (!env.GRAPH_DB) {
    return internalError("Graph database not configured");
  }
  const body = await request.json();
  const { id, name } = body;
  const graph = await createGraph(env.GRAPH_DB, { id: id || null, name, createdBy: payload.sub });
  return json({ success: true, data: graph }, 201);
}
async function handleListGraphs(request, env) {
  const payload = await requirePermission(request, env, "graph:read");
  if (!env.GRAPH_DB) {
    return internalError("Graph database not configured");
  }
  const graphs = await listGraphsForUser(env.GRAPH_DB, payload.sub);
  return json({ success: true, data: graphs, count: graphs.length });
}
async function handleCreateNode(request, env, graphId) {
  const payload = await requirePermission(request, env, "graph:write");
  if (!env.GRAPH_DB) {
    return internalError("Graph database not configured");
  }
  const graph = await requireGraphMembership(env, graphId, payload.sub, "editor");
  if (!graph) return notFound("Graph not found");
  const body = await request.json();
  const { id, type, label, properties, source_document_id } = body;
  const node = await createNode(env.GRAPH_DB, graphId, {
    id: id || null,
    type,
    label,
    properties: properties ?? null,
    source_document_id: source_document_id || null
  });
  return json({ success: true, data: node }, 201);
}
async function handleListNodes(request, env, graphId, url) {
  const payload = await requirePermission(request, env, "graph:read");
  if (!env.GRAPH_DB) {
    return internalError("Graph database not configured");
  }
  const graph = await requireGraphMembership(env, graphId, payload.sub, "viewer");
  if (!graph) return notFound("Graph not found");
  const type = url.searchParams.get("type");
  if (!type) {
    return badRequest("Missing required query parameter: type");
  }
  const nodes = await listNodesByType(env.GRAPH_DB, graphId, type);
  return json({ success: true, data: nodes, count: nodes.length });
}
async function handleGetNode(request, env, graphId, nodeId) {
  const payload = await requirePermission(request, env, "graph:read");
  if (!env.GRAPH_DB) {
    return internalError("Graph database not configured");
  }
  const graph = await requireGraphMembership(env, graphId, payload.sub, "viewer");
  if (!graph) return notFound("Graph not found");
  const node = await getNodeById(env.GRAPH_DB, graphId, nodeId);
  if (!node) {
    return notFound("Node not found");
  }
  return json({ success: true, data: node });
}
async function handleGetNeighbors(request, env, graphId, nodeId) {
  const payload = await requirePermission(request, env, "graph:read");
  if (!env.GRAPH_DB) {
    return internalError("Graph database not configured");
  }
  const graph = await requireGraphMembership(env, graphId, payload.sub, "viewer");
  if (!graph) return notFound("Graph not found");
  const node = await getNodeById(env.GRAPH_DB, graphId, nodeId);
  if (!node) {
    return notFound("Node not found");
  }
  const neighbors = await getNeighbors(env.GRAPH_DB, graphId, nodeId);
  return json({ success: true, data: neighbors, count: neighbors.length });
}
async function handleGetRelations(request, env, graphId, nodeId, url) {
  const payload = await requirePermission(request, env, "graph:read");
  if (!env.GRAPH_DB) {
    return internalError("Graph database not configured");
  }
  const graph = await requireGraphMembership(env, graphId, payload.sub, "viewer");
  if (!graph) return notFound("Graph not found");
  const node = await getNodeById(env.GRAPH_DB, graphId, nodeId);
  if (!node) {
    return notFound("Node not found");
  }
  const otherId = url.searchParams.get("to");
  if (!otherId) {
    return badRequest("Missing required query parameter: to");
  }
  const otherNode = await getNodeById(env.GRAPH_DB, graphId, otherId);
  if (!otherNode) {
    return notFound("to node not found in this graph");
  }
  const relations = await getRelationsBetween(env.GRAPH_DB, nodeId, otherId);
  return json({ success: true, data: relations, count: relations.length });
}
async function handleCreateEdge(request, env, graphId) {
  const payload = await requirePermission(request, env, "graph:write");
  if (!env.GRAPH_DB) {
    return internalError("Graph database not configured");
  }
  const graph = await requireGraphMembership(env, graphId, payload.sub, "editor");
  if (!graph) return notFound("Graph not found");
  const body = await request.json();
  const { id, from_node_id, to_node_id, relation, properties } = body;
  const edge = await createEdge(env.GRAPH_DB, graphId, {
    id: id || null,
    from_node_id,
    to_node_id,
    relation,
    properties: properties ?? null
  });
  return json({ success: true, data: edge }, 201);
}
function assertPermission(payload, permission) {
  if (!Array.isArray(payload.permissions) || !payload.permissions.includes(permission)) {
    throw new AuthError(403, `Missing required permission: ${permission}`);
  }
}
async function handleGrantAccess(request, env, graphId, targetUserId) {
  const payload = await requirePermission(request, env, "graph:write");
  if (!env.GRAPH_DB) {
    return internalError("Graph database not configured");
  }
  const graph = await requireGraphMembership(env, graphId, payload.sub, "owner");
  if (!graph) return notFound("Graph not found");
  const body = await request.json();
  const { role } = body;
  const access = await upsertGraphAccess(env.GRAPH_DB, graphId, targetUserId, role);
  return json({ success: true, data: access });
}
async function handleRevokeAccess(request, env, graphId, targetUserId) {
  const payload = await requireAuth(request, env);
  const isSelf = payload.sub === targetUserId;
  assertPermission(payload, isSelf ? "graph:read" : "graph:write");
  if (!env.GRAPH_DB) {
    return internalError("Graph database not configured");
  }
  if (isSelf) {
    const graph = await getGraphById(env.GRAPH_DB, graphId);
    if (!graph) return notFound("Graph not found");
  } else {
    const graph = await requireGraphMembership(env, graphId, payload.sub, "owner");
    if (!graph) return notFound("Graph not found");
  }
  const removed = await deleteGraphAccess(env.GRAPH_DB, graphId, targetUserId);
  if (!removed) return notFound("Access not found");
  return json({ success: true });
}
async function handleListAccess(request, env, graphId) {
  const payload = await requirePermission(request, env, "graph:read");
  if (!env.GRAPH_DB) {
    return internalError("Graph database not configured");
  }
  const graph = await requireGraphMembership(env, graphId, payload.sub, "viewer");
  if (!graph) return notFound("Graph not found");
  const access = await listGraphAccess(env.GRAPH_DB, graphId);
  return json({ success: true, data: access, count: access.length });
}
export {
  index_default as default
};
