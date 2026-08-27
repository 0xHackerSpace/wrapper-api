// Runs with the Node.js test runner and no dependencies: node --test tests
import assert from "node:assert/strict";
import test from "node:test";

import worker from "../workers/rag/index.mjs";

function harness(overrides = {}) {
  const objects = new Map();
  const vectors = [];
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

  const call = async (path, init) => {
    const response = await worker.fetch(new Request(`https://rag.test${path}`, init), env, {});
    return { status: response.status, body: await response.json() };
  };
  const post = (path, body, headers = {}) =>
    call(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });

  return { env, objects, vectors, call, post };
}

const document = Array.from(
  { length: 12 },
  (_, index) => `Paragraph ${index}. ${"lorem ipsum dolor sit amet ".repeat(6)}`,
).join("\n\n");

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
  assert.equal((await post("/query", { question: "" })).status, 400);
  assert.equal((await post("/query", { question: "hi", filter: "nope" })).status, 400);
  assert.equal((await call("/query", { method: "POST", body: "not json" })).status, 400);
  assert.equal((await call("/unknown", { method: "GET" })).status, 404);
  assert.equal((await call("/ingest", { method: "GET" })).status, 405);
});

test("an AUTH_TOKEN binding protects /ingest and /query but not /health", async () => {
  const { post, call } = harness({ AUTH_TOKEN: "s3cret" });

  assert.equal((await post("/query", { question: "hi" })).status, 401);
  assert.equal((await post("/query", { question: "hi" }, { authorization: "Bearer wrong" })).status, 401);
  assert.equal((await post("/query", { question: "hi" }, { authorization: "Bearer s3cret" })).status, 200);
  assert.equal((await call("/health", { method: "GET" })).status, 200);
});

test("a missing binding fails closed", async () => {
  const response = await worker.fetch(new Request("https://rag.test/health"), { ENVIRONMENT: "test" }, {});
  assert.equal(response.status, 500);
  assert.match((await response.json()).error, /missing binding/);
});
