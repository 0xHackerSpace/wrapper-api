import { json, badRequest, notFound, internalError, conflict } from "./lib/response.mjs";
import { requirePermission, AuthError } from "./lib/auth.mjs";
import {
  getNodeById,
  listNodesByType,
  createNode,
  getNeighbors,
  getRelationsBetween,
  createEdge,
  ValidationError,
  ConflictError,
} from "./lib/graph-db.mjs";

export default {
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
      relations: "GET /v1/nodes/:id/relations?to=:otherId (requires auth)",
    },
    authentication: {
      type: "JWT Bearer Token",
      header: "Authorization: Bearer {token}",
    },
  });
}

async function handleCreateNode(request, env) {
  await requirePermission(request, env, "graph:write");

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
    source_document_id: source_document_id || null,
  });

  return json({ success: true, data: node }, 201);
}

async function handleListNodes(request, env, url) {
  await requirePermission(request, env, "graph:read");

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
  await requirePermission(request, env, "graph:read");

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
  await requirePermission(request, env, "graph:read");

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
  await requirePermission(request, env, "graph:read");

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
  await requirePermission(request, env, "graph:write");

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
    properties: properties ?? null,
  });

  return json({ success: true, data: edge }, 201);
}
