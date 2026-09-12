// Runs with the Node.js test runner and no dependencies: node --test tests
import assert from "node:assert/strict";
import test from "node:test";

import worker from "../terraform/workers/ai/src/index.mjs";

function harness(overrides = {}) {
  const runCalls = [];
  const env = {
    AI: {
      async run(model, input) {
        runCalls.push({ model, input });
        return { response: "mocked response", usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
      },
    },
    ...overrides,
  };

  const call = async (path, init) => {
    const response = await worker.fetch(new Request(`https://ai.test${path}`, init), env, {});
    return { status: response.status, body: await response.json() };
  };
  const get = (path) => call(path, { method: "GET" });
  const post = (path, body) =>
    call(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

  return { env, runCalls, call, get, post };
}

test("GET /health reports service status", async () => {
  const { get } = harness();
  const { status, body } = await get("/health");

  assert.equal(status, 200);
  assert.equal(body.service, "ai");
  assert.equal(body.status, "ok");
});

test("GET / and GET /v1 describe available endpoints", async () => {
  const { get } = harness();

  const root = await get("/");
  assert.equal(root.status, 200);
  assert.equal(root.body.service, "ai");
  assert.ok(root.body.endpoints.chat_completions);

  const v1 = await get("/v1");
  assert.equal(v1.status, 200);
  assert.equal(v1.body.service, "ai");
});

test("GET /v1/models lists available models", async () => {
  const { get } = harness();
  const { status, body } = await get("/v1/models");

  assert.equal(status, 200);
  assert.equal(body.object, "list");
  assert.ok(body.data.some((m) => m.id === "@cf/mistral/mistral-7b-instruct-v0.1"));
});

test("POST /v1/chat/completions returns an OpenAI-compatible response", async () => {
  const { post } = harness();
  const { status, body } = await post("/v1/chat/completions", {
    messages: [{ role: "user", content: "hello" }],
  });

  assert.equal(status, 200);
  assert.equal(body.object, "chat.completion");
  assert.ok(body.id.startsWith("chatcmpl-"));
  assert.equal(body.choices[0].message.role, "assistant");
  assert.equal(body.choices[0].message.content, "mocked response");
  assert.equal(body.choices[0].finish_reason, "stop");
  assert.deepEqual(body.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
});

test("POST /v1/chat/completions rejects missing or empty messages", async () => {
  const { post } = harness();

  assert.equal((await post("/v1/chat/completions", {})).status, 400);
  assert.equal((await post("/v1/chat/completions", { messages: [] })).status, 400);
  assert.equal((await post("/v1/chat/completions", { messages: [{ role: "user" }] })).status, 400);
  assert.equal((await post("/v1/chat/completions", { messages: [{ role: "bogus", content: "hi" }] })).status, 400);
});

test("POST /v1/chat/completions fails closed when AI binding is missing", async () => {
  const { post } = harness({ AI: undefined });
  const { status, body } = await post("/v1/chat/completions", {
    messages: [{ role: "user", content: "hi" }],
  });

  assert.equal(status, 500);
  assert.match(body.error.message, /AI binding/);
});

test("a system message is merged into the first user message before reaching Workers AI", async () => {
  // Cloudflare Workers AI requires strict user/assistant role alternation and rejects
  // a bare "system" role (error 3030). The worker must normalize it away.
  const { post, runCalls } = harness();

  const { status } = await post("/v1/chat/completions", {
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "hello" },
    ],
  });

  assert.equal(status, 200);
  assert.equal(runCalls.length, 1);

  const sentRoles = runCalls[0].input.messages.map((m) => m.role);
  assert.deepEqual(sentRoles, ["user"], "no 'system' role should ever reach Workers AI");
  assert.match(runCalls[0].input.messages[0].content, /You are a helpful assistant/);
  assert.match(runCalls[0].input.messages[0].content, /hello/);
});

test("unknown endpoints return 404", async () => {
  const { get } = harness();
  const { status } = await get("/unknown");

  assert.equal(status, 404);
});
