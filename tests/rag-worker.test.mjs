// Runs with the Node.js test runner and no dependencies: node --test tests
import assert from "node:assert/strict";
import test from "node:test";

import RagWorker from "../terraform/workers/rag/index.mjs";
import { generateToken } from "../terraform/workers/rag/lib/jwt.mjs";

function harness(overrides = {}) {
  const objects = new Map();
  const vectors = [];
  const waitUntilPromises = [];
  const env = {
    ENVIRONMENT: "test",
    EMBEDDING_MODEL: "@cf/google/embeddinggemma-300m",
    GENERATION_MODEL: "@cf/meta/llama-3.1-8b-instruct",
    EMBEDDING_DIMENSIONS: "768",
    CHUNK_SIZE: "400",
    CHUNK_OVERLAP: "60",
    TOP_K: "3",
    AI: {
      async run(model, input) {
        if (input.text) {
          return { shape: [input.text.length, 4], data: input.text.map((_, index) => [index, 1, 2, 3]) };
        }
        return { response: `answer from ${model}` };
      },
    },
    VECTORIZE: {
      async upsert(batch) {
        vectors.push(...batch);
        return { mutationId: "mutation" };
      },
      async query(_vector, options) {
        return {
          count: vectors.length,
          matches: vectors.slice(0, options.topK).map((vector, index) => ({
            id: vector.id,
            score: 0.9 - index / 100,
            metadata: vector.metadata,
          })),
        };
      },
    },
    DOCUMENTS: {
      async put(key, value, options) {
        objects.set(key, { value, options });
        return { key };
      },
    },
    ...overrides,
  };

  const ctx = { waitUntil: (promise) => waitUntilPromises.push(promise) };
  const worker = new RagWorker(ctx, env);

  const call = async (path, init) => {
    const response = await worker.fetch(new Request(`https://rag.test${path}`, init));
    return { status: response.status, body: await response.json() };
  };
  const post = (path, body, headers = {}) =>
    call(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });
  const flush = () => Promise.allSettled(waitUntilPromises);

  return { env, worker, objects, vectors, waitUntilPromises, call, post, flush };
}

const document = Array.from(
  { length: 12 },
  (_, index) => `Paragraph ${index}. ${"lorem ipsum dolor sit amet ".repeat(6)}`,
).join("\n\n");

function graphWorkerMock() {
  const nodes = [];
  const edges = [];
  const calls = { upsertNode: [], createEdge: [] };
  return {
    nodes,
    edges,
    calls,
    async upsertNode(graphId, actorSub, nodeData) {
      calls.upsertNode.push({ graphId, actorSub, nodeData });
      const existing = nodes.find((n) => n.graphId === graphId && n.type === nodeData.type && n.label === nodeData.label);
      if (existing) return existing;
      const node = { id: `node-${nodes.length + 1}`, graphId, ...nodeData };
      nodes.push(node);
      return node;
    },
    async createEdge(graphId, actorSub, edgeData) {
      calls.createEdge.push({ graphId, actorSub, edgeData });
      const duplicate = edges.find(
        (e) =>
          e.graphId === graphId &&
          e.from_node_id === edgeData.from_node_id &&
          e.to_node_id === edgeData.to_node_id &&
          e.relation === edgeData.relation,
      );
      if (duplicate) {
        throw new Error("An edge with this from_node_id, to_node_id, and relation already exists");
      }
      const edge = { id: `edge-${edges.length + 1}`, graphId, ...edgeData };
      edges.push(edge);
      return edge;
    },
  };
}

function aiWorkerMock(chatResponse) {
  const calls = [];
  return {
    calls,
    async chat(messages, options) {
      calls.push({ messages, options });
      if (typeof chatResponse === "function") {
        return chatResponse(messages, options);
      }
      return { choices: [{ message: { role: "assistant", content: JSON.stringify(chatResponse) } }] };
    },
  };
}

test("GET /health reports configuration coming from bindings", async () => {
  const { call } = harness();
  const { status, body } = await call("/health", { method: "GET" });

  assert.equal(status, 200);
  assert.equal(body.service, "rag");
  assert.equal(body.environment, "test");
  assert.equal(body.models.embedding, "@cf/google/embeddinggemma-300m");
  assert.equal(body.retrieval.topK, 3);
  assert.deepEqual(body.bindings, { ai: true, vectorize: true, documents: true });
});

