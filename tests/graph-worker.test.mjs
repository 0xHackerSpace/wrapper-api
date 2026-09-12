// Runs with the Node.js test runner and no dependencies: node --test tests
import assert from "node:assert/strict";
import test from "node:test";

import worker from "../terraform/workers/graph/src/index.mjs";
import { generateToken } from "../terraform/workers/graph/src/lib/jwt.mjs";

function createGraphDB(seedNodes = [], seedEdges = []) {
  const nodes = [...seedNodes];
  const edges = [...seedEdges];

  function makeStatement(sql) {
    let boundArgs = [];
    return {
      bind(...args) {
        boundArgs = args;
        return this;
      },
      async first() {
        if (sql.includes("FROM nodes") && sql.includes("WHERE id = ?")) {
          return nodes.find((n) => n.id === boundArgs[0]) || null;
        }
        if (sql.includes("FROM edges") && sql.includes("WHERE id = ?")) {
          return edges.find((e) => e.id === boundArgs[0]) || null;
        }
        if (sql.includes("FROM edges") && sql.includes("relation = ?") && !sql.includes("JOIN nodes")) {
          const [from_node_id, to_node_id, relation] = boundArgs;
          return (
            edges.find(
              (e) => e.from_node_id === from_node_id && e.to_node_id === to_node_id && e.relation === relation
            ) || null
          );
        }
        return null;
      },
      async all() {
        if (sql.includes("FROM edges e") && sql.includes("JOIN nodes n")) {
          const nodeId = boundArgs[0];
          const matched = edges.filter((e) => e.from_node_id === nodeId || e.to_node_id === nodeId);
          const results = matched.map((e) => {
            const neighborId = e.from_node_id === nodeId ? e.to_node_id : e.from_node_id;
            const neighbor = nodes.find((n) => n.id === neighborId);
            return {
              edge_id: e.id,
              relation: e.relation,
              edge_properties: e.properties,
              from_node_id: e.from_node_id,
              to_node_id: e.to_node_id,
              neighbor_id: neighbor?.id,
              neighbor_type: neighbor?.type,
              neighbor_label: neighbor?.label,
              neighbor_properties: neighbor?.properties,
              neighbor_source_document_id: neighbor?.source_document_id,
            };
          });
          return { results };
        }
        if (sql.includes("FROM edges") && sql.includes("WHERE (from_node_id = ? AND to_node_id = ?)")) {
          const [a, b] = boundArgs;
          const results = edges.filter(
            (e) => (e.from_node_id === a && e.to_node_id === b) || (e.from_node_id === b && e.to_node_id === a)
          );
          return { results };
        }
        if (sql.includes("FROM nodes") && sql.includes("WHERE type = ?")) {
          const results = nodes
            .filter((n) => n.type === boundArgs[0])
            .sort((x, y) => (x.created_at || "").localeCompare(y.created_at || ""));
          return { results };
        }
        return { results: [] };
      },
      async run() {
        if (sql.startsWith("INSERT INTO nodes")) {
          const [id, type, label, properties, source_document_id] = boundArgs;
          if (nodes.some((n) => n.id === id)) {
            throw new Error("UNIQUE constraint failed: nodes.id");
          }
          const now = new Date().toISOString();
          nodes.push({ id, type, label, properties, source_document_id, created_at: now, updated_at: now });
          return { success: true };
        }
        if (sql.startsWith("INSERT INTO edges")) {
          const [id, from_node_id, to_node_id, relation, properties] = boundArgs;
          if (edges.some((e) => e.from_node_id === from_node_id && e.to_node_id === to_node_id && e.relation === relation)) {
            throw new Error("UNIQUE constraint failed: edges.from_node_id, edges.to_node_id, edges.relation");
          }
          const now = new Date().toISOString();
          edges.push({ id, from_node_id, to_node_id, relation, properties, created_at: now, updated_at: now });
          return { success: true };
        }
        return { success: false };
      },
    };
  }

  return {
    prepare: (sql) => makeStatement(sql),
    _nodes: nodes,
    _edges: edges,
  };
}

const JWT_SECRET = "test-secret";

function harness(overrides = {}) {
  const db = "GRAPH_DB" in overrides ? overrides.GRAPH_DB : createGraphDB();
  const env = {
    ENVIRONMENT: "test",
    JWT_SECRET,
    ...overrides,
    GRAPH_DB: db,
  };

  const call = async (path, init) => {
    const response = await worker.fetch(new Request(`https://graph.test${path}`, init), env, {});
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  const get = (path, headers = {}) => call(path, { method: "GET", headers });
  const post = (path, body, headers = {}) =>
    call(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });

  return { env, db, call, get, post };
}

