import { json, badRequest, notFound, internalError, conflict } from "./lib/response.mjs";
import { requirePermission, AuthError } from "./lib/auth.mjs";
import {
  getGraphById,
  createGraph,
  listGraphsForUser,
  getGraphAccess,
  getNodeById,
  listNodesByType,
  createNode,
  getNeighbors,
  getRelationsBetween,
  createEdge,
  ValidationError,
  ConflictError,
} from "./lib/graph-db.mjs";

const ROLE_RANK = { viewer: 1, editor: 2, owner: 3 };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      if (pathname === "/health") return handleHealth(env);
      if (pathname === "/" || pathname === "/v1") return handleInfo(env);

      if (pathname === "/v1/graphs" && request.method === "POST") return await handleCreateGraph(request, env);
      if (pathname === "/v1/graphs" && request.method === "GET") return await handleListGraphs(request, env);

      const graphMatch = pathname.match(/^\/v1\/graphs\/([^/]+)(?:\/(nodes|edges)(?:\/([^/]+)(?:\/(neighbors|relations))?)?)?$/);
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
  },
};

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
      list_nodes: "GET /v1/graphs/:graphId/nodes?type=X (requires auth + viewer+ access)",
      get_node: "GET /v1/graphs/:graphId/nodes/:id (requires auth + viewer+ access)",
      create_edge: "POST /v1/graphs/:graphId/edges (requires auth + editor/owner access)",
      neighbors: "GET /v1/graphs/:graphId/nodes/:id/neighbors (requires auth + viewer+ access)",
      relations: "GET /v1/graphs/:graphId/nodes/:id/relations?to=:otherId (requires auth + viewer+ access)",
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
    properties: properties ?? null,
  });

  return json({ success: true, data: edge }, 201);
}
