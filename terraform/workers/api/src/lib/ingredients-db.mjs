export async function getAllIngredients(db) {
  if (!db) {
    throw new Error("Database not configured");
  }

  const results = await db
    .prepare("SELECT id, nome, slug, type, reference, url, permissions, created_at, updated_at FROM ingredients ORDER BY nome")
    .all();

  return results.results || [];
}

export async function getIngredientById(db, id) {
  if (!db) {
    throw new Error("Database not configured");
  }

  const result = await db
    .prepare("SELECT id, nome, slug, type, reference, url, permissions, created_at, updated_at FROM ingredients WHERE id = ?")
    .bind(id)
    .first();

  return result || null;
}

export async function getIngredientBySlug(db, slug) {
  if (!db) {
    throw new Error("Database not configured");
  }

  const result = await db
    .prepare("SELECT id, nome, slug, type, reference, url, permissions, created_at, updated_at FROM ingredients WHERE slug = ?")
    .bind(slug)
    .first();

  return result || null;
}

export async function createIngredient(db, { id, nome, slug, type, reference, url, permissions }) {
  if (!db) {
    throw new Error("Database not configured");
  }

  const existingSlug = await getIngredientBySlug(db, slug);
  if (existingSlug) {
    throw new Error("Ingredient with this slug already exists");
  }

  const result = await db
    .prepare(
      "INSERT INTO ingredients (id, nome, slug, type, reference, url, permissions) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(id, nome, slug, type, reference || null, url || null, permissions || null)
    .run();

  if (!result.success) {
    throw new Error("Failed to create ingredient");
  }

  return getIngredientById(db, id);
}

export async function updateIngredient(db, id, { nome, slug, type, reference, url, permissions }) {
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

  if (nome !== undefined) {
    updates.push("nome = ?");
    values.push(nome);
  }
  if (slug !== undefined) {
    updates.push("slug = ?");
    values.push(slug);
  }
  if (type !== undefined) {
    updates.push("type = ?");
    values.push(type);
  }
  if (reference !== undefined) {
    updates.push("reference = ?");
    values.push(reference);
  }
  if (url !== undefined) {
    updates.push("url = ?");
    values.push(url);
  }
  if (permissions !== undefined) {
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

export async function deleteIngredient(db, id) {
  if (!db) {
    throw new Error("Database not configured");
  }

  const existing = await getIngredientById(db, id);
  if (!existing) {
    throw new Error("Ingredient not found");
  }

  const result = await db
    .prepare("DELETE FROM ingredients WHERE id = ?")
    .bind(id)
    .run();

  if (!result.success) {
    throw new Error("Failed to delete ingredient");
  }

  return existing;
}
