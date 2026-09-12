// Runs with the Node.js test runner and no dependencies: node --test tests
import assert from "node:assert/strict";
import test from "node:test";

import worker from "../terraform/workers/graph/src/index.mjs";
import { generateToken } from "../terraform/workers/graph/src/lib/jwt.mjs";

function createGraphDB(seedGraphs = [], seedAccess = [], seedNodes = [], seedEdges = []) {
  const graphs = [...seedGraphs];
  const access = [...seedAccess];
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
        if (sql.includes("FROM graphs") && sql.includes("WHERE id = ?")) {
          return graphs.find((g) => g.id === boundArgs[0]) || null;
        }
        if (sql.includes("FROM graph_access") && sql.includes("WHERE graph_id = ? AND user_id = ?")) {
          const [graphId, userId] = boundArgs;
          return access.find((a) => a.graph_id === graphId && a.user_id === userId) || null;
        }
        if (sql.includes("FROM nodes") && sql.includes("WHERE id = ? AND graph_id = ?")) {
          const [id, graphId] = boundArgs;
          return nodes.find((n) => n.id === id && n.graph_id === graphId) || null;
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
        if (sql.includes("FROM graphs g") && sql.includes("JOIN graph_access")) {
          const userId = boundArgs[0];
          const results = access
            .filter((a) => a.user_id === userId)
            .map((a) => {
              const g = graphs.find((g) => g.id === a.graph_id);
              return { id: g.id, name: g.name, created_by: g.created_by, created_at: g.created_at, role: a.role };
            })
            .sort((x, y) => (x.created_at || "").localeCompare(y.created_at || ""));
          return { results };
        }
        if (sql.includes("FROM edges e") && sql.includes("JOIN nodes n")) {
          const [nodeId, , , graphId] = boundArgs;
          const matched = edges.filter((e) => e.from_node_id === nodeId || e.to_node_id === nodeId);
          const results = matched
            .map((e) => {
              const neighborId = e.from_node_id === nodeId ? e.to_node_id : e.from_node_id;
              const neighbor = nodes.find((n) => n.id === neighborId);
              if (!neighbor || neighbor.graph_id !== graphId) return null;
              return {
                edge_id: e.id,
                relation: e.relation,
                edge_properties: e.properties,
                from_node_id: e.from_node_id,
                to_node_id: e.to_node_id,
                neighbor_id: neighbor.id,
                neighbor_type: neighbor.type,
                neighbor_label: neighbor.label,
                neighbor_properties: neighbor.properties,
                neighbor_source_document_id: neighbor.source_document_id,
              };
            })
            .filter(Boolean);
          return { results };
        }
        if (sql.includes("FROM edges") && sql.includes("WHERE (from_node_id = ? AND to_node_id = ?)")) {
          const [a, b] = boundArgs;
          const results = edges.filter(
            (e) => (e.from_node_id === a && e.to_node_id === b) || (e.from_node_id === b && e.to_node_id === a)
          );
          return { results };
        }
        if (sql.includes("FROM graph_access") && sql.includes("WHERE graph_id = ?") && sql.includes("ORDER BY created_at")) {
          const [graphId] = boundArgs;
          const results = access
            .filter((a) => a.graph_id === graphId)
            .sort((x, y) => (x.created_at || "").localeCompare(y.created_at || ""));
          return { results };
        }
        if (sql.includes("FROM nodes") && sql.includes("WHERE graph_id = ? AND type = ?")) {
          const [graphId, type] = boundArgs;
          const results = nodes
            .filter((n) => n.graph_id === graphId && n.type === type)
            .sort((x, y) => (x.created_at || "").localeCompare(y.created_at || ""));
          return { results };
        }
        return { results: [] };
      },
      async run() {
        if (sql.startsWith("INSERT INTO graphs")) {
          const [id, name, created_by] = boundArgs;
          if (graphs.some((g) => g.id === id)) {
            throw new Error("UNIQUE constraint failed: graphs.id");
          }
          graphs.push({ id, name, created_by, created_at: new Date().toISOString() });
          return { success: true };
        }
        if (sql.startsWith("INSERT INTO graph_access")) {
          const [id, graph_id, user_id, role] = boundArgs;
          access.push({ id, graph_id, user_id, role, created_at: new Date().toISOString() });
          return { success: true };
        }
        if (sql.startsWith("UPDATE graph_access")) {
          const [role, graph_id, user_id] = boundArgs;
          const row = access.find((a) => a.graph_id === graph_id && a.user_id === user_id);
          if (row) row.role = role;
          return { success: true };
        }
        if (sql.startsWith("DELETE FROM graph_access")) {
          const [graph_id, user_id] = boundArgs;
          const index = access.findIndex((a) => a.graph_id === graph_id && a.user_id === user_id);
          if (index !== -1) access.splice(index, 1);
          return { success: true };
        }
        if (sql.startsWith("INSERT INTO nodes")) {
          const [id, graph_id, type, label, properties, source_document_id] = boundArgs;
          if (nodes.some((n) => n.id === id)) {
            throw new Error("UNIQUE constraint failed: nodes.id");
          }
          const now = new Date().toISOString();
          nodes.push({ id, graph_id, type, label, properties, source_document_id, created_at: now, updated_at: now });
          return { success: true };
        }
        if (sql.startsWith("INSERT INTO edges")) {
          const [id, from_node_id, to_node_id, relation, properties] = boundArgs;
          if (
            edges.some((e) => e.from_node_id === from_node_id && e.to_node_id === to_node_id && e.relation === relation)
          ) {
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
    _graphs: graphs,
    _access: access,
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
  const put = (path, body, headers = {}) =>
    call(path, { method: "PUT", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });
  const del = (path, headers = {}) => call(path, { method: "DELETE", headers });

  return { env, db, call, get, post, put, del };
}

async function authHeader(payload = { sub: "user-1", username: "ianoliv", permissions: ["graph:read", "graph:write"] }) {
  const token = await generateToken(payload, JWT_SECRET);
  return { authorization: `Bearer ${token}` };
}

function seedGraph(db, { id = "g1", name = "Graph 1", createdBy = "user-1", owners = [], editors = [], viewers = [] } = {}) {
  db._graphs.push({ id, name, created_by: createdBy, created_at: "t0" });
  for (const userId of owners) db._access.push({ id: `acc-${id}-${userId}`, graph_id: id, user_id: userId, role: "owner" });
  for (const userId of editors) db._access.push({ id: `acc-${id}-${userId}`, graph_id: id, user_id: userId, role: "editor" });
  for (const userId of viewers) db._access.push({ id: `acc-${id}-${userId}`, graph_id: id, user_id: userId, role: "viewer" });
  return id;
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
  assert.ok(body.endpoints.create_graph);
  assert.ok(body.endpoints.create_node);
});

test("POST /v1/graphs requires a valid JWT with the graph:write permission", async () => {
  const { post } = harness();

  assert.equal((await post("/v1/graphs", { name: "My graph" })).status, 401);
  assert.equal((await post("/v1/graphs", { name: "My graph" }, { authorization: "Bearer invalid" })).status, 401);

  const readOnly = await authHeader({ sub: "user-1", permissions: ["graph:read"] });
  assert.equal((await post("/v1/graphs", { name: "My graph" }, readOnly)).status, 403);
});

test("POST /v1/graphs creates a graph and grants the creator owner access", async () => {
  const { post, db } = harness();
  const headers = await authHeader();

  const { status, body } = await post("/v1/graphs", { name: "My graph" }, headers);

  assert.equal(status, 201);
  assert.equal(body.data.name, "My graph");
  assert.ok(body.data.id);
  assert.equal(db._graphs.length, 1);
  assert.equal(db._access.length, 1);
  assert.equal(db._access[0].role, "owner");
  assert.equal(db._access[0].user_id, "user-1");
});

test("GET /v1/graphs lists only graphs the caller has access to", async () => {
  const db = createGraphDB();
  seedGraph(db, { id: "g1", owners: ["user-1"] });
  seedGraph(db, { id: "g2", owners: ["user-2"] });
  const { get } = harness({ GRAPH_DB: db });
  const headers = await authHeader();

  const { status, body } = await get("/v1/graphs", headers);

  assert.equal(status, 200);
  assert.equal(body.count, 1);
  assert.equal(body.data[0].id, "g1");
  assert.equal(body.data[0].role, "owner");
});

test("graph:read and graph:write RBAC permissions are enforced independently of graph access", async () => {
  const db = createGraphDB();
  seedGraph(db, { id: "g1", owners: ["user-1"] });
  const { get, post } = harness({ GRAPH_DB: db });
  const readOnly = await authHeader({ sub: "user-1", permissions: ["graph:read"] });
  const writeOnly = await authHeader({ sub: "user-1", permissions: ["graph:write"] });

  const writeWithReadOnly = await post("/v1/graphs/g1/nodes", { type: "concept", label: "A" }, readOnly);
  assert.equal(writeWithReadOnly.status, 403);

  const readWithWriteOnly = await get("/v1/graphs/g1/nodes?type=concept", writeOnly);
  assert.equal(readWithWriteOnly.status, 403);
});

test("a valid RBAC permission alone does not grant access to someone else's graph", async () => {
  const db = createGraphDB();
  seedGraph(db, { id: "g1", owners: ["user-2"] });
  const { get, post } = harness({ GRAPH_DB: db });
  const headers = await authHeader({ sub: "user-1", permissions: ["graph:read", "graph:write"] });

  const read = await get("/v1/graphs/g1/nodes?type=concept", headers);
  assert.equal(read.status, 403);
  assert.match(read.body.error.message, /No access to this graph/);

  const write = await post("/v1/graphs/g1/nodes", { type: "concept", label: "A" }, headers);
  assert.equal(write.status, 403);
});

test("a viewer can read but not write in a graph", async () => {
  const db = createGraphDB();
  seedGraph(db, { id: "g1", viewers: ["user-1"] });
  const { get, post } = harness({ GRAPH_DB: db });
  const headers = await authHeader();

  assert.equal((await get("/v1/graphs/g1/nodes?type=concept", headers)).status, 200);
  assert.equal((await post("/v1/graphs/g1/nodes", { type: "concept", label: "A" }, headers)).status, 403);
});

test("an editor can read and write in a graph", async () => {
  const db = createGraphDB();
  seedGraph(db, { id: "g1", editors: ["user-1"] });
  const { get, post } = harness({ GRAPH_DB: db });
  const headers = await authHeader();

  assert.equal((await get("/v1/graphs/g1/nodes?type=concept", headers)).status, 200);
  assert.equal((await post("/v1/graphs/g1/nodes", { type: "concept", label: "A" }, headers)).status, 201);
});

test("requests to a non-existent graph return 404", async () => {
  const { get, post } = harness();
  const headers = await authHeader();

  assert.equal((await get("/v1/graphs/missing/nodes?type=concept", headers)).status, 404);
  assert.equal((await post("/v1/graphs/missing/nodes", { type: "concept", label: "A" }, headers)).status, 404);
});

test("POST /v1/graphs/:graphId/nodes rejects missing required fields with 400, not 500", async () => {
  const db = createGraphDB();
  seedGraph(db, { id: "g1", owners: ["user-1"] });
  const { post } = harness({ GRAPH_DB: db });
  const headers = await authHeader();

  const missingLabel = await post("/v1/graphs/g1/nodes", { type: "concept" }, headers);
  assert.equal(missingLabel.status, 400);
  assert.match(missingLabel.body.error.message, /label/);

  const missingType = await post("/v1/graphs/g1/nodes", { label: "Photosynthesis" }, headers);
  assert.equal(missingType.status, 400);
  assert.match(missingType.body.error.message, /type/);
});

test("POST /v1/graphs/:graphId/nodes creates a node scoped to the graph", async () => {
  const db = createGraphDB();
  seedGraph(db, { id: "g1", owners: ["user-1"] });
  const { post } = harness({ GRAPH_DB: db });
  const headers = await authHeader();

  const { status, body } = await post(
    "/v1/graphs/g1/nodes",
    { type: "concept", label: "Photosynthesis", properties: { confidence: 0.9 } },
    headers
  );

  assert.equal(status, 201);
  assert.equal(body.success, true);
  assert.equal(body.data.graph_id, "g1");
  assert.equal(body.data.type, "concept");
  assert.equal(body.data.label, "Photosynthesis");
  assert.deepEqual(body.data.properties, { confidence: 0.9 });
  assert.ok(body.data.id);
  assert.equal(db._nodes.length, 1);
});

test("POST /v1/graphs/:graphId/nodes rejects a duplicate client-supplied id with 409", async () => {
  const db = createGraphDB();
  seedGraph(db, { id: "g1", owners: ["user-1"] });
  db._nodes.push({ id: "n1", graph_id: "g1", type: "concept", label: "A", properties: null, source_document_id: null, created_at: "t1" });
  const { post } = harness({ GRAPH_DB: db });
  const headers = await authHeader();

  const { status, body } = await post("/v1/graphs/g1/nodes", { id: "n1", type: "concept", label: "B" }, headers);
  assert.equal(status, 409);
  assert.match(body.error.message, /already exists/);
});

test("GET /v1/graphs/:graphId/nodes/:id returns a node or 404, and does not leak nodes from other graphs", async () => {
  const db = createGraphDB();
  seedGraph(db, { id: "g1", owners: ["user-1"] });
  seedGraph(db, { id: "g2", owners: ["user-1"] });
  db._nodes.push({ id: "n1", graph_id: "g1", type: "concept", label: "Photosynthesis", properties: null, source_document_id: null, created_at: "t1" });
  const { get } = harness({ GRAPH_DB: db });
  const headers = await authHeader();

  const found = await get("/v1/graphs/g1/nodes/n1", headers);
  assert.equal(found.status, 200);
  assert.equal(found.body.data.label, "Photosynthesis");

  const notFound = await get("/v1/graphs/g1/nodes/missing", headers);
  assert.equal(notFound.status, 404);

  const wrongGraph = await get("/v1/graphs/g2/nodes/n1", headers);
  assert.equal(wrongGraph.status, 404, "a node from g1 must not be reachable through g2, even with owner access to both");
});

test("GET /v1/graphs/:graphId/nodes?type=X lists nodes of a given type scoped to that graph", async () => {
  const db = createGraphDB();
  seedGraph(db, { id: "g1", owners: ["user-1"] });
  seedGraph(db, { id: "g2", owners: ["user-1"] });
  db._nodes.push(
    { id: "n1", graph_id: "g1", type: "concept", label: "A", properties: null, source_document_id: null, created_at: "t1" },
    { id: "n2", graph_id: "g2", type: "concept", label: "B", properties: null, source_document_id: null, created_at: "t2" }
  );
  const { get } = harness({ GRAPH_DB: db });
  const headers = await authHeader();

  const { status, body } = await get("/v1/graphs/g1/nodes?type=concept", headers);
  assert.equal(status, 200);
  assert.equal(body.count, 1);
  assert.equal(body.data[0].id, "n1");
});

test("POST /v1/graphs/:graphId/edges creates a relation between two existing nodes in the graph", async () => {
  const db = createGraphDB();
  seedGraph(db, { id: "g1", owners: ["user-1"] });
  db._nodes.push(
    { id: "n1", graph_id: "g1", type: "concept", label: "A", properties: null, source_document_id: null, created_at: "t1" },
    { id: "n2", graph_id: "g1", type: "concept", label: "B", properties: null, source_document_id: null, created_at: "t2" }
  );
  const { post } = harness({ GRAPH_DB: db });
  const headers = await authHeader();

  const { status, body } = await post(
    "/v1/graphs/g1/edges",
    { from_node_id: "n1", to_node_id: "n2", relation: "related_to" },
    headers
  );

  assert.equal(status, 201);
  assert.equal(body.data.from_node_id, "n1");
  assert.equal(body.data.to_node_id, "n2");
  assert.equal(body.data.relation, "related_to");
  assert.equal(db._edges.length, 1);
});

test("POST /v1/graphs/:graphId/edges rejects a reference to a non-existent node with 400", async () => {
  const db = createGraphDB();
  seedGraph(db, { id: "g1", owners: ["user-1"] });
  db._nodes.push({ id: "n1", graph_id: "g1", type: "concept", label: "A", properties: null, source_document_id: null, created_at: "t1" });
  const { post } = harness({ GRAPH_DB: db });
  const headers = await authHeader();

  const { status, body } = await post(
    "/v1/graphs/g1/edges",
    { from_node_id: "n1", to_node_id: "missing", relation: "related_to" },
    headers
  );

  assert.equal(status, 400);
  assert.match(body.error.message, /to_node_id/);
});

test("POST /v1/graphs/:graphId/edges rejects a node that belongs to a different graph with 400", async () => {
  const db = createGraphDB();
  seedGraph(db, { id: "g1", owners: ["user-1"] });
  seedGraph(db, { id: "g2", owners: ["user-1"] });
  db._nodes.push(
    { id: "n1", graph_id: "g1", type: "concept", label: "A", properties: null, source_document_id: null, created_at: "t1" },
    { id: "n2", graph_id: "g2", type: "concept", label: "B", properties: null, source_document_id: null, created_at: "t2" }
  );
  const { post } = harness({ GRAPH_DB: db });
  const headers = await authHeader();

  const { status, body } = await post(
    "/v1/graphs/g1/edges",
    { from_node_id: "n1", to_node_id: "n2", relation: "related_to" },
    headers
  );

  assert.equal(status, 400);
  assert.match(body.error.message, /to_node_id/);
});

test("POST /v1/graphs/:graphId/edges rejects a duplicate from/to/relation triple with 409", async () => {
  const db = createGraphDB();
  seedGraph(db, { id: "g1", owners: ["user-1"] });
  db._nodes.push(
    { id: "n1", graph_id: "g1", type: "concept", label: "A", properties: null, source_document_id: null, created_at: "t1" },
    { id: "n2", graph_id: "g1", type: "concept", label: "B", properties: null, source_document_id: null, created_at: "t2" }
  );
  db._edges.push({ id: "e1", from_node_id: "n1", to_node_id: "n2", relation: "related_to", properties: null, created_at: "t1" });
  const { post } = harness({ GRAPH_DB: db });
  const headers = await authHeader();

  const { status, body } = await post(
    "/v1/graphs/g1/edges",
    { from_node_id: "n1", to_node_id: "n2", relation: "related_to" },
    headers
  );
  assert.equal(status, 409);
  assert.match(body.error.message, /already exists/);
});

test("GET /v1/graphs/:graphId/nodes/:id/neighbors lists connected nodes with relation info", async () => {
  const db = createGraphDB();
  seedGraph(db, { id: "g1", owners: ["user-1"] });
  db._nodes.push(
    { id: "n1", graph_id: "g1", type: "concept", label: "A", properties: null, source_document_id: null, created_at: "t1" },
    { id: "n2", graph_id: "g1", type: "concept", label: "B", properties: null, source_document_id: null, created_at: "t2" },
    { id: "n3", graph_id: "g1", type: "concept", label: "C", properties: null, source_document_id: null, created_at: "t3" }
  );
  db._edges.push(
    { id: "e1", from_node_id: "n1", to_node_id: "n2", relation: "related_to", properties: null, created_at: "t1" },
    { id: "e2", from_node_id: "n3", to_node_id: "n1", relation: "references", properties: null, created_at: "t2" }
  );
  const { get } = harness({ GRAPH_DB: db });
  const headers = await authHeader();

  const { status, body } = await get("/v1/graphs/g1/nodes/n1/neighbors", headers);

  assert.equal(status, 200);
  assert.equal(body.count, 2);
  const byNeighbor = Object.fromEntries(body.data.map((row) => [row.neighbor.id, row]));
  assert.equal(byNeighbor.n2.direction, "outgoing");
  assert.equal(byNeighbor.n2.relation, "related_to");
  assert.equal(byNeighbor.n3.direction, "incoming");
  assert.equal(byNeighbor.n3.relation, "references");
});

test("GET /v1/graphs/:graphId/nodes/:id/relations?to=:otherId lists direct relations between two nodes", async () => {
  const db = createGraphDB();
  seedGraph(db, { id: "g1", owners: ["user-1"] });
  db._nodes.push(
    { id: "n1", graph_id: "g1", type: "concept", label: "A", properties: null, source_document_id: null, created_at: "t1" },
    { id: "n2", graph_id: "g1", type: "concept", label: "B", properties: null, source_document_id: null, created_at: "t2" }
  );
  db._edges.push({ id: "e1", from_node_id: "n1", to_node_id: "n2", relation: "related_to", properties: null, created_at: "t1" });
  const { get } = harness({ GRAPH_DB: db });
  const headers = await authHeader();

  const { status, body } = await get("/v1/graphs/g1/nodes/n1/relations?to=n2", headers);
  assert.equal(status, 200);
  assert.equal(body.count, 1);
  assert.equal(body.data[0].relation, "related_to");

  const missingParam = await get("/v1/graphs/g1/nodes/n1/relations", headers);
  assert.equal(missingParam.status, 400);

  const missingOtherNode = await get("/v1/graphs/g1/nodes/n1/relations?to=missing", headers);
  assert.equal(missingOtherNode.status, 404);
});

test("graph routes fail closed when GRAPH_DB is not configured", async () => {
  const { get, post } = harness({ GRAPH_DB: null });
  const headers = await authHeader();

  assert.equal((await get("/v1/graphs/g1/nodes?type=concept", headers)).status, 500);
  assert.equal((await post("/v1/graphs/g1/nodes", { type: "concept", label: "A" }, headers)).status, 500);
});

test("PUT /v1/graphs/:graphId/access/:userId grants access and GET/DELETE reflect it (happy path)", async () => {
  const db = createGraphDB();
  seedGraph(db, { id: "g1", owners: ["user-1"] });
  const { put, get, del } = harness({ GRAPH_DB: db });
  const headers = await authHeader();

  const granted = await put("/v1/graphs/g1/access/user-2", { role: "editor" }, headers);
  assert.equal(granted.status, 200);
  assert.deepEqual(granted.body.data, { graph_id: "g1", user_id: "user-2", role: "editor" });

  const listed = await get("/v1/graphs/g1/access", headers);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.count, 2);
  const byUser = Object.fromEntries(listed.body.data.map((row) => [row.user_id, row.role]));
  assert.equal(byUser["user-1"], "owner");
  assert.equal(byUser["user-2"], "editor");

  const revoked = await del("/v1/graphs/g1/access/user-2", headers);
  assert.equal(revoked.status, 200);
  assert.equal(db._access.some((a) => a.user_id === "user-2"), false);
});

test("PUT /v1/graphs/:graphId/access/:userId upserts: granting to an existing collaborator updates the role instead of duplicating", async () => {
  const db = createGraphDB();
  seedGraph(db, { id: "g1", owners: ["user-1"], viewers: ["user-2"] });
  const { put } = harness({ GRAPH_DB: db });
  const headers = await authHeader();

  const { status, body } = await put("/v1/graphs/g1/access/user-2", { role: "editor" }, headers);

  assert.equal(status, 200);
  assert.equal(body.data.role, "editor");
  assert.equal(db._access.filter((a) => a.user_id === "user-2").length, 1);
  assert.equal(db._access.find((a) => a.user_id === "user-2").role, "editor");
});

test("PUT /v1/graphs/:graphId/access/:userId rejects an invalid role with 400", async () => {
  const db = createGraphDB();
  seedGraph(db, { id: "g1", owners: ["user-1"] });
  const { put } = harness({ GRAPH_DB: db });
  const headers = await authHeader();

  const { status, body } = await put("/v1/graphs/g1/access/user-2", { role: "admin" }, headers);

  assert.equal(status, 400);
  assert.match(body.error.message, /role/);
});

test("PUT /v1/graphs/:graphId/access/:userId rejects downgrading the sole owner with 409", async () => {
  const db = createGraphDB();
  seedGraph(db, { id: "g1", owners: ["user-1"] });
  const { put } = harness({ GRAPH_DB: db });
  const headers = await authHeader();

  const { status, body } = await put("/v1/graphs/g1/access/user-1", { role: "editor" }, headers);

  assert.equal(status, 409);
  assert.match(body.error.message, /at least one owner/);
});

test("PUT/DELETE on someone else by a non-owner (editor) returns 403", async () => {
  const db = createGraphDB();
  seedGraph(db, { id: "g1", owners: ["user-1"], editors: ["user-2"] });
  const { put, del } = harness({ GRAPH_DB: db });
  const headers = await authHeader({ sub: "user-2", permissions: ["graph:read", "graph:write"] });

  assert.equal((await put("/v1/graphs/g1/access/user-3", { role: "viewer" }, headers)).status, 403);
  assert.equal((await del("/v1/graphs/g1/access/user-1", headers)).status, 403);
});

test("PUT/DELETE on someone else with graph:read but not graph:write returns 403", async () => {
  const db = createGraphDB();
  seedGraph(db, { id: "g1", owners: ["user-1", "user-2"] });
  const { put, del } = harness({ GRAPH_DB: db });
  const headers = await authHeader({ sub: "user-1", permissions: ["graph:read"] });

  assert.equal((await put("/v1/graphs/g1/access/user-2", { role: "viewer" }, headers)).status, 403);
  assert.equal((await del("/v1/graphs/g1/access/user-2", headers)).status, 403);
});

test("DELETE /v1/graphs/:graphId/access/:userId self-removal only requires graph:read", async () => {
  const db = createGraphDB();
  seedGraph(db, { id: "g1", owners: ["user-1"], viewers: ["user-2"] });
  const { del } = harness({ GRAPH_DB: db });
  const headers = await authHeader({ sub: "user-2", permissions: ["graph:read"] });

  const { status } = await del("/v1/graphs/g1/access/user-2", headers);

  assert.equal(status, 200);
  assert.equal(db._access.some((a) => a.user_id === "user-2"), false);
});

test("DELETE /v1/graphs/:graphId/access/:userId rejects removing the sole owner, self or by another owner, with 409", async () => {
  const db = createGraphDB();
  seedGraph(db, { id: "g1", owners: ["user-1"] });
  const { del } = harness({ GRAPH_DB: db });
  const selfHeaders = await authHeader({ sub: "user-1", permissions: ["graph:read"] });

  const selfRemoval = await del("/v1/graphs/g1/access/user-1", selfHeaders);
  assert.equal(selfRemoval.status, 409);
  assert.match(selfRemoval.body.error.message, /at least one owner/);

  const db2 = createGraphDB();
  seedGraph(db2, { id: "g2", owners: ["user-1", "user-2"] });
  const { del: del2 } = harness({ GRAPH_DB: db2 });
  const otherOwnerHeaders = await authHeader({ sub: "user-1", permissions: ["graph:read", "graph:write"] });

  const firstRemoval = await del2("/v1/graphs/g2/access/user-2", otherOwnerHeaders);
  assert.equal(firstRemoval.status, 200);

  const lastOwnerRemoval = await del2("/v1/graphs/g2/access/user-1", otherOwnerHeaders);
  assert.equal(lastOwnerRemoval.status, 409);
  assert.match(lastOwnerRemoval.body.error.message, /at least one owner/);
});

test("GET /v1/graphs/:graphId/access can be called by a viewer", async () => {
  const db = createGraphDB();
  seedGraph(db, { id: "g1", owners: ["user-2"], viewers: ["user-1"] });
  const { get } = harness({ GRAPH_DB: db });
  const headers = await authHeader({ sub: "user-1", permissions: ["graph:read", "graph:write"] });

  const { status, body } = await get("/v1/graphs/g1/access", headers);

  assert.equal(status, 200);
  assert.equal(body.count, 2);
});

test("access routes return 404 for a non-existent graphId", async () => {
  const { put, del, get } = harness();
  const headers = await authHeader();

  assert.equal((await put("/v1/graphs/missing/access/user-2", { role: "viewer" }, headers)).status, 404);
  assert.equal((await del("/v1/graphs/missing/access/user-2", headers)).status, 404);
  assert.equal((await get("/v1/graphs/missing/access", headers)).status, 404);
});

test("DELETE /v1/graphs/:graphId/access/:userId returns 404 when the target has no access row", async () => {
  const db = createGraphDB();
  seedGraph(db, { id: "g1", owners: ["user-1"] });
  const { del } = harness({ GRAPH_DB: db });
  const headers = await authHeader();

  const { status, body } = await del("/v1/graphs/g1/access/user-2", headers);

  assert.equal(status, 404);
  assert.match(body.error.message, /not found/i);
});

test("unknown routes return 404", async () => {
  const { get } = harness();
  const { status, body } = await get("/unknown");

  assert.equal(status, 404);
  assert.equal(body.error.message, "Endpoint not found");
});
