import { json } from "./lib/response.mjs";
import { requireAuth, optionalAuth, AuthError } from "./lib/auth.mjs";
import {
  getAllIngredients,
  getIngredientById,
  getIngredientBySlug,
  createIngredient,
  updateIngredient,
  deleteIngredient,
} from "./lib/ingredients-db.mjs";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      if (pathname === "/health") return handleHealth(env);
      if (pathname === "/") return handleInfo(env);
      if (pathname === "/protected" && request.method === "GET") return handleProtected(request, env);
      if (pathname === "/profile" && request.method === "GET") return handleProfile(request, env);

      const ingredientsMatch = pathname.match(/^\/ingredients(?:\/([^/]+))?$/);
      if (ingredientsMatch) {
        const ingredientId = ingredientsMatch[1];
        if (pathname === "/ingredients" && request.method === "GET") return handleGetAllIngredients(request, env);
        if (pathname === "/ingredients" && request.method === "POST") return handleCreateIngredient(request, env);
        if (ingredientId && pathname === `/ingredients/${ingredientId}` && request.method === "GET") return handleGetIngredient(request, env, ingredientId);
        if (ingredientId && pathname === `/ingredients/${ingredientId}` && request.method === "PUT") return handleUpdateIngredient(request, env, ingredientId);
        if (ingredientId && pathname === `/ingredients/${ingredientId}` && request.method === "DELETE") return handleDeleteIngredient(request, env, ingredientId);
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
    },
    authentication: {
      type: "JWT Bearer Token",
      header: "Authorization: Bearer {token}",
      token_source: "https://dev-auth.0xhackerspace.workers.dev/login",
    },
  });
}

async function handleProtected(request, env) {
  const payload = await requireAuth(request, env);

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
  const payload = await requireAuth(request, env);

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

async function handleCreateIngredient(request, env) {
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

async function handleUpdateIngredient(request, env, ingredientId) {
  if (!env.INGREDIENTS_DB) {
    return json({ error: "Ingredients database not configured" }, 500);
  }

  try {
    const body = await request.json();
    const { nome, slug, type, reference, url, permissions } = body;

    const ingredient = await updateIngredient(env.INGREDIENTS_DB, ingredientId, {
      nome,
      slug,
      type,
      reference,
      url,
      permissions,
    });

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

async function handleDeleteIngredient(request, env, ingredientId) {
  if (!env.INGREDIENTS_DB) {
    return json({ error: "Ingredients database not configured" }, 500);
  }

  try {
    const ingredient = await deleteIngredient(env.INGREDIENTS_DB, ingredientId);

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