test("POST /ingest chunks, embeds, upserts, and stores the document", async () => {
  const { post, objects, vectors } = harness();
  const { status, body } = await post("/ingest", {
    id: "handbook",
    text: document,
    source: "handbook.md",
    metadata: { team: "platform" },
  });

  assert.equal(status, 201);
  assert.ok(body.chunks > 1);
  assert.equal(body.vectorIds.length, body.chunks);
  assert.equal(vectors.length, body.chunks);
  assert.equal(vectors[0].id, "handbook#0");
  assert.equal(vectors[0].metadata.documentId, "handbook");
  assert.equal(vectors[0].metadata.source, "handbook.md");
  assert.equal(vectors[0].metadata.team, "platform");
  assert.ok(vectors[0].metadata.text.length > 0);

  assert.deepEqual(body.objects, {
    source: "documents/handbook/source.txt",
    manifest: "documents/handbook/manifest.json",
  });
  assert.equal(objects.get("documents/handbook/source.txt").value, document.trim());

  const manifest = JSON.parse(objects.get("documents/handbook/manifest.json").value);
  assert.equal(manifest.sourceKey, "documents/handbook/source.txt");
  assert.equal(manifest.embeddingModel, "@cf/google/embeddinggemma-300m");
  assert.equal(manifest.vectorIds.length, body.chunks);
  assert.equal(manifest.chunkSize, 400);
  assert.equal(manifest.graphId, "rag-documents", "graphId defaults to rag-documents when omitted");
});

test("POST /query answers from retrieved chunks and lists sources", async () => {
  const { post } = harness();
  await post("/ingest", { id: "handbook", text: document, source: "handbook.md" });
  const { status, body } = await post("/query", { question: "What does the handbook say?" });

  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body).sort(), ["answer", "question", "sources"]);
  assert.equal(body.question, "What does the handbook say?");
  assert.ok(body.answer.length > 0);
  assert.equal(body.sources.length, 3);
  assert.equal(body.sources[0].documentId, "handbook");
  assert.equal(body.sources[0].source, "handbook.md");
});

test("POST /query without matches answers without inventing sources", async () => {
  const { post } = harness();
  const { status, body } = await post("/query", { question: "anything" });

  assert.equal(status, 200);
  assert.deepEqual(body.sources, []);
  assert.match(body.answer, /no indexed context/i);
});

test("requests are validated before reaching Workers AI", async () => {
  const { post, call } = harness();

  assert.equal((await post("/ingest", { text: "   " })).status, 400);
  assert.equal((await post("/ingest", { id: "../escape", text: "hello" })).status, 400);
  assert.equal((await post("/ingest", { text: "hello", metadata: { source: "reserved" } })).status, 400);
  assert.equal((await post("/ingest", { text: "hello", graphId: "  " })).status, 400);
  assert.equal((await post("/query", { question: "" })).status, 400);
  assert.equal((await post("/query", { question: "hi", filter: "nope" })).status, 400);
  assert.equal((await call("/query", { method: "POST", body: "not json" })).status, 400);
  assert.equal((await call("/unknown", { method: "GET" })).status, 404);
  assert.equal((await call("/ingest", { method: "GET" })).status, 405);
});

test("a JWT_SECRET binding protects /ingest and /query but not /health", async () => {
  const { post, call } = harness({ JWT_SECRET: "s3cret" });
  const queryToken = await generateToken({ sub: "user-1", permissions: ["rag:query"] }, "s3cret");
  const ingestToken = await generateToken({ sub: "user-1", permissions: ["rag:ingest"] }, "s3cret");
  const noPermissionToken = await generateToken({ sub: "user-1", permissions: [] }, "s3cret");

  assert.equal((await post("/query", { question: "hi" })).status, 401);
  assert.equal((await post("/query", { question: "hi" }, { authorization: "Bearer wrong" })).status, 401);
  assert.equal(
    (await post("/query", { question: "hi" }, { authorization: `Bearer ${noPermissionToken}` })).status,
    403,
  );
  assert.equal((await post("/query", { question: "hi" }, { authorization: `Bearer ${queryToken}` })).status, 200);

  assert.equal(
    (await post("/ingest", { text: "hello" }, { authorization: `Bearer ${queryToken}` })).status,
    403,
    "rag:query alone must not grant rag:ingest",
  );
  assert.equal(
    (await post("/ingest", { text: "hello" }, { authorization: `Bearer ${ingestToken}` })).status,
    201,
  );

  assert.equal((await call("/health", { method: "GET" })).status, 200);
});

test("a missing binding fails closed", async () => {
  const worker = new RagWorker({}, { ENVIRONMENT: "test" });
  const response = await worker.fetch(new Request("https://rag.test/health"));
  assert.equal(response.status, 500);
  assert.match((await response.json()).error, /missing binding/);
});

test("query() RPC method returns a valid result without going through HTTP", async () => {
  // Simulates how graphrag-worker (Fase 4) calls this one over a Service Binding.
  const { worker } = harness();
  await worker.fetch(
    new Request("https://rag.test/ingest", {
      method: "POST",
      body: JSON.stringify({ id: "handbook", text: document, source: "handbook.md" }),
      headers: { "content-type": "application/json" },
    }),
  );

  const result = await worker.query("What does the handbook say?");

  assert.equal(result.question, "What does the handbook say?");
  assert.ok(result.answer.length > 0);
  assert.equal(result.sources.length, 3);
});

