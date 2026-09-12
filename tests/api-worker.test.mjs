// Runs with the Node.js test runner and no dependencies: node --test tests
import assert from "node:assert/strict";
import test from "node:test";

import worker from "../terraform/workers/api/src/index.mjs";
import { generateToken } from "../terraform/workers/api/src/lib/jwt.mjs";

function createIngredientsDB(seed = []) {
  const rows = [...seed];

  function makeStatement(sql) {
    let boundArgs = [];
    return {
      bind(...args) {
        boundArgs = args;
        return this;
      },
      async all() {
        if (sql.includes("ORDER BY nome")) {
          return { results: [...rows].sort((a, b) => a.nome.localeCompare(b.nome)) };
        }
        return { results: [...rows] };
      },
      async first() {
        if (sql.includes("WHERE id = ?")) {
          return rows.find((r) => r.id === boundArgs[0]) || null;
        }
        if (sql.includes("WHERE slug = ?")) {
          return rows.find((r) => r.slug === boundArgs[0]) || null;
        }
        return null;
      },
      async run() {
        if (sql.startsWith("INSERT INTO ingredients")) {
          const [id, nome, slug, type, reference, url, permissions] = boundArgs;
          const now = new Date().toISOString();
          rows.push({ id, nome, slug, type, reference, url, permissions, created_at: now, updated_at: now });
          return { success: true };
        }
        if (sql.startsWith("UPDATE ingredients")) {
          const id = boundArgs[boundArgs.length - 1];
          const row = rows.find((r) => r.id === id);
          if (!row) return { success: false };

          const setClause = sql.match(/SET (.+) WHERE/)[1];
          const fields = setClause.split(",").map((s) => s.trim());
          let argIndex = 0;
          for (const field of fields) {
            const [name, value] = field.split("=").map((s) => s.trim());
            if (value === "?") {
              row[name] = boundArgs[argIndex++];
            } else if (value === "CURRENT_TIMESTAMP") {
              row[name] = new Date().toISOString();
            }
          }
          return { success: true };
        }
        if (sql.startsWith("DELETE FROM ingredients")) {
          const index = rows.findIndex((r) => r.id === boundArgs[0]);
          if (index === -1) return { success: false };
          rows.splice(index, 1);
          return { success: true };
        }
        return { success: false };
      },
    };
  }

  return {
    prepare: (sql) => makeStatement(sql),
    _rows: rows,
  };
}

const JWT_SECRET = "test-secret";

function harness(overrides = {}) {
  const db = "INGREDIENTS_DB" in overrides ? overrides.INGREDIENTS_DB : createIngredientsDB();
  const env = {
    ENVIRONMENT: "test",
    JWT_SECRET,
    ...overrides,
    INGREDIENTS_DB: db,
  };

  const call = async (path, init) => {
    const response = await worker.fetch(new Request(`https://api.test${path}`, init), env, {});
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  const get = (path, headers = {}) => call(path, { method: "GET", headers });
  const post = (path, body, headers = {}) =>
    call(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });
  const put = (path, body, headers = {}) =>
    call(path, { method: "PUT", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });
  const del = (path, headers = {}) => call(path, { method: "DELETE", headers });

  return { env, db, call, get, post, put, del };
}

async function authHeader(payload = { sub: "user-1", username: "ianoliv" }) {
  const token = await generateToken(payload, JWT_SECRET);
  return { authorization: `Bearer ${token}` };
}

test("GET /health reports service status", async () => {
  const { get } = harness();
  const { status, body } = await get("/health");

  assert.equal(status, 200);
  assert.equal(body.service, "api");
  assert.equal(body.status, "ok");
});

test("GET / lists available endpoints", async () => {
  const { get } = harness();
  const { status, body } = await get("/");

  assert.equal(status, 200);
  assert.equal(body.service, "api");
  assert.ok(body.endpoints.protected);
});

test("GET /protected requires a valid JWT", async () => {
  const { get } = harness();

  assert.equal((await get("/protected")).status, 401);
  assert.equal((await get("/protected", { authorization: "Bearer invalid" })).status, 401);

  const headers = await authHeader();
  const { status, body } = await get("/protected", headers);
  assert.equal(status, 200);
  assert.equal(body.user.username, "ianoliv");
});

