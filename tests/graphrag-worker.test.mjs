// Runs with the Node.js test runner and no dependencies: node --test tests
import assert from "node:assert/strict";
import test from "node:test";

import worker from "../terraform/workers/graphrag/src/index.mjs";
import { generateToken } from "../terraform/workers/graphrag/src/lib/jwt.mjs";

const JWT_SECRET = "test-secret";

function ragWorkerMock({ answer = "vector answer", sources = [{ id: "doc-1#0", documentId: "doc-1" }] } = {}) {
  const calls = [];
  return {
    calls,
    async query(question, opts) {
      calls.push({ question, opts });
      return { question, answer, sources };
    },
  };
}

function failingRagWorker(message = "rag unavailable") {
  return {
    async query() {
      throw new Error(message);
    },
  };
}

function aiWorkerMock({ extraction = { entities: [] }, finalAnswer = "final combined answer" } = {}) {
  const calls = [];
  return {
    calls,
    async chat(messages, options) {
      calls.push({ messages, options });
      // The first call in handleQuery's flow is always the entity extraction
      // call (it happens before the hybrid-prompt call), driven by the
      // system prompt used in lib/entity-extraction.mjs.
      const isExtractionCall = messages.some((m) => m.role === "system" && /candidate entities/.test(m.content));
      if (isExtractionCall) {
        return { choices: [{ message: { role: "assistant", content: JSON.stringify(extraction) } }] };
      }
      return { choices: [{ message: { role: "assistant", content: finalAnswer } }] };
    },
  };
}

function failingAiWorker(message = "ai unavailable") {
  return {
    async chat() {
      throw new Error(message);
    },
  };
}

function graphWorkerMock({ nodes = [], paths = [] } = {}) {
  const calls = { findNodeByLabel: [], findPaths: [] };
  return {
    calls,
    async findNodeByLabel(graphId, actorSub, type, label) {
      calls.findNodeByLabel.push({ graphId, actorSub, type, label });
      return nodes.find((n) => n.type === type && n.label.toLowerCase() === label.toLowerCase()) ?? null;
    },
    async findPaths(graphId, actorSub, nodeId, opts) {
      calls.findPaths.push({ graphId, actorSub, nodeId, opts });
      return paths;
    },
  };
}

function harness(overrides = {}) {
  const env = {
    ENVIRONMENT: "test",
    JWT_SECRET,
    RAG_WORKER: ragWorkerMock(),
    AI_WORKER: aiWorkerMock(),
    GRAPH_WORKER: graphWorkerMock(),
    ...overrides,
  };

  const call = async (path, init, ctx = {}) => {
    const response = await worker.fetch(new Request(`https://graphrag.test${path}`, init), env, ctx);
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  const get = (path, headers = {}) => call(path, { method: "GET", headers });
  const post = (path, body, headers = {}) =>
    call(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });

  return { env, call, get, post };
}

async function authHeader(payload = { sub: "user-1", permissions: ["graphrag:query"] }) {
  const token = await generateToken(payload, JWT_SECRET);
  return { authorization: `Bearer ${token}` };
}

test("GET /health reports service status without auth", async () => {
  const { get } = harness();
  const { status, body } = await get("/health");

  assert.equal(status, 200);
  assert.equal(body.service, "graphrag");
  assert.equal(body.status, "ok");
  assert.deepEqual(body.bindings, { rag: true, graph: true, ai: true });
});

test("POST /v1/graphrag/query requires a valid JWT with the graphrag:query permission", async () => {
  const { post } = harness();

  assert.equal((await post("/v1/graphrag/query", { question: "What pairs with garlic?" })).status, 401);
  assert.equal(
    (await post("/v1/graphrag/query", { question: "hi" }, { authorization: "Bearer invalid" })).status,
    401,
  );

  const noPermission = await authHeader({ sub: "user-1", permissions: [] });
  assert.equal((await post("/v1/graphrag/query", { question: "hi" }, noPermission)).status, 403);
});

test("POST /v1/graphrag/query rejects a missing/empty question with 400, not 500", async () => {
  const { post } = harness();
  const headers = await authHeader();

  const missing = await post("/v1/graphrag/query", {}, headers);
  assert.equal(missing.status, 400);
  assert.match(missing.body.error.message, /question/);

  const empty = await post("/v1/graphrag/query", { question: "   " }, headers);
  assert.equal(empty.status, 400);
});

