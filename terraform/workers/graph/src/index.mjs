import { WorkerEntrypoint } from "cloudflare:workers";
import { json, badRequest, notFound, internalError, conflict } from "./lib/response.mjs";
import { requireAuth, requirePermission, AuthError } from "./lib/auth.mjs";
import {
  getGraphById,
  createGraph,
  listGraphsForUser,
  listGraphAccess,
  upsertGraphAccess,
  deleteGraphAccess,
  getNodeById,
  listNodesByType,
  createNode,
  updateNode,
  deleteNode,
  findNodeByLabel,
  getNeighbors,
  getRelationsBetween,
  createEdge,
  findPaths,
  requireRole,
  ValidationError,
  ConflictError,
} from "./lib/graph-db.mjs";

export default class extends WorkerEntrypoint {
  async fetch(request) {
    const env = this.env;
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      if (pathname === "/health") return handleHealth(env);
      if (pathname === "/" || pathname === "/v1") return handleInfo(env);

      if (pathname === "/v1/graphs" && request.method === "POST") return await handleCreateGraph(request, env);
      if (pathname === "/v1/graphs" && request.method === "GET") return await handleListGraphs(request, env);

      const graphMatch = pathname.match(/^\/v1\/graphs\/([^/]+)(?:\/(nodes|edges|access)(?:\/([^/]+)(?:\/(neighbors|relations|paths))?)?)?$/);
      if (graphMatch) {
        const graphId = graphMatch[1];
        const resource = graphMatch[2];
        const resourceId = graphMatch[3];
        const subresource = graphMatch[4];

        if (resource === "nodes") {
          if (!resourceId && request.method === "GET") return await handleListNodes(request, env, graphId, url);
          if (!resourceId && request.method === "POST") return await handleCreateNode(request, env, graphId);
          if (resourceId && !subresource && request.method === "GET") return await handleGetNode(request, env, graphId, resourceId);
          if (resourceId && !subresource && request.method === "PUT") return await handleUpdateNode(request, env, graphId, resourceId);
          if (resourceId && !subresource && request.method === "DELETE") return await handleDeleteNode(request, env, graphId, resourceId);
          if (resourceId && subresource === "neighbors" && request.method === "GET") return await handleGetNeighbors(request, env, graphId, resourceId, url);
          if (resourceId && subresource === "relations" && request.method === "GET") return await handleGetRelations(request, env, graphId, resourceId, url);
          if (resourceId && subresource === "paths" && request.method === "GET") return await handleGetPaths(request, env, graphId, resourceId, url);
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
    } catch (error) {
      if (error instanceof AuthError) {
        return json({ error: { message: error.message, type: "invalid_request_error" } }, error.status);
      }
      if (error instanceof ValidationError) {
        return badRequest(error.message);
      }
      if (error instanceof ConflictError) {
        return conflict(error.message);
      }
      console.error(error);
      return internalError(error.message);
    }
  }

  // RPC entrypoints for other workers via Service Bindings (e.g. api-worker,
  // rag-worker, graphrag-worker in later phases of the GraphRAG roadmap). No
  // requirePermission/JWT here: Service Bindings are only reachable from
  // within the same Cloudflare account, so coarse graph:read/graph:write RBAC
  // stays exclusive to the HTTP path above. Each method still enforces the
  // fine-grained per-graph ACL (graph_access role) via requireRole(), using
  // the actorSub the caller passes in explicitly (there is no JWT to derive
  // it from on this path).
  //
  // NOTE (unverified assumption, see docs/decisions/0015): whether AuthError's
  // `.status` property survives workerd's RPC serialization across the
  // Service Binding boundary has not been validated with a real deploy. If it
  // doesn't survive, callers should branch on `error.message`/`error.name`
  // rather than `instanceof AuthError`.
  async upsertNode(graphId, actorSub, nodeData) {
    await requireRole(this.env.GRAPH_DB, graphId, actorSub, "editor");

    const { id, type, label, properties, source_document_id } = nodeData;
    const existing = await findNodeByLabel(this.env.GRAPH_DB, graphId, type, label);
    if (existing) {
      return existing;
    }

    return createNode(this.env.GRAPH_DB, graphId, {
      id: id || null,
      type,
      label,
      properties: properties ?? null,
      source_document_id: source_document_id || null,
    });
  }

  async updateNode(graphId, actorSub, nodeId, patch) {
    await requireRole(this.env.GRAPH_DB, graphId, actorSub, "editor");

    const node = await updateNode(this.env.GRAPH_DB, graphId, nodeId, patch);
    if (!node) {
      throw new Error(`Node not found: ${nodeId}`);
    }
    return node;
  }

  async deleteNode(graphId, actorSub, nodeId) {
    await requireRole(this.env.GRAPH_DB, graphId, actorSub, "editor");

    const removed = await deleteNode(this.env.GRAPH_DB, graphId, nodeId);
    if (!removed) {
      throw new Error(`Node not found: ${nodeId}`);
    }
    return { success: true };
  }

  async createEdge(graphId, actorSub, edgeData) {
    await requireRole(this.env.GRAPH_DB, graphId, actorSub, "editor");
    return createEdge(this.env.GRAPH_DB, graphId, edgeData);
  }

  async getNeighbors(graphId, actorSub, nodeId, opts = {}) {
    await requireRole(this.env.GRAPH_DB, graphId, actorSub, "viewer");
    return getNeighbors(this.env.GRAPH_DB, graphId, nodeId, opts);
  }

  async findPaths(graphId, actorSub, fromId, opts = {}) {
    await requireRole(this.env.GRAPH_DB, graphId, actorSub, "viewer");
    return findPaths(this.env.GRAPH_DB, graphId, fromId, opts);
  }

  async findNodeByLabel(graphId, actorSub, type, label) {
    await requireRole(this.env.GRAPH_DB, graphId, actorSub, "viewer");
    return findNodeByLabel(this.env.GRAPH_DB, graphId, type, label);
  }
}

function handleHealth(env) {
  return json({
    service: "graph",
    status: "ok",
    environment: env.ENVIRONMENT ?? "unknown",
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
      list_nodes: "GET /v1/graphs/:graphId/nodes?type=X&label=Y (requires auth + viewer+ access; label filter is case-insensitive)",
      get_node: "GET /v1/graphs/:graphId/nodes/:id (requires auth + viewer+ access)",
      update_node: "PUT /v1/graphs/:graphId/nodes/:id (requires auth + editor/owner access; updates label/properties only)",
      delete_node: "DELETE /v1/graphs/:graphId/nodes/:id (requires auth + editor/owner access; cascades to its edges)",
      create_edge: "POST /v1/graphs/:graphId/edges (requires auth + editor/owner access)",
      neighbors: "GET /v1/graphs/:graphId/nodes/:id/neighbors?relation=&type= (requires auth + viewer+ access)",
      relations: "GET /v1/graphs/:graphId/nodes/:id/relations?to=:otherId (requires auth + viewer+ access)",
      paths: "GET /v1/graphs/:graphId/nodes/:id/paths?to=&maxDepth=&relation=&direction= (requires auth + viewer+ access; multi-hop traversal, maxDepth clamped 1-6)",
      grant_access: "PUT /v1/graphs/:graphId/access/:userId (requires auth + owner access, upserts a collaborator's role)",
      revoke_access: "DELETE /v1/graphs/:graphId/access/:userId (requires auth + owner access, or self-removal with graph:read)",
      list_access: "GET /v1/graphs/:graphId/access (requires auth + viewer+ access)",
    },
    authentication: {
      type: "JWT Bearer Token",
      header: "Authorization: Bearer {token}",
    },
  });
}

