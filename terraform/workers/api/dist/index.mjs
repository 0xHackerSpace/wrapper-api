// terraform/workers/api/src/lib/response.mjs
function json(body, statusOrInit = {}) {
  const init = typeof statusOrInit === "number" ? { status: statusOrInit } : statusOrInit;
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...init.headers
    }
  });
}

// terraform/workers/api/src/lib/jwt.mjs
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

// terraform/workers/api/src/lib/auth.mjs
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

// terraform/workers/api/src/lib/ingredients-db.mjs
async function getAllIngredients(db) {
  if (!db) {
    throw new Error("Database not configured");
  }
  const results = await db.prepare("SELECT id, nome, slug, type, reference, url, permissions, created_at, updated_at FROM ingredients ORDER BY nome").all();
  return results.results || [];
}
async function getIngredientById(db, id) {
  if (!db) {
    throw new Error("Database not configured");
  }
  const result = await db.prepare("SELECT id, nome, slug, type, reference, url, permissions, created_at, updated_at FROM ingredients WHERE id = ?").bind(id).first();
  return result || null;
}
async function getIngredientBySlug(db, slug) {
  if (!db) {
    throw new Error("Database not configured");
  }
  const result = await db.prepare("SELECT id, nome, slug, type, reference, url, permissions, created_at, updated_at FROM ingredients WHERE slug = ?").bind(slug).first();
  return result || null;
}
async function createIngredient(db, { id, nome, slug, type, reference, url, permissions }) {
  if (!db) {
    throw new Error("Database not configured");
  }
  const existingSlug = await getIngredientBySlug(db, slug);
  if (existingSlug) {
    throw new Error("Ingredient with this slug already exists");
  }
  const result = await db.prepare(
    "INSERT INTO ingredients (id, nome, slug, type, reference, url, permissions) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).bind(id, nome, slug, type, reference || null, url || null, permissions || null).run();
  if (!result.success) {
    throw new Error("Failed to create ingredient");
  }
  return getIngredientById(db, id);
}
async function updateIngredient(db, id, { nome, slug, type, reference, url, permissions }) {
  if (!db) {
    throw new Error("Database not configured");
  }
  const existing = await getIngredientById(db, id);
  if (!existing) {
    throw new Error("Ingredient not found");
  }
  if (slug && slug !== existing.slug) {
    const existingSlug = await getIngredientBySlug(db, slug);
    if (existingSlug) {
      throw new Error("Ingredient with this slug already exists");
    }
  }
  const updates = [];
  const values = [];
  if (nome !== void 0) {
    updates.push("nome = ?");
    values.push(nome);
  }
  if (slug !== void 0) {
    updates.push("slug = ?");
    values.push(slug);
  }
  if (type !== void 0) {
    updates.push("type = ?");
    values.push(type);
  }
  if (reference !== void 0) {
    updates.push("reference = ?");
    values.push(reference);
  }
  if (url !== void 0) {
    updates.push("url = ?");
    values.push(url);
  }
  if (permissions !== void 0) {
    updates.push("permissions = ?");
    values.push(permissions);
  }
  if (updates.length === 0) {
    return existing;
  }
  updates.push("updated_at = CURRENT_TIMESTAMP");
  values.push(id);
  const query = `UPDATE ingredients SET ${updates.join(", ")} WHERE id = ?`;
  const result = await db.prepare(query).bind(...values).run();
  if (!result.success) {
    throw new Error("Failed to update ingredient");
  }
  return getIngredientById(db, id);
}
async function deleteIngredient(db, id) {
  if (!db) {
    throw new Error("Database not configured");
  }
  const existing = await getIngredientById(db, id);
  if (!existing) {
    throw new Error("Ingredient not found");
  }
  const result = await db.prepare("DELETE FROM ingredients WHERE id = ?").bind(id).run();
  if (!result.success) {
    throw new Error("Failed to delete ingredient");
  }
  return existing;
}

// terraform/workers/api/src/index.mjs
var index_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;
    try {
      if (pathname === "/health") return handleHealth(env);
      if (pathname === "/") return handleInfo(env);
      if (pathname === "/protected" && request.method === "GET") return await handleProtected(request, env);
      if (pathname === "/profile" && request.method === "GET") return await handleProfile(request, env);
      const ingredientsMatch = pathname.match(/^\/ingredients(?:\/([^/]+))?$/);
      if (ingredientsMatch) {
        const ingredientId = ingredientsMatch[1];
        if (pathname === "/ingredients" && request.method === "GET") return await handleGetAllIngredients(request, env);
        if (pathname === "/ingredients" && request.method === "POST") return await handleCreateIngredient(request, env);
        if (ingredientId && pathname === `/ingredients/${ingredientId}` && request.method === "GET") return await handleGetIngredient(request, env, ingredientId);
        if (ingredientId && pathname === `/ingredients/${ingredientId}` && request.method === "PUT") return await handleUpdateIngredient(request, env, ingredientId);
        if (ingredientId && pathname === `/ingredients/${ingredientId}` && request.method === "DELETE") return await handleDeleteIngredient(request, env, ingredientId);
      }
      return json({ error: "Not Found" }, 404);
    } catch (error) {
      if (error instanceof AuthError) {
        return json({ error: error.message }, error.status);
      }
      console.error(error);
      return json({ error: "Internal Server Error" }, 500);
    }
  }
};
function handleHealth(env) {
  return json({
    service: "api",
    status: "ok",
    environment: env.ENVIRONMENT ?? "unknown",
    authentication: "JWT Bearer Token"
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
      profile: "GET /profile (requires auth)"
    },
    authentication: {
      type: "JWT Bearer Token",
      header: "Authorization: Bearer {token}",
      token_source: "https://dev-auth.0xhackerspace.workers.dev/login"
    }
  });
}
async function handleProtected(request, env) {
  const payload = await requirePermission(request, env, "api:access");
  return json({
    message: "Access to protected resource granted",
    user: {
      sub: payload.sub,
      username: payload.username
    },
    token_info: {
      issued_at: new Date(payload.iat * 1e3).toISOString(),
      expires_at: new Date(payload.exp * 1e3).toISOString(),
      type: payload.type
    }
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
      issued_at: new Date(payload.iat * 1e3).toISOString(),
      expires_at: new Date(payload.exp * 1e3).toISOString()
    }
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
      count: ingredients.length
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
      data: ingredient
    });
  } catch (error) {
    console.error("Get ingredient error:", error);
    return json({ error: error.message }, 500);
  }
}
async function handleCreateIngredient(request, env) {
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
      permissions: permissions || null
    });
    return json({
      success: true,
      data: ingredient
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
  await requirePermission(request, env, "ingredient:update");
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
      permissions
    });
    return json({
      success: true,
      data: ingredient
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
  await requirePermission(request, env, "ingredient:delete");
  if (!env.INGREDIENTS_DB) {
    return json({ error: "Ingredients database not configured" }, 500);
  }
  try {
    const ingredient = await deleteIngredient(env.INGREDIENTS_DB, ingredientId);
    return json({
      success: true,
      data: ingredient,
      message: "Ingredient deleted successfully"
    });
  } catch (error) {
    console.error("Delete ingredient error:", error);
    if (error.message.includes("not found")) {
      return json({ error: error.message }, 404);
    }
    return json({ error: error.message }, 500);
  }
}
export {
  index_default as default
};