test("GET /profile returns the authenticated user's profile", async () => {
  const { get } = harness();
  const headers = await authHeader({ sub: "user-1", username: "ianoliv" });

  const { status, body } = await get("/profile", headers);
  assert.equal(status, 200);
  assert.equal(body.profile.username, "ianoliv");
  assert.equal(body.profile.authenticated, true);
});

test("POST /ingredients creates an ingredient with required fields", async () => {
  const { post, db } = harness();

  const { status, body } = await post("/ingredients", { nome: "Alho", slug: "alho", type: "tempero" });

  assert.equal(status, 201);
  assert.equal(body.success, true);
  assert.equal(body.data.nome, "Alho");
  assert.equal(db._rows.length, 1);
});

test("POST /ingredients rejects missing required fields", async () => {
  const { post } = harness();

  const { status, body } = await post("/ingredients", { nome: "Alho" });

  assert.equal(status, 400);
  assert.match(body.error, /Missing required fields/);
});

test("POST /ingredients rejects duplicate slugs", async () => {
  const { post } = harness({
    INGREDIENTS_DB: createIngredientsDB([
      { id: "1", nome: "Alho", slug: "alho", type: "tempero", reference: null, url: null, permissions: null },
    ]),
  });

  const { status, body } = await post("/ingredients", { nome: "Alho 2", slug: "alho", type: "tempero" });

  assert.equal(status, 409);
  assert.match(body.error, /already exists/);
});

test("GET /ingredients lists all ingredients ordered by nome", async () => {
  const { get } = harness({
    INGREDIENTS_DB: createIngredientsDB([
      { id: "2", nome: "Cebola", slug: "cebola", type: "vegetal", reference: null, url: null, permissions: null },
      { id: "1", nome: "Alho", slug: "alho", type: "tempero", reference: null, url: null, permissions: null },
    ]),
  });

  const { status, body } = await get("/ingredients");

  assert.equal(status, 200);
  assert.equal(body.count, 2);
  assert.equal(body.data[0].nome, "Alho");
  assert.equal(body.data[1].nome, "Cebola");
});

test("GET /ingredients/:id returns a single ingredient or 404", async () => {
  const { get } = harness({
    INGREDIENTS_DB: createIngredientsDB([
      { id: "1", nome: "Alho", slug: "alho", type: "tempero", reference: null, url: null, permissions: null },
    ]),
  });

  const found = await get("/ingredients/1");
  assert.equal(found.status, 200);
  assert.equal(found.body.data.nome, "Alho");

  const notFound = await get("/ingredients/missing");
  assert.equal(notFound.status, 404);
});

test("PUT /ingredients/:id updates fields and rejects unknown id", async () => {
  const { put } = harness({
    INGREDIENTS_DB: createIngredientsDB([
      { id: "1", nome: "Alho", slug: "alho", type: "tempero", reference: null, url: null, permissions: null },
    ]),
  });

  const { status, body } = await put("/ingredients/1", { nome: "Alho fresco" });
  assert.equal(status, 200);
  assert.equal(body.data.nome, "Alho fresco");
  assert.equal(body.data.slug, "alho");

  const missing = await put("/ingredients/missing", { nome: "x" });
  assert.equal(missing.status, 404);
});

test("DELETE /ingredients/:id removes the ingredient and rejects unknown id", async () => {
  const { del, db } = harness({
    INGREDIENTS_DB: createIngredientsDB([
      { id: "1", nome: "Alho", slug: "alho", type: "tempero", reference: null, url: null, permissions: null },
    ]),
  });

  const { status, body } = await del("/ingredients/1");
  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.equal(db._rows.length, 0);

  const missing = await del("/ingredients/1");
  assert.equal(missing.status, 404);
});

test("ingredient routes fail closed when INGREDIENTS_DB is not configured", async () => {
  const { get, post } = harness({ INGREDIENTS_DB: null });

  assert.equal((await get("/ingredients")).status, 500);
  assert.equal((await post("/ingredients", { nome: "x", slug: "y", type: "z" })).status, 500);
});

test("unknown routes return 404", async () => {
  const { get } = harness();
  const { status, body } = await get("/unknown");

  assert.equal(status, 404);
  assert.equal(body.error, "Not Found");
});
