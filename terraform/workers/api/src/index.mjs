import { json } from "./lib/response.mjs";
import { requirePermission, AuthError } from "./lib/auth.mjs";
import {
  getAllIngredients,
  getIngredientById,
  getIngredientBySlug,
  createIngredient,
  updateIngredient,
  deleteIngredient,
} from "./lib/ingredients-db.mjs";
import {
  syncIngredientCreated,
  syncIngredientUpdated,
  syncIngredientDeleted,
  resolveIngredientNode,
  enrichGraphNode,
  GRAPH_ID,
  GRAPH_ACTOR_SUB,
} from "./lib/graph-sync.mjs";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      if (pathname === "/health") return handleHealth(env);
      if (pathname === "/") return handleInfo(env);
      if (pathname === "/protected" && request.method === "GET") return await handleProtected(request, env);
      if (pathname === "/profile" && request.method === "GET") return await handleProfile(request, env);

      const recommendationsMatch = pathname.match(/^\/ingredients\/([^/]+)\/recommendations$/);
      if (recommendationsMatch && request.method === "GET") {
        return await handleGetIngredientRecommendations(request, env, recommendationsMatch[1], url);
      }

      const ingredientsMatch = pathname.match(/^\/ingredients(?:\/([^/]+))?$/);
      if (ingredientsMatch) {
        const ingredientId = ingredientsMatch[1];
        if (pathname === "/ingredients" && request.method === "GET") return await handleGetAllIngredients(request, env);
        if (pathname === "/ingredients" && request.method === "POST") return await handleCreateIngredient(request, env, ctx);
        if (ingredientId && pathname === `/ingredients/${ingredientId}` && request.method === "GET") return await handleGetIngredient(request, env, ingredientId);
        if (ingredientId && pathname === `/ingredients/${ingredientId}` && request.method === "PUT") return await handleUpdateIngredient(request, env, ctx, ingredientId);
        if (ingredientId && pathname === `/ingredients/${ingredientId}` && request.method === "DELETE") return await handleDeleteIngredient(request, env, ctx, ingredientId);
      }

      return json({ error: "Not Found" }, 404);
    } catch (error) {
      if (error instanceof AuthError) {
        return json({ error: error.message }, error.status);
      }
      console.error(error);
      return json({ error: "Internal Server Error" }, 500);
    }
  },
};

function handleHealth(env) {
  return json({
    service: "api",
    status: "ok",
    environment: env.ENVIRONMENT ?? "unknown",
    authentication: "JWT Bearer Token",
  });
}

function handleInfo(env) {
  return json({
    service: "api",
    version: "1.0.0",
    environment: env.ENVIRONMENT ?? "unknown",
    endpoints: {
      health: "GET /health",
      info: "GET /",
      protected: "GET /protected (requires auth)",
      profile: "GET /profile (requires auth)",
      recommendations: "GET /ingredients/:id/recommendations?relation=&indirect=&maxDepth= (requires auth, ingredient:read)",
    },
    authentication: {
      type: "JWT Bearer Token",
      header: "Authorization: Bearer {token}",
      token_source: "https://dev-auth.0xhackerspace.workers.dev/login",
    },
  });
}

async function handleProtected(request, env) {
  const payload = await requirePermission(request, env, "api:access");

  return json({
    message: "Access to protected resource granted",
    user: {
      sub: payload.sub,
      username: payload.username,
    },
    token_info: {
      issued_at: new Date(payload.iat * 1000).toISOString(),
      expires_at: new Date(payload.exp * 1000).toISOString(),
      type: payload.type,
    },
  });
}

async function handleProfile(request, env) {
  const payload = await requirePermission(request, env, "api:access");

  return json({
    profile: {
      username: payload.username,
      subject: payload.sub,
      authenticated: true,
      token_type: payload.type,
      issued_at: new Date(payload.iat * 1000).toISOString(),
      expires_at: new Date(payload.exp * 1000).toISOString(),
    },
  });
}

async function handleGetAllIngredients(request, env) {
  await requirePermission(request, env, "ingredient:read");

  if (!env.INGREDIENTS_DB) {
    return json({ error: "Ingredients database not configured" }, 500);
  }

  try {
    const ingredients = await getAllIngredients(env.INGREDIENTS_DB);
    return json({
      success: true,
      data: ingredients,
      count: ingredients.length,
    });
  } catch (error) {
    console.error("Get ingredients error:", error);
    return json({ error: error.message }, 500);
  }
}

async function handleGetIngredient(request, env, ingredientId) {
  await requirePermission(request, env, "ingredient:read");

  if (!env.INGREDIENTS_DB) {
    return json({ error: "Ingredients database not configured" }, 500);
  }

  try {
    const ingredient = await getIngredientById(env.INGREDIENTS_DB, ingredientId);
    if (!ingredient) {
      return json({ error: "Ingredient not found" }, 404);
    }

    return json({
      success: true,
      data: ingredient,
    });
  } catch (error) {
    console.error("Get ingredient error:", error);
    return json({ error: error.message }, 500);
  }
}

