// Runs with the Node.js test runner and no dependencies: node --test tests
import assert from "node:assert/strict";
import test from "node:test";

import AiWorker from "../terraform/workers/ai/src/index.mjs";
import { generateToken } from "../terraform/workers/ai/src/lib/jwt.mjs";

const JWT_SECRET = "test-secret";

// In-memory mock of CHAT_DB (dev-chat: chat_sessions + chat_messages), same
// approach as tests/graph-worker.test.mjs's createGraphDB(): interprets
// prepare(sql).bind(...).first()/.all()/.run() via substring matching on the
// query text rather than executing real SQL.
function createChatDB(seedSessions = [], seedMessages = []) {
  const sessions = [...seedSessions];
  const messages = [...seedMessages];

  // Monotonic fake clock so created_at/updated_at strictly increase across
  // inserts/updates, even when several happen within the same millisecond --
  // needed to deterministically test ordering (e.g. GET /v1/sessions).
  let clock = 0;
  function nextTimestamp() {
    clock += 1;
    return new Date(Date.UTC(2024, 0, 1, 0, 0, 0, clock)).toISOString();
  }

  function makeStatement(sql) {
    let boundArgs = [];
    return {
      bind(...args) {
        boundArgs = args;
        return this;
      },
      async first() {
        if (sql.includes("FROM chat_sessions") && sql.includes("WHERE id = ? AND user_id = ?")) {
          const [id, userId] = boundArgs;
          return sessions.find((s) => s.id === id && s.user_id === userId) || null;
        }
        if (sql.includes("FROM chat_messages") && sql.includes("WHERE id = ?")) {
          const [id] = boundArgs;
          return messages.find((m) => m.id === id) || null;
        }
        return null;
      },
      async all() {
        if (sql.includes("FROM chat_sessions") && sql.includes("WHERE user_id = ?") && sql.includes("ORDER BY updated_at DESC")) {
          const [userId] = boundArgs;
          const results = sessions
            .filter((s) => s.user_id === userId)
            .sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));
          return { results };
        }
        if (sql.includes("FROM chat_messages") && sql.includes("ORDER BY created_at ASC")) {
          const [sessionId] = boundArgs;
          const results = messages
            .filter((m) => m.session_id === sessionId)
            .sort((a, b) => (a.created_at || "").localeCompare(b.created_at || ""));
          return { results };
        }
        if (sql.includes("FROM chat_messages") && sql.includes("ORDER BY created_at DESC LIMIT ?")) {
          const [sessionId, limit] = boundArgs;
          const results = messages
            .filter((m) => m.session_id === sessionId)
            .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""))
            .slice(0, limit);
          return { results };
        }
        return { results: [] };
      },
      async run() {
        if (sql.startsWith("INSERT INTO chat_sessions")) {
          const [id, userId] = boundArgs;
          const now = nextTimestamp();
          sessions.push({ id, user_id: userId, title: null, created_at: now, updated_at: now });
          return { success: true };
        }
        if (sql.startsWith("INSERT INTO chat_messages")) {
          const [id, sessionId, role, content] = boundArgs;
          messages.push({ id, session_id: sessionId, role, content, created_at: nextTimestamp() });
          return { success: true };
        }
        if (sql.startsWith("UPDATE chat_sessions")) {
          const [title, id] = boundArgs;
          const row = sessions.find((s) => s.id === id);
          if (row) {
            row.updated_at = nextTimestamp();
            if (row.title === null || row.title === undefined) {
              row.title = title;
            }
          }
          return { success: true };
        }
        if (sql.startsWith("DELETE FROM chat_sessions")) {
          const [id, userId] = boundArgs;
          const index = sessions.findIndex((s) => s.id === id && s.user_id === userId);
          if (index !== -1) {
            sessions.splice(index, 1);
            // Simulates the ON DELETE CASCADE constraint on chat_messages
            // (migration 0014) -- no manual cleanup needed in chat-db.mjs.
            for (let i = messages.length - 1; i >= 0; i--) {
              if (messages[i].session_id === id) messages.splice(i, 1);
            }
          }
          return { success: true };
        }
        return { success: false };
      },
    };
  }

  return {
    prepare: (sql) => makeStatement(sql),
    _sessions: sessions,
    _messages: messages,
  };
}