// Loads the graph and checks the caller's per-graph role (owner/editor/viewer),
// independent of the coarse graph:read/graph:write RBAC permission already
// checked by requirePermission. Returns null when the graph doesn't exist;
// throws AuthError(403) when it exists but the caller has no sufficient role.
// The role/rank lookup itself lives in requireRole() (graph-db.mjs), shared
// with the RPC methods below, which derive actorSub differently (no JWT).
async function requireGraphMembership(env, graphId, userId, minRole) {
  const graph = await getGraphById(env.GRAPH_DB, graphId);
  if (!graph) {
    return null;
  }

  await requireRole(env.GRAPH_DB, graphId, userId, minRole);

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
    source_document_id: source_document_id || null,
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
  const label = url.searchParams.get("label") || undefined;

  const nodes = await listNodesByType(env.GRAPH_DB, graphId, type, label);
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

async function handleUpdateNode(request, env, graphId, nodeId) {
  const payload = await requirePermission(request, env, "graph:write");

  if (!env.GRAPH_DB) {
    return internalError("Graph database not configured");
  }

  const graph = await requireGraphMembership(env, graphId, payload.sub, "editor");
  if (!graph) return notFound("Graph not found");

  const existing = await getNodeById(env.GRAPH_DB, graphId, nodeId);
  if (!existing) {
    return notFound("Node not found");
  }

  const body = await request.json();
  const { label, properties } = body;

  const node = await updateNode(env.GRAPH_DB, graphId, nodeId, { label, properties });
  return json({ success: true, data: node });
}

async function handleDeleteNode(request, env, graphId, nodeId) {
  const payload = await requirePermission(request, env, "graph:write");

  if (!env.GRAPH_DB) {
    return internalError("Graph database not configured");
  }

  const graph = await requireGraphMembership(env, graphId, payload.sub, "editor");
  if (!graph) return notFound("Graph not found");

  const removed = await deleteNode(env.GRAPH_DB, graphId, nodeId);
  if (!removed) {
    return notFound("Node not found");
  }

  return json({ success: true });
}

async function handleGetNeighbors(request, env, graphId, nodeId, url) {
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

  const relation = url.searchParams.get("relation") || undefined;
  const type = url.searchParams.get("type") || undefined;

  const neighbors = await getNeighbors(env.GRAPH_DB, graphId, nodeId, { relation, type });
  return json({ success: true, data: neighbors, count: neighbors.length });
}

async function handleGetPaths(request, env, graphId, nodeId, url) {
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

  const toId = url.searchParams.get("to") || undefined;
  if (toId) {
    const toNode = await getNodeById(env.GRAPH_DB, graphId, toId);
    if (!toNode) {
      return notFound("to node not found in this graph");
    }
  }

  const maxDepthParam = url.searchParams.get("maxDepth");
  const relation = url.searchParams.get("relation") || undefined;
  const direction = url.searchParams.get("direction") || undefined;

  const data = await findPaths(env.GRAPH_DB, graphId, nodeId, {
    toId,
    maxDepth: maxDepthParam !== null ? Number(maxDepthParam) : undefined,
    relation,
    direction,
  });

  return json({ success: true, mode: toId ? "paths" : "reachable", data, count: data.length });
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
    properties: properties ?? null,
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