async function handleCreateIngredient(request, env, ctx) {
  await requirePermission(request, env, "ingredient:create");

  if (!env.INGREDIENTS_DB) {
    return json({ error: "Ingredients database not configured" }, 500);
  }

  try {
    const body = await request.json();
    const { nome, slug, type, reference, url, permissions } = body;

    if (!nome || !slug || !type) {
      return json({ error: "Missing required fields: nome, slug, type" }, 400);
    }

    const id = crypto.randomUUID();
    const ingredient = await createIngredient(env.INGREDIENTS_DB, {
      id,
      nome,
      slug,
      type,
      reference: reference || null,
      url: url || null,
      permissions: permissions || null,
    });

    syncIngredientCreated(env, ctx, ingredient);

    return json({
      success: true,
      data: ingredient,
    }, 201);
  } catch (error) {
    console.error("Create ingredient error:", error);
    if (error.message.includes("already exists")) {
      return json({ error: error.message }, 409);
    }
    return json({ error: error.message }, 500);
  }
}

async function handleUpdateIngredient(request, env, ctx, ingredientId) {
  await requirePermission(request, env, "ingredient:update");

  if (!env.INGREDIENTS_DB) {
    return json({ error: "Ingredients database not configured" }, 500);
  }

  try {
    const body = await request.json();
    const { nome, slug, type, reference, url, permissions } = body;

    const before = await getIngredientById(env.INGREDIENTS_DB, ingredientId);

    const ingredient = await updateIngredient(env.INGREDIENTS_DB, ingredientId, {
      nome,
      slug,
      type,
      reference,
      url,
      permissions,
    });

    syncIngredientUpdated(env, ctx, before, ingredient);

    return json({
      success: true,
      data: ingredient,
    });
  } catch (error) {
    console.error("Update ingredient error:", error);
    if (error.message.includes("not found")) {
      return json({ error: error.message }, 404);
    }
    if (error.message.includes("already exists")) {
      return json({ error: error.message }, 409);
    }
    return json({ error: error.message }, 500);
  }
}

async function handleDeleteIngredient(request, env, ctx, ingredientId) {
  await requirePermission(request, env, "ingredient:delete");

  if (!env.INGREDIENTS_DB) {
    return json({ error: "Ingredients database not configured" }, 500);
  }

  try {
    const ingredient = await deleteIngredient(env.INGREDIENTS_DB, ingredientId);

    syncIngredientDeleted(env, ctx, ingredient);

    return json({
      success: true,
      data: ingredient,
      message: "Ingredient deleted successfully",
    });
  } catch (error) {
    console.error("Delete ingredient error:", error);
    if (error.message.includes("not found")) {
      return json({ error: error.message }, 404);
    }
    return json({ error: error.message }, 500);
  }
}

async function handleGetIngredientRecommendations(request, env, ingredientId, url) {
  await requirePermission(request, env, "ingredient:read");

  if (!env.INGREDIENTS_DB) {
    return json({ error: "Ingredients database not configured" }, 500);
  }

  if (!env.GRAPH_WORKER) {
    return json({ error: "Graph recommendations are not available: GRAPH_WORKER binding not configured" }, 501);
  }

  try {
    const ingredient = await getIngredientById(env.INGREDIENTS_DB, ingredientId);
    if (!ingredient) {
      return json({ error: "Ingredient not found" }, 404);
    }

    const relation = url.searchParams.get("relation") || undefined;
    const indirect = url.searchParams.get("indirect") === "true";
    const maxDepth = Number(url.searchParams.get("maxDepth")) || 2;

    const node = await resolveIngredientNode(env, ingredient);
    if (!node) {
      // Ingredient exists in D1 but has no graph node yet (e.g. created before
      // GRAPH_WORKER was configured, or the best-effort create-sync failed).
      return json({ success: true, data: [], count: 0 });
    }

    if (indirect) {
      const reachable = await env.GRAPH_WORKER.findPaths(GRAPH_ID, GRAPH_ACTOR_SUB, node.id, { relation, maxDepth });
      const data = await Promise.all(
        reachable.map(async (entry) => ({
          ...(await enrichGraphNode(env, entry.node)),
          relation: entry.path[entry.path.length - 1]?.relation ?? null,
          distance: entry.distance,
        })),
      );
      return json({ success: true, mode: "indirect", data, count: data.length });
    }

    const neighbors = await env.GRAPH_WORKER.getNeighbors(GRAPH_ID, GRAPH_ACTOR_SUB, node.id, { relation });
    const data = await Promise.all(
      neighbors.map(async (entry) => ({
        ...(await enrichGraphNode(env, entry.neighbor)),
        relation: entry.relation,
        direction: entry.direction,
      })),
    );
    return json({ success: true, mode: "direct", data, count: data.length });
  } catch (error) {
    console.error("Get ingredient recommendations error:", error);
    return json({ error: error.message }, 500);
  }
}