function harness(overrides = {}) {
  const runCalls = [];
  const chatDb = "CHAT_DB" in overrides ? overrides.CHAT_DB : createChatDB();
  const env = {
    JWT_SECRET,
    AI: {
      async run(model, input) {
        runCalls.push({ model, input });
        return { response: "mocked response", usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
      },
    },
    ...overrides,
    CHAT_DB: chatDb,
  };

  const worker = new AiWorker({}, env);

  const call = async (path, init) => {
    const response = await worker.fetch(new Request(`https://ai.test${path}`, init));
    return { status: response.status, body: await response.json() };
  };
  const get = (path, headers = {}) => call(path, { method: "GET", headers });
  const post = (path, body, headers = {}) =>
    call(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });
  const del = (path, headers = {}) => call(path, { method: "DELETE", headers });

  return { env, worker, runCalls, chatDb, call, get, post, del };
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

// --- Chat sessions (docs/specs/chat-sessions.md) ---

test("POST /v1/sessions creates an empty session with a null title", async () => {
  const { post } = harness();
  const headers = await authHeader();

  const { status, body } = await post("/v1/sessions", {}, headers);

  assert.equal(status, 201);
  assert.ok(body.id);
  assert.equal(body.title, null);
  assert.ok(body.created_at);
});

test("session routes require a valid JWT with the ai:chat permission", async () => {
  const { post } = harness();

  const noToken = await post("/v1/sessions", {});
  assert.equal(noToken.status, 401);

  const withoutPermission = await authHeader({ sub: "user-1", permissions: [] });
  const forbidden = await post("/v1/sessions", {}, withoutPermission);
  assert.equal(forbidden.status, 403);
});

test("POST /v1/sessions/:id/messages on another user's session returns 404, not 403", async () => {
  const { post } = harness();
  const ownerHeaders = await authHeader({ sub: "user-1", permissions: ["ai:chat"] });
  const otherHeaders = await authHeader({ sub: "user-2", permissions: ["ai:chat"] });

  const created = await post("/v1/sessions", {}, ownerHeaders);
  const sessionId = created.body.id;

  const { status, body } = await post(`/v1/sessions/${sessionId}/messages`, { content: "hi" }, otherHeaders);

  assert.equal(status, 404);
  assert.match(body.error.message, /not found/i);
});

test("GET and DELETE /v1/sessions/:id also 404 for a session belonging to another user", async () => {
  const { get, del, post } = harness();
  const ownerHeaders = await authHeader({ sub: "user-1", permissions: ["ai:chat"] });
  const otherHeaders = await authHeader({ sub: "user-2", permissions: ["ai:chat"] });

  const created = await post("/v1/sessions", {}, ownerHeaders);
  const sessionId = created.body.id;

  assert.equal((await get(`/v1/sessions/${sessionId}`, otherHeaders)).status, 404);
  assert.equal((await del(`/v1/sessions/${sessionId}`, otherHeaders)).status, 404);
});

test("the first message in a session fills in the title, truncated to ~50 chars", async () => {
  const { post, get } = harness();
  const headers = await authHeader();

  const created = await post("/v1/sessions", {}, headers);
  const sessionId = created.body.id;
  assert.equal(created.body.title, null);

  const longContent = "a".repeat(80);
  const sent = await post(`/v1/sessions/${sessionId}/messages`, { content: longContent }, headers);

  assert.equal(sent.status, 200);
  assert.equal(sent.body.session_id, sessionId);
  assert.equal(sent.body.message.role, "assistant");
  assert.equal(sent.body.message.content, "mocked response");
  assert.deepEqual(sent.body.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });

  const session = await get(`/v1/sessions/${sessionId}`, headers);
  assert.equal(session.body.title, longContent.slice(0, 50));

  // A second message must not overwrite the already-filled title.
  await post(`/v1/sessions/${sessionId}/messages`, { content: "second message" }, headers);
  const sessionAfter = await get(`/v1/sessions/${sessionId}`, headers);
  assert.equal(sessionAfter.body.title, longContent.slice(0, 50));
});