async function authHeader(payload = { sub: "user-1", username: "ianoliv", permissions: ["graph:read", "graph:write"] }) {
  const token = await generateToken(payload, JWT_SECRET);
  return { authorization: `Bearer ${token}` };
}

test("GET /health reports service status without auth", async () => {
  const { get } = harness();
  const { status, body } = await get("/health");

  assert.equal(status, 200);
  assert.equal(body.service, "graph");
  assert.equal(body.status, "ok");
});

test("GET /v1 lists available endpoints", async () => {
  const { get } = harness();
  const { status, body } = await get("/v1");

  assert.equal(status, 200);
  assert.equal(body.service, "graph");
  assert.ok(body.endpoints.create_node);
});

test("POST /v1/nodes requires a valid JWT", async () => {
  const { post } = harness();

  const noAuth = await post("/v1/nodes", { type: "concept", label: "Photosynthesis" });
  assert.equal(noAuth.status, 401);
  assert.equal(noAuth.body.error.type, "invalid_request_error");

  const badAuth = await post("/v1/nodes", { type: "concept", label: "Photosynthesis" }, { authorization: "Bearer invalid" });
  assert.equal(badAuth.status, 401);
});

test("graph:read and graph:write are enforced independently", async () => {
  const { get, post } = harness();
  const readOnly = await authHeader({ sub: "user-1", permissions: ["graph:read"] });
  const writeOnly = await authHeader({ sub: "user-1", permissions: ["graph:write"] });

  const writeWithReadOnly = await post("/v1/nodes", { type: "concept", label: "A" }, readOnly);
  assert.equal(writeWithReadOnly.status, 403);

  const readWithWriteOnly = await get("/v1/nodes?type=concept", writeOnly);
  assert.equal(readWithWriteOnly.status, 403);
});

test("POST /v1/nodes rejects missing required fields with 400, not 500", async () => {
  const { post } = harness();
  const headers = await authHeader();

  const missingLabel = await post("/v1/nodes", { type: "concept" }, headers);
  assert.equal(missingLabel.status, 400);
  assert.match(missingLabel.body.error.message, /label/);

  const missingType = await post("/v1/nodes", { label: "Photosynthesis" }, headers);
  assert.equal(missingType.status, 400);
  assert.match(missingType.body.error.message, /type/);
});

test("POST /v1/nodes creates a node with generated id", async () => {
  const { post, db } = harness();
  const headers = await authHeader();

  const { status, body } = await post(
    "/v1/nodes",
    { type: "concept", label: "Photosynthesis", properties: { confidence: 0.9 } },
    headers
  );

  assert.equal(status, 201);
  assert.equal(body.success, true);
  assert.equal(body.data.type, "concept");
  assert.equal(body.data.label, "Photosynthesis");
  assert.deepEqual(body.data.properties, { confidence: 0.9 });
  assert.ok(body.data.id);
  assert.equal(db._nodes.length, 1);
});

test("POST /v1/nodes rejects a duplicate client-supplied id with 409", async () => {
  const { post } = harness({
    GRAPH_DB: createGraphDB([
      { id: "n1", type: "concept", label: "A", properties: null, source_document_id: null, created_at: "t1" },
    ]),
  });
  const headers = await authHeader();

  const { status, body } = await post("/v1/nodes", { id: "n1", type: "concept", label: "B" }, headers);
  assert.equal(status, 409);
  assert.match(body.error.message, /already exists/);
});

test("GET /v1/nodes/:id returns a node or 404", async () => {
  const { get } = harness({
    GRAPH_DB: createGraphDB([
      { id: "n1", type: "concept", label: "Photosynthesis", properties: null, source_document_id: null, created_at: "t1" },
    ]),
  });
  const headers = await authHeader();

  const found = await get("/v1/nodes/n1", headers);
  assert.equal(found.status, 200);
  assert.equal(found.body.data.label, "Photosynthesis");

  const notFound = await get("/v1/nodes/missing", headers);
  assert.equal(notFound.status, 404);
});

test("GET /v1/nodes?type=X lists nodes of a given type", async () => {
  const { get } = harness({
    GRAPH_DB: createGraphDB([
      { id: "n1", type: "concept", label: "A", properties: null, source_document_id: null, created_at: "t1" },
      { id: "n2", type: "document", label: "B", properties: null, source_document_id: null, created_at: "t2" },
    ]),
  });
  const headers = await authHeader();

  const { status, body } = await get("/v1/nodes?type=concept", headers);
  assert.equal(status, 200);
  assert.equal(body.count, 1);
  assert.equal(body.data[0].id, "n1");
});

