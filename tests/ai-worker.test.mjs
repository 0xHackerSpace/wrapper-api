// Runs with the Node.js test runner and no dependencies: node --test tests
import assert from "node:assert/strict";
import test from "node:test";

import AiWorker from "../terraform/workers/ai/src/index.mjs";
import { generateToken } from "../terraform/workers/ai/src/lib/jwt.mjs";

const JWT_SECRET = "test-secret";

function harness(overrides = {}) {
  const runCalls = [];
  const env = {
    JWT_SECRET,
    AI: {
      async run(model, input) {
        runCalls.push({ model, input });
        return { response: "mocked response", usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
      },
    },
    ...overrides,
  };

  const worker = new AiWorker({}, env);

  const call = async (path, init) => {
    const response = await worker.fetch(new Request(`https://ai.test${path}`, init));
    return { status: response.status, body: await response.json() };
  };
  const get = (path, headers = {}) => call(path, { method: "GET", headers });
  const post = (path, body, headers = {}) =>
    call(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });

  return { env, worker, runCalls, call, get, post };
}

async function authHeader(payload = { sub: "user-1", permissions: ["ai:chat"] }) {
  const token = await generateToken(payload, JWT_SECRET);
  return { authorization: `Bearer ${token}` };
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
  const headers = await authHeader();
  const { status, body } = await post(
    "/v1/chat/completions",
    { messages: [{ role: "user", content: "hello" }] },
    headers
  );

  assert.equal(status, 200);
  assert.equal(body.object, "chat.completion");
  assert.ok(body.id.startsWith("chatcmpl-"));
  assert.equal(body.choices[0].message.role, "assistant");
  assert.equal(body.choices[0].message.content, "mocked response");
  assert.equal(body.choices[0].finish_reason, "stop");
  assert.deepEqual(body.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
});

test("POST /v1/chat/completions requires a valid JWT with the ai:chat permission", async () => {
  const { post } = harness();

  const noToken = await post("/v1/chat/completions", { messages: [{ role: "user", content: "hi" }] });
  assert.equal(noToken.status, 401);

  const invalidToken = await post(
    "/v1/chat/completions",
    { messages: [{ role: "user", content: "hi" }] },
    { authorization: "Bearer invalid" }
  );
  assert.equal(invalidToken.status, 401);

  const withoutPermission = await authHeader({ sub: "user-1", permissions: [] });
  const forbidden = await post(
    "/v1/chat/completions",
    { messages: [{ role: "user", content: "hi" }] },
    withoutPermission
  );
  assert.equal(forbidden.status, 403);
});

test("POST /v1/chat/completions rejects missing or empty messages", async () => {
  const { post } = harness();
  const headers = await authHeader();

  assert.equal((await post("/v1/chat/completions", {}, headers)).status, 400);
  assert.equal((await post("/v1/chat/completions", { messages: [] }, headers)).status, 400);
  assert.equal((await post("/v1/chat/completions", { messages: [{ role: "user" }] }, headers)).status, 400);
  assert.equal((await post("/v1/chat/completions", { messages: [{ role: "bogus", content: "hi" }] }, headers)).status, 400);
});

test("POST /v1/chat/completions fails closed when AI binding is missing", async () => {
  const { post } = harness({ AI: undefined });
  const headers = await authHeader();
  const { status, body } = await post(
    "/v1/chat/completions",
    { messages: [{ role: "user", content: "hi" }] },
    headers
  );

  assert.equal(status, 500);
  assert.match(body.error.message, /AI binding/);
});

test("POST /v1/chat/completions fails closed when JWT_SECRET is missing", async () => {
  const { post } = harness({ JWT_SECRET: undefined });
  const { status, body } = await post("/v1/chat/completions", { messages: [{ role: "user", content: "hi" }] });

  assert.equal(status, 500);
  assert.match(body.error.message, /JWT_SECRET/);
});

test("a system message is merged into the first user message before reaching Workers AI", async () => {
  // Cloudflare Workers AI requires strict user/assistant role alternation and rejects
  // a bare "system" role (error 3030). The worker must normalize it away.
  const { post, runCalls } = harness();
  const headers = await authHeader();

  const { status } = await post(
    "/v1/chat/completions",
    {
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "hello" },
      ],
    },
    headers
  );

  assert.equal(status, 200);
  assert.equal(runCalls.length, 1);

  const sentRoles = runCalls[0].input.messages.map((m) => m.role);
  assert.deepEqual(sentRoles, ["user"], "no 'system' role should ever reach Workers AI");
  assert.match(runCalls[0].input.messages[0].content, /You are a helpful assistant/);
  assert.match(runCalls[0].input.messages[0].content, /hello/);
});

test("chat() RPC method returns a chat completion without going through HTTP", async () => {
  // Simulates how another worker calls this one over a Service Binding (RPC),
  // bypassing fetch()/requirePermission entirely.
  const { worker, runCalls } = harness();

  const result = await worker.chat([{ role: "user", content: "hello" }]);

  assert.equal(result.object, "chat.completion");
  assert.equal(result.choices[0].message.role, "assistant");
  assert.equal(result.choices[0].message.content, "mocked response");
  assert.equal(runCalls.length, 1);
});

test("chat() RPC method validates messages the same way as the HTTP endpoint", async () => {
  const { worker } = harness();

  await assert.rejects(() => worker.chat([]), /messages array cannot be empty/);
  await assert.rejects(() => worker.chat([{ role: "bogus", content: "hi" }]), /message role must be/);
});

test("unknown endpoints return 404", async () => {
  const { get } = harness();
  const { status } = await get("/unknown");

  assert.equal(status, 404);
});