test("happy path: an entity found in the graph combines vector + graph context into one answer", async () => {
  const node = { id: "n1", type: "ingredient", label: "Garlic" };
  const graphWorker = graphWorkerMock({
    nodes: [node],
    paths: [{ node: { id: "n2", label: "Ginger" }, distance: 1, path: [{ edge_id: "e1", relation: "pairs_well_with" }] }],
  });
  const aiWorker = aiWorkerMock({
    extraction: { entities: [{ type: "ingredient", label: "Garlic" }] },
    finalAnswer: "Garlic pairs well with ginger.",
  });
  const ragWorker = ragWorkerMock({ answer: "Garlic is a pungent bulb.", sources: [{ id: "doc-1#0", documentId: "doc-1" }] });
  const { post } = harness({ GRAPH_WORKER: graphWorker, AI_WORKER: aiWorker, RAG_WORKER: ragWorker });
  const headers = await authHeader();

  const { status, body } = await post("/v1/graphrag/query", { question: "What pairs well with garlic?" }, headers);

  assert.equal(status, 200);
  assert.equal(body.question, "What pairs well with garlic?");
  assert.equal(body.answer, "Garlic pairs well with ginger.");
  assert.deepEqual(body.sources, [{ id: "doc-1#0", documentId: "doc-1" }]);
  assert.equal(body.graphContext.length, 1);
  assert.equal(body.graphContext[0].entity.id, "n1");
  assert.equal(body.graphContext[0].paths.length, 1);

  assert.equal(graphWorker.calls.findNodeByLabel.length, 1);
  assert.equal(graphWorker.calls.findNodeByLabel[0].actorSub, "user-1");
  assert.equal(graphWorker.calls.findNodeByLabel[0].graphId, "rag-documents", "graphId defaults to rag-documents");
  assert.equal(graphWorker.calls.findPaths.length, 1);
  assert.equal(graphWorker.calls.findPaths[0].nodeId, "n1");

  // The final AI_WORKER.chat() call (not the extraction one) must carry both contexts.
  const finalCall = aiWorker.calls[aiWorker.calls.length - 1];
  const userMessage = finalCall.messages.find((m) => m.role === "user").content;
  assert.match(userMessage, /Garlic is a pungent bulb/);
  assert.match(userMessage, /pairs_well_with/);
});

test("no entity found in the graph degrades to a vector-only answer, still generated via AI_WORKER.chat()", async () => {
  const aiWorker = aiWorkerMock({
    extraction: { entities: [{ type: "ingredient", label: "Unicorn Fruit" }] },
    finalAnswer: "Based on the documents, there is no clear answer.",
  });
  const graphWorker = graphWorkerMock({ nodes: [] });
  const { post } = harness({ AI_WORKER: aiWorker, GRAPH_WORKER: graphWorker });
  const headers = await authHeader();

  const { status, body } = await post("/v1/graphrag/query", { question: "What is unicorn fruit?" }, headers);

  assert.equal(status, 200);
  assert.equal(body.answer, "Based on the documents, there is no clear answer.");
  assert.deepEqual(body.graphContext, []);
  assert.equal(graphWorker.calls.findPaths.length, 0, "findPaths must not run when no node was found");

  const finalCall = aiWorker.calls[aiWorker.calls.length - 1];
  const userMessage = finalCall.messages.find((m) => m.role === "user").content;
  assert.match(userMessage, /No related entities were found/);
});

test("GRAPH_WORKER errors on findNodeByLabel/findPaths degrade gracefully instead of failing the question", async () => {
  const graphWorker = {
    calls: { findNodeByLabel: 0, findPaths: 0 },
    async findNodeByLabel() {
      this.calls.findNodeByLabel++;
      throw new Error("No access to this graph");
    },
    async findPaths() {
      this.calls.findPaths++;
      throw new Error("should not be reached");
    },
  };
  const aiWorker = aiWorkerMock({ extraction: { entities: [{ type: "ingredient", label: "Garlic" }] } });
  const { post } = harness({ GRAPH_WORKER: graphWorker, AI_WORKER: aiWorker });
  const headers = await authHeader();

  const { status, body } = await post("/v1/graphrag/query", { question: "What pairs with garlic?" }, headers);

  assert.equal(status, 200);
  assert.deepEqual(body.graphContext, []);
  assert.equal(graphWorker.calls.findNodeByLabel, 1);
  assert.equal(graphWorker.calls.findPaths, 0);
});

test("findPaths failing for a found node also degrades gracefully", async () => {
  const node = { id: "n1", type: "ingredient", label: "Garlic" };
  const graphWorker = {
    calls: { findPaths: 0 },
    async findNodeByLabel() {
      return node;
    },
    async findPaths() {
      this.calls.findPaths++;
      throw new Error("service binding unreachable");
    },
  };
  const aiWorker = aiWorkerMock({ extraction: { entities: [{ type: "ingredient", label: "Garlic" }] } });
  const { post } = harness({ GRAPH_WORKER: graphWorker, AI_WORKER: aiWorker });
  const headers = await authHeader();

  const { status, body } = await post("/v1/graphrag/query", { question: "What pairs with garlic?" }, headers);

  assert.equal(status, 200);
  assert.deepEqual(body.graphContext, []);
  assert.equal(graphWorker.calls.findPaths, 1);
});

test("RAG_WORKER.query() failing propagates as a 5xx error, not a degraded answer", async () => {
  const { post } = harness({ RAG_WORKER: failingRagWorker() });
  const headers = await authHeader();

  const { status, body } = await post("/v1/graphrag/query", { question: "What pairs with garlic?" }, headers);

  assert.equal(status, 500);
  assert.match(body.error.message, /rag unavailable/);
});

test("AI_WORKER.chat() failing propagates as a 5xx error, not a degraded answer", async () => {
  const { post } = harness({ AI_WORKER: failingAiWorker() });
  const headers = await authHeader();

  const { status, body } = await post("/v1/graphrag/query", { question: "What pairs with garlic?" }, headers);

  assert.equal(status, 500);
  assert.match(body.error.message, /ai unavailable/);
});

test("unknown routes return 404", async () => {
  const { get } = harness();
  const { status, body } = await get("/unknown");

  assert.equal(status, 404);
  assert.equal(body.error.message, "Endpoint not found");
});