test("POST /v1/edges creates a relation between two existing nodes", async () => {
  const { post, db } = harness({
    GRAPH_DB: createGraphDB([
      { id: "n1", type: "concept", label: "A", properties: null, source_document_id: null, created_at: "t1" },
      { id: "n2", type: "concept", label: "B", properties: null, source_document_id: null, created_at: "t2" },
    ]),
  });
  const headers = await authHeader();

  const { status, body } = await post(
    "/v1/edges",
    { from_node_id: "n1", to_node_id: "n2", relation: "related_to" },
    headers
  );

  assert.equal(status, 201);
  assert.equal(body.data.from_node_id, "n1");
  assert.equal(body.data.to_node_id, "n2");
  assert.equal(body.data.relation, "related_to");
  assert.equal(db._edges.length, 1);
});

test("POST /v1/edges rejects a reference to a non-existent node with 400", async () => {
  const { post } = harness({
    GRAPH_DB: createGraphDB([
      { id: "n1", type: "concept", label: "A", properties: null, source_document_id: null, created_at: "t1" },
    ]),
  });
  const headers = await authHeader();

  const { status, body } = await post(
    "/v1/edges",
    { from_node_id: "n1", to_node_id: "missing", relation: "related_to" },
    headers
  );

  assert.equal(status, 400);
  assert.match(body.error.message, /to_node_id/);
});

test("POST /v1/edges rejects a duplicate from/to/relation triple with 409", async () => {
  const { post } = harness({
    GRAPH_DB: createGraphDB(
      [
        { id: "n1", type: "concept", label: "A", properties: null, source_document_id: null, created_at: "t1" },
        { id: "n2", type: "concept", label: "B", properties: null, source_document_id: null, created_at: "t2" },
      ],
      [{ id: "e1", from_node_id: "n1", to_node_id: "n2", relation: "related_to", properties: null, created_at: "t1" }]
    ),
  });
  const headers = await authHeader();

  const { status, body } = await post(
    "/v1/edges",
    { from_node_id: "n1", to_node_id: "n2", relation: "related_to" },
    headers
  );
  assert.equal(status, 409);
  assert.match(body.error.message, /already exists/);
});

test("GET /v1/nodes/:id/neighbors lists connected nodes with relation info", async () => {
  const { get } = harness({
    GRAPH_DB: createGraphDB(
      [
        { id: "n1", type: "concept", label: "A", properties: null, source_document_id: null, created_at: "t1" },
        { id: "n2", type: "concept", label: "B", properties: null, source_document_id: null, created_at: "t2" },
        { id: "n3", type: "concept", label: "C", properties: null, source_document_id: null, created_at: "t3" },
      ],
      [
        { id: "e1", from_node_id: "n1", to_node_id: "n2", relation: "related_to", properties: null, created_at: "t1" },
        { id: "e2", from_node_id: "n3", to_node_id: "n1", relation: "references", properties: null, created_at: "t2" },
      ]
    ),
  });
  const headers = await authHeader();

  const { status, body } = await get("/v1/nodes/n1/neighbors", headers);

  assert.equal(status, 200);
  assert.equal(body.count, 2);
  const byNeighbor = Object.fromEntries(body.data.map((row) => [row.neighbor.id, row]));
  assert.equal(byNeighbor.n2.direction, "outgoing");
  assert.equal(byNeighbor.n2.relation, "related_to");
  assert.equal(byNeighbor.n3.direction, "incoming");
  assert.equal(byNeighbor.n3.relation, "references");
});

test("GET /v1/nodes/:id/relations?to=:otherId lists direct relations between two nodes", async () => {
  const { get } = harness({
    GRAPH_DB: createGraphDB(
      [
        { id: "n1", type: "concept", label: "A", properties: null, source_document_id: null, created_at: "t1" },
        { id: "n2", type: "concept", label: "B", properties: null, source_document_id: null, created_at: "t2" },
      ],
      [{ id: "e1", from_node_id: "n1", to_node_id: "n2", relation: "related_to", properties: null, created_at: "t1" }]
    ),
  });
  const headers = await authHeader();

  const { status, body } = await get("/v1/nodes/n1/relations?to=n2", headers);
  assert.equal(status, 200);
  assert.equal(body.count, 1);
  assert.equal(body.data[0].relation, "related_to");

  const missingParam = await get("/v1/nodes/n1/relations", headers);
  assert.equal(missingParam.status, 400);
});

test("graph routes fail closed when GRAPH_DB is not configured", async () => {
  const { get, post } = harness({ GRAPH_DB: null });
  const headers = await authHeader();

  assert.equal((await get("/v1/nodes?type=concept", headers)).status, 500);
  assert.equal((await post("/v1/nodes", { type: "concept", label: "A" }, headers)).status, 500);
});

test("unknown routes return 404", async () => {
  const { get } = harness();
  const { status, body } = await get("/unknown");

  assert.equal(status, 404);
  assert.equal(body.error.message, "Endpoint not found");
});