test("POST /v1/sessions/:id/messages rejects empty content", async () => {
  const { post } = harness();
  const headers = await authHeader();

  const created = await post("/v1/sessions", {}, headers);
  const sessionId = created.body.id;

  assert.equal((await post(`/v1/sessions/${sessionId}/messages`, {}, headers)).status, 400);
  assert.equal((await post(`/v1/sessions/${sessionId}/messages`, { content: "   " }, headers)).status, 400);
});

test("a session with more than 20 messages only sends the last 20 to the model, but GET returns the full history", async () => {
  const { post, get, runCalls, chatDb } = harness();
  const headers = await authHeader();

  const created = await post("/v1/sessions", {}, headers);
  const sessionId = created.body.id;

  // Seed 25 prior messages directly in D1, bypassing the HTTP endpoint.
  for (let i = 1; i <= 25; i++) {
    chatDb._messages.push({
      id: `seed-${i}`,
      session_id: sessionId,
      role: i % 2 === 0 ? "assistant" : "user",
      content: `history message ${i}`,
      created_at: new Date(Date.UTC(2023, 0, 1, 0, 0, i)).toISOString(),
    });
  }

  const sent = await post(`/v1/sessions/${sessionId}/messages`, { content: "the newest message" }, headers);
  assert.equal(sent.status, 200);

  // 25 seeded + 1 new user message = 26 persisted before the call; only the
  // last 20 (the window) should have been sent to AI.run().
  const lastCall = runCalls[runCalls.length - 1];
  assert.equal(lastCall.input.messages.length, 20);
  assert.equal(lastCall.input.messages[19].content, "the newest message");
  assert.equal(lastCall.input.messages[0].content, "history message 7");

  // Full history (25 seeded + user message + assistant reply = 27) is still
  // all persisted and returned by GET, nothing is discarded.
  const session = await get(`/v1/sessions/${sessionId}`, headers);
  assert.equal(session.body.messages.length, 27);
});

test("DELETE /v1/sessions/:id cascades to its messages", async () => {
  const { post, get, del, chatDb } = harness();
  const headers = await authHeader();

  const created = await post("/v1/sessions", {}, headers);
  const sessionId = created.body.id;
  await post(`/v1/sessions/${sessionId}/messages`, { content: "hello" }, headers);

  assert.ok(chatDb._messages.some((m) => m.session_id === sessionId));

  const { status, body } = await del(`/v1/sessions/${sessionId}`, headers);
  assert.equal(status, 200);
  assert.deepEqual(body, { success: true });

  assert.equal(chatDb._sessions.some((s) => s.id === sessionId), false);
  assert.equal(chatDb._messages.some((m) => m.session_id === sessionId), false);

  const afterDelete = await get(`/v1/sessions/${sessionId}`, headers);
  assert.equal(afterDelete.status, 404);
});

test("GET /v1/sessions lists the user's sessions ordered by updated_at desc", async () => {
  const { post, get } = harness();
  const headers = await authHeader();

  const first = await post("/v1/sessions", {}, headers);
  const second = await post("/v1/sessions", {}, headers);

  // Sending a message to the first (older) session bumps its updated_at past
  // the second (newer, but otherwise untouched) session.
  await post(`/v1/sessions/${first.body.id}/messages`, { content: "hi" }, headers);

  const { status, body } = await get("/v1/sessions", headers);

  assert.equal(status, 200);
  assert.equal(body.object, "list");
  assert.equal(body.data.length, 2);
  assert.equal(body.data[0].id, first.body.id);
  assert.equal(body.data[1].id, second.body.id);
});

test("GET /v1/sessions only returns sessions belonging to the authenticated user", async () => {
  const { post, get } = harness();
  const user1Headers = await authHeader({ sub: "user-1", permissions: ["ai:chat"] });
  const user2Headers = await authHeader({ sub: "user-2", permissions: ["ai:chat"] });

  await post("/v1/sessions", {}, user1Headers);
  await post("/v1/sessions", {}, user2Headers);

  const { body } = await get("/v1/sessions", user1Headers);

  assert.equal(body.data.length, 1);
});
