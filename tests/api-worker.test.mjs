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
        // Real D1 always returns a fresh row object per query -- callers that
        // snapshot a row before mutating it (e.g. the graph-sync "before"
        // capture in handleUpdateIngredient) must not see later mutations
        // through that reference, so copy rather than returning the live row.
        if (sql.includes("WHERE id = ?")) {
          const row = rows.find((r) => r.id === boundArgs[0]);
          return row ? { ...row } : null;
        }
        if (sql.includes("WHERE slug = ?")) {
          const row = rows.find((r) => r.slug === boundArgs[0]);
          return row ? { ...row } : null;
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

// Minimal fake of the GRAPH_WORKER Service Binding (env.GRAPH_WORKER), covering
// the RPC surface api-worker calls: create/update/delete keep an in-memory
// `nodes` list in sync (so rename/delete flows can be asserted end to end),
// while getNeighbors/findPaths are driven by caller-supplied fixtures since
// the graph-worker's own tests already cover real traversal behavior.
function createGraphWorkerMock({ nodes = [], neighborsByNodeId = {}, pathsByNodeId = {}, failUpsert = false } = {}) {
  const calls = { upsertNode: [], updateNode: [], deleteNode: [], findNodeByLabel: [], getNeighbors: [], findPaths: [] };
  let nextId = nodes.length + 1;

  return {
    nodes,
    calls,
    async upsertNode(graphId, actorSub, nodeData) {
      calls.upsertNode.push({ graphId, actorSub, nodeData });
      if (failUpsert) {
        throw new Error("graph worker unavailable");
      }
      const id = nodeData.id || `node-${nextId++}`;
      const node = { id, graph_id: graphId, type: nodeData.type, label: nodeData.label, properties: nodeData.properties ?? null };
      nodes.push(node);
      return node;
    },
    async updateNode(graphId, actorSub, nodeId, patch) {
      calls.updateNode.push({ graphId, actorSub, nodeId, patch });
      const node = nodes.find((n) => n.id === nodeId);
      if (!node) throw new Error(`Node not found: ${nodeId}`);
      if (patch.label !== undefined) node.label = patch.label;
      if (patch.properties !== undefined) node.properties = patch.properties;
      return node;
    },
    async deleteNode(graphId, actorSub, nodeId) {
      calls.deleteNode.push({ graphId, actorSub, nodeId });
      const index = nodes.findIndex((n) => n.id === nodeId);
      if (index === -1) throw new Error(`Node not found: ${nodeId}`);
      nodes.splice(index, 1);
      return { success: true };
    },
    async findNodeByLabel(graphId, actorSub, type, label) {
      calls.findNodeByLabel.push({ graphId, actorSub, type, label });
      return nodes.find((n) => n.graph_id === graphId && n.type === type && n.label.toLowerCase() === label.toLowerCase()) || null;
    },
    async getNeighbors(graphId, actorSub, nodeId, opts = {}) {
      calls.getNeighbors.push({ graphId, actorSub, nodeId, opts });
      return neighborsByNodeId[nodeId] || [];
    },
    async findPaths(graphId, actorSub, fromId, opts = {}) {
      calls.findPaths.push({ graphId, actorSub, fromId, opts });
      return pathsByNodeId[fromId] || [];
    },
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

  // Captures promises passed to ctx.waitUntil() and drains them before
  // resolving, so tests can assert on best-effort graph-sync side effects
  // right after awaiting the call, without racing the fire-and-forget work.
  const call = async (path, init) => {
    const pending = [];
    const ctx = { waitUntil: (promise) => pending.push(promise) };
    const response = await worker.fetch(new Request(`https://api.test${path}`, init), env, ctx);
    const text = await response.text();
    await Promise.allSettled(pending);
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

const ALL_INGREDIENT_PERMISSIONS = ["api:access", "ingredient:read", "ingredient:create", "ingredient:update", "ingredient:delete"];

async function authHeader(payload = { sub: "user-1", username: "ianoliv", permissions: ALL_INGREDIENT_PERMISSIONS }) {
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

test("GET /protected requires a valid JWT with the api:access permission", async () => {
  const { get } = harness();

  assert.equal((await get("/protected")).status, 401);
  assert.equal((await get("/protected", { authorization: "Bearer invalid" })).status, 401);

  const noPermission = await authHeader({ sub: "user-1", username: "ianoliv", permissions: [] });
  assert.equal((await get("/protected", noPermission)).status, 403);

  const headers = await authHeader();
  const { status, body } = await get("/protected", headers);
  assert.equal(status, 200);
  assert.equal(body.user.username, "ianoliv");
});

test("GET /profile returns the authenticated user's profile", async () => {
  const { get } = harness();
  const headers = await authHeader({ sub: "user-1", username: "ianoliv", permissions: ["api:access"] });

  const { status, body } = await get("/profile", headers);
  assert.equal(status, 200);
  assert.equal(body.profile.username, "ianoliv");
  assert.equal(body.profile.authenticated, true);
});

test("POST /ingredients requires the ingredient:create permission", async () => {
  const { post } = harness();

  assert.equal((await post("/ingredients", { nome: "Alho", slug: "alho", type: "tempero" })).status, 401);

  const noPermission = await authHeader({ sub: "user-1", username: "ianoliv", permissions: [] });
  assert.equal(
    (await post("/ingredients", { nome: "Alho", slug: "alho", type: "tempero" }, noPermission)).status,
    403,
  );

  const readOnly = await authHeader({ sub: "user-1", username: "ianoliv", permissions: ["ingredient:read"] });
  assert.equal(
    (await post("/ingredients", { nome: "Alho", slug: "alho", type: "tempero" }, readOnly)).status,
    403,
    "ingredient:read alone must not grant ingredient:create",
  );
});

test("ingredient CRUD permissions are enforced independently per method", async () => {
  const { get, post, put, del } = harness({
    INGREDIENTS_DB: createIngredientsDB([
      { id: "1", nome: "Alho", slug: "alho", type: "tempero", reference: null, url: null, permissions: null },
    ]),
  });
  const readOnly = await authHeader({ sub: "user-1", permissions: ["ingredient:read"] });

  assert.equal((await get("/ingredients", readOnly)).status, 200);
  assert.equal((await post("/ingredients", { nome: "Cebola", slug: "cebola", type: "vegetal" }, readOnly)).status, 403);
  assert.equal((await put("/ingredients/1", { nome: "Alho fresco" }, readOnly)).status, 403);
  assert.equal((await del("/ingredients/1", readOnly)).status, 403);
});

test("POST /ingredients creates an ingredient with required fields", async () => {
  const { post, db } = harness();
  const headers = await authHeader();

  const { status, body } = await post("/ingredients", { nome: "Alho", slug: "alho", type: "tempero" }, headers);

  assert.equal(status, 201);
  assert.equal(body.success, true);
  assert.equal(body.data.nome, "Alho");
  assert.equal(db._rows.length, 1);
});

test("POST /ingredients rejects missing required fields", async () => {
  const { post } = harness();
  const headers = await authHeader();

  const { status, body } = await post("/ingredients", { nome: "Alho" }, headers);

  assert.equal(status, 400);
  assert.match(body.error, /Missing required fields/);
});

test("POST /ingredients rejects duplicate slugs", async () => {
  const { post } = harness({
    INGREDIENTS_DB: createIngredientsDB([
      { id: "1", nome: "Alho", slug: "alho", type: "tempero", reference: null, url: null, permissions: null },
    ]),
  });
  const headers = await authHeader();

  const { status, body } = await post("/ingredients", { nome: "Alho 2", slug: "alho", type: "tempero" }, headers);

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
  const headers = await authHeader();

  const { status, body } = await get("/ingredients", headers);

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
  const headers = await authHeader();

  const found = await get("/ingredients/1", headers);
  assert.equal(found.status, 200);
  assert.equal(found.body.data.nome, "Alho");

  const notFound = await get("/ingredients/missing", headers);
  assert.equal(notFound.status, 404);
});

test("PUT /ingredients/:id updates fields and rejects unknown id", async () => {
  const { put } = harness({
    INGREDIENTS_DB: createIngredientsDB([
      { id: "1", nome: "Alho", slug: "alho", type: "tempero", reference: null, url: null, permissions: null },
    ]),
  });
  const headers = await authHeader();

  const { status, body } = await put("/ingredients/1", { nome: "Alho fresco" }, headers);
  assert.equal(status, 200);
  assert.equal(body.data.nome, "Alho fresco");
  assert.equal(body.data.slug, "alho");

  const missing = await put("/ingredients/missing", { nome: "x" }, headers);
  assert.equal(missing.status, 404);
});

test("DELETE /ingredients/:id removes the ingredient and rejects unknown id", async () => {
  const { del, db } = harness({
    INGREDIENTS_DB: createIngredientsDB([
      { id: "1", nome: "Alho", slug: "alho", type: "tempero", reference: null, url: null, permissions: null },
    ]),
  });
  const headers = await authHeader();

  const { status, body } = await del("/ingredients/1", headers);
  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.equal(db._rows.length, 0);

  const missing = await del("/ingredients/1", headers);
  assert.equal(missing.status, 404);
});

test("ingredient routes fail closed when INGREDIENTS_DB is not configured", async () => {
  const { get, post } = harness({ INGREDIENTS_DB: null });
  const headers = await authHeader();

  assert.equal((await get("/ingredients", headers)).status, 500);
  assert.equal((await post("/ingredients", { nome: "x", slug: "y", type: "z" }, headers)).status, 500);
});

test("unknown routes return 404", async () => {
  const { get } = harness();
  const { status, body } = await get("/unknown");

  assert.equal(status, 404);
  assert.equal(body.error, "Not Found");
});

test("POST /ingredients syncs the new ingredient to the graph via upsertNode (best-effort)", async () => {
  const graphWorker = createGraphWorkerMock();
  const { post } = harness({ GRAPH_WORKER: graphWorker });
  const headers = await authHeader();

  const { status, body } = await post("/ingredients", { nome: "Alho", slug: "alho", type: "tempero" }, headers);

  assert.equal(status, 201);
  assert.equal(graphWorker.calls.upsertNode.length, 1);
  const call = graphWorker.calls.upsertNode[0];
  assert.equal(call.graphId, "ingredients");
  assert.equal(call.actorSub, "svc-api-ingredients");
  assert.equal(call.nodeData.type, "ingredient");
  assert.equal(call.nodeData.label, "Alho");
  assert.equal(call.nodeData.properties.ingredientId, body.data.id);
});

test("a GRAPH_WORKER failure never breaks the ingredient creation response", async () => {
  const graphWorker = createGraphWorkerMock({ failUpsert: true });
  const { post } = harness({ GRAPH_WORKER: graphWorker });
  const headers = await authHeader();

  const { status, body } = await post("/ingredients", { nome: "Alho", slug: "alho", type: "tempero" }, headers);

  assert.equal(status, 201);
  assert.equal(body.success, true);
  assert.equal(graphWorker.calls.upsertNode.length, 1);
});

test("PUT /ingredients/:id renames the graph node by resolving it via the pre-update label", async () => {
  const graphWorker = createGraphWorkerMock();
  const { post, put } = harness({ GRAPH_WORKER: graphWorker });
  const headers = await authHeader();

  const created = await post("/ingredients", { nome: "Alho", slug: "alho", type: "tempero" }, headers);
  const ingredientId = created.body.data.id;

  const { status } = await put(`/ingredients/${ingredientId}`, { nome: "Alho fresco" }, headers);

  assert.equal(status, 200);
  assert.equal(graphWorker.calls.findNodeByLabel.at(-1).label, "Alho");
  assert.equal(graphWorker.calls.updateNode.length, 1);
  assert.equal(graphWorker.calls.updateNode[0].patch.label, "Alho fresco");
  assert.equal(graphWorker.nodes[0].label, "Alho fresco");
});

test("PUT /ingredients/:id self-heals by creating the graph node when it never existed", async () => {
  // Simulate an ingredient created before GRAPH_WORKER existed: create it via
  // a harness without the binding, so no node exists in the graph yet, then
  // update it through a harness that does have GRAPH_WORKER configured.
  const db = createIngredientsDB();
  const headers = await authHeader();

  const created = await harness({ INGREDIENTS_DB: db }).post("/ingredients", { nome: "Alho", slug: "alho", type: "tempero" }, headers);
  const ingredientId = created.body.data.id;

  const graphWorker = createGraphWorkerMock();
  const { put } = harness({ INGREDIENTS_DB: db, GRAPH_WORKER: graphWorker });

  const { status } = await put(`/ingredients/${ingredientId}`, { nome: "Alho fresco" }, headers);

  assert.equal(status, 200);
  assert.equal(graphWorker.calls.upsertNode.length, 1);
  assert.equal(graphWorker.calls.upsertNode[0].nodeData.label, "Alho fresco");
});

test("DELETE /ingredients/:id removes the corresponding graph node", async () => {
  const graphWorker = createGraphWorkerMock();
  const { post, del } = harness({ GRAPH_WORKER: graphWorker });
  const headers = await authHeader();

  const created = await post("/ingredients", { nome: "Alho", slug: "alho", type: "tempero" }, headers);
  const ingredientId = created.body.data.id;

  const { status } = await del(`/ingredients/${ingredientId}`, headers);

  assert.equal(status, 200);
  assert.equal(graphWorker.calls.deleteNode.length, 1);
  assert.equal(graphWorker.nodes.length, 0);
});

test("GET /ingredients/:id/recommendations requires the ingredient:read permission", async () => {
  const { get } = harness({
    INGREDIENTS_DB: createIngredientsDB([
      { id: "1", nome: "Alho", slug: "alho", type: "tempero", reference: null, url: null, permissions: null },
    ]),
    GRAPH_WORKER: createGraphWorkerMock(),
  });

  assert.equal((await get("/ingredients/1/recommendations")).status, 401);

  const noPermission = await authHeader({ sub: "user-1", permissions: [] });
  assert.equal((await get("/ingredients/1/recommendations", noPermission)).status, 403);
});

test("GET /ingredients/:id/recommendations returns 501 when GRAPH_WORKER is not configured", async () => {
  const { get } = harness({
    INGREDIENTS_DB: createIngredientsDB([
      { id: "1", nome: "Alho", slug: "alho", type: "tempero", reference: null, url: null, permissions: null },
    ]),
  });
  const headers = await authHeader();

  const { status } = await get("/ingredients/1/recommendations", headers);
  assert.equal(status, 501);
});

test("GET /ingredients/:id/recommendations returns 404 for an unknown ingredient", async () => {
  const { get } = harness({ GRAPH_WORKER: createGraphWorkerMock() });
  const headers = await authHeader();

  const { status } = await get("/ingredients/missing/recommendations", headers);
  assert.equal(status, 404);
});

test("GET /ingredients/:id/recommendations returns an empty list when the ingredient has no graph node yet", async () => {
  const { get } = harness({
    INGREDIENTS_DB: createIngredientsDB([
      { id: "1", nome: "Alho", slug: "alho", type: "tempero", reference: null, url: null, permissions: null },
    ]),
    GRAPH_WORKER: createGraphWorkerMock(),
  });
  const headers = await authHeader();

  const { status, body } = await get("/ingredients/1/recommendations", headers);
  assert.equal(status, 200);
  assert.equal(body.count, 0);
  assert.deepEqual(body.data, []);
});

test("GET /ingredients/:id/recommendations (direct) enriches graph neighbors with ingredient records", async () => {
  const graphWorker = createGraphWorkerMock({
    nodes: [
      { id: "n1", graph_id: "ingredients", type: "ingredient", label: "Alho", properties: { ingredientId: "1" } },
      { id: "n2", graph_id: "ingredients", type: "ingredient", label: "Cebola", properties: { ingredientId: "2" } },
    ],
    neighborsByNodeId: {
      n1: [
        {
          edge_id: "e1",
          relation: "pairs_well_with",
          direction: "outgoing",
          properties: null,
          neighbor: { id: "n2", type: "ingredient", label: "Cebola", properties: { ingredientId: "2" } },
        },
      ],
    },
  });
  const { get } = harness({
    INGREDIENTS_DB: createIngredientsDB([
      { id: "1", nome: "Alho", slug: "alho", type: "tempero", reference: null, url: null, permissions: null },
      { id: "2", nome: "Cebola", slug: "cebola", type: "vegetal", reference: null, url: null, permissions: null },
    ]),
    GRAPH_WORKER: graphWorker,
  });
  const headers = await authHeader();

  const { status, body } = await get("/ingredients/1/recommendations?relation=pairs_well_with", headers);

  assert.equal(status, 200);
  assert.equal(body.mode, "direct");
  assert.equal(body.count, 1);
  assert.equal(body.data[0].relation, "pairs_well_with");
  assert.equal(body.data[0].ingredient.nome, "Cebola");
  assert.equal(graphWorker.calls.getNeighbors[0].opts.relation, "pairs_well_with");
});

test("GET /ingredients/:id/recommendations?indirect=true uses findPaths for multi-hop recommendations", async () => {
  const graphWorker = createGraphWorkerMock({
    nodes: [{ id: "n1", graph_id: "ingredients", type: "ingredient", label: "Alho", properties: { ingredientId: "1" } }],
    pathsByNodeId: {
      n1: [
        {
          node: { id: "n3", graph_id: "ingredients", type: "ingredient", label: "Cebolinha", properties: { ingredientId: "3" } },
          distance: 2,
          path: [
            { edge_id: "e1", from_node_id: "n1", to_node_id: "n2", relation: "pairs_well_with" },
            { edge_id: "e2", from_node_id: "n2", to_node_id: "n3", relation: "substitutes_for" },
          ],
        },
      ],
    },
  });
  const { get } = harness({
    INGREDIENTS_DB: createIngredientsDB([
      { id: "1", nome: "Alho", slug: "alho", type: "tempero", reference: null, url: null, permissions: null },
      { id: "3", nome: "Cebolinha", slug: "cebolinha", type: "vegetal", reference: null, url: null, permissions: null },
    ]),
    GRAPH_WORKER: graphWorker,
  });
  const headers = await authHeader();

  const { status, body } = await get("/ingredients/1/recommendations?indirect=true&maxDepth=3", headers);

  assert.equal(status, 200);
  assert.equal(body.mode, "indirect");
  assert.equal(body.data[0].ingredient.nome, "Cebolinha");
  assert.equal(body.data[0].distance, 2);
  assert.equal(body.data[0].relation, "substitutes_for");
  assert.equal(graphWorker.calls.findPaths[0].opts.maxDepth, 3);
});

test("GET /ingredients/:id/recommendations falls back to bare node identity when the ingredient no longer exists in D1", async () => {
  const graphWorker = createGraphWorkerMock({
    nodes: [
      { id: "n1", graph_id: "ingredients", type: "ingredient", label: "Alho", properties: { ingredientId: "1" } },
      { id: "n2", graph_id: "ingredients", type: "ingredient", label: "Cebola (removida)", properties: { ingredientId: "gone" } },
    ],
    neighborsByNodeId: {
      n1: [
        {
          edge_id: "e1",
          relation: "pairs_well_with",
          direction: "outgoing",
          properties: null,
          neighbor: { id: "n2", type: "ingredient", label: "Cebola (removida)", properties: { ingredientId: "gone" } },
        },
      ],
    },
  });
  const { get } = harness({
    INGREDIENTS_DB: createIngredientsDB([
      { id: "1", nome: "Alho", slug: "alho", type: "tempero", reference: null, url: null, permissions: null },
    ]),
    GRAPH_WORKER: graphWorker,
  });
  const headers = await authHeader();

  const { status, body } = await get("/ingredients/1/recommendations", headers);

  assert.equal(status, 200);
  assert.equal(body.data[0].nodeId, "n2");
  assert.equal(body.data[0].label, "Cebola (removida)");
  assert.equal(body.data[0].ingredient, undefined);
});