test("query() RPC method validates the question the same way as the HTTP endpoint", async () => {
  const { worker } = harness();

  await assert.rejects(() => worker.query(""), /question' is required/);
});

test("ingest schedules graph enrichment via ctx.waitUntil, syncing extracted entities/relations", async () => {
  const graphWorker = graphWorkerMock();
  const aiWorker = aiWorkerMock({
    entities: [
      { type: "ingredient", label: "Garlic" },
      { type: "ingredient", label: "Ginger" },
    ],
    relations: [{ from: "Garlic", to: "Ginger", relation: "pairs_well_with" }],
  });
  const { post, flush } = harness({ AI_WORKER: aiWorker, GRAPH_WORKER: graphWorker });

  const { status } = await post("/ingest", { id: "doc-1", text: document, graphId: "rag-documents" });
  assert.equal(status, 201);

  await flush();

  assert.equal(aiWorker.calls.length, 1);
  assert.equal(graphWorker.calls.upsertNode.length, 2);
  assert.equal(graphWorker.calls.upsertNode[0].actorSub, "svc-rag-enrichment");
  assert.equal(graphWorker.calls.upsertNode[0].graphId, "rag-documents");
  assert.equal(graphWorker.calls.upsertNode[0].nodeData.source_document_id, "doc-1");
  assert.equal(graphWorker.calls.createEdge.length, 1);
  assert.equal(graphWorker.calls.createEdge[0].edgeData.relation, "pairs_well_with");
  assert.equal(graphWorker.edges.length, 1);
});

test("malformed JSON from the extraction LLM does not break /ingest (still 201)", async () => {
  const graphWorker = graphWorkerMock();
  const aiWorker = aiWorkerMock(() => ({ choices: [{ message: { role: "assistant", content: "not json at all" } }] }));
  const { post, flush } = harness({ AI_WORKER: aiWorker, GRAPH_WORKER: graphWorker });

  const { status } = await post("/ingest", { id: "doc-2", text: document });
  assert.equal(status, 201);

  await flush();

  assert.equal(graphWorker.calls.upsertNode.length, 0, "no entities extracted, so nothing should sync to the graph");
});

test("a network/RPC failure talking to graph-worker does not break /ingest", async () => {
  const aiWorker = aiWorkerMock({ entities: [{ type: "ingredient", label: "Garlic" }], relations: [] });
  const graphWorker = {
    async upsertNode() {
      throw new Error("service binding unreachable");
    },
    async createEdge() {
      throw new Error("service binding unreachable");
    },
  };
  const { post, flush } = harness({ AI_WORKER: aiWorker, GRAPH_WORKER: graphWorker });

  const { status } = await post("/ingest", { id: "doc-3", text: document });
  assert.equal(status, 201);

  await assert.doesNotReject(flush());
});

test("a duplicate edge (409-style conflict) during graph sync is treated as a silent success", async () => {
  const graphWorker = graphWorkerMock();
  // Pre-seed the edge so createEdge() throws the "already exists" conflict on sync.
  graphWorker.nodes.push(
    { id: "node-1", graphId: "rag-documents", type: "ingredient", label: "Garlic" },
    { id: "node-2", graphId: "rag-documents", type: "ingredient", label: "Ginger" },
  );
  graphWorker.edges.push({
    id: "edge-1",
    graphId: "rag-documents",
    from_node_id: "node-1",
    to_node_id: "node-2",
    relation: "pairs_well_with",
  });

  const aiWorker = aiWorkerMock({
    entities: [
      { type: "ingredient", label: "Garlic" },
      { type: "ingredient", label: "Ginger" },
    ],
    relations: [{ from: "Garlic", to: "Ginger", relation: "pairs_well_with" }],
  });
  const { post, flush } = harness({ AI_WORKER: aiWorker, GRAPH_WORKER: graphWorker });

  const { status } = await post("/ingest", { id: "doc-4", text: document });
  assert.equal(status, 201);

  await assert.doesNotReject(flush());
  assert.equal(graphWorker.edges.length, 1, "the duplicate edge attempt must not create a second edge");
});

test("ingest skips graph enrichment silently when AI_WORKER/GRAPH_WORKER bindings are absent", async () => {
  const { post, flush, waitUntilPromises } = harness();

  const { status } = await post("/ingest", { id: "doc-5", text: document });
  assert.equal(status, 201);

  await flush();
  assert.equal(waitUntilPromises.length, 0, "enrichment must not even be scheduled without both bindings");
});
