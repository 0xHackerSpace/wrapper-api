// Runs with the Node.js test runner and no dependencies: node --test tests
import assert from "node:assert/strict";
import test from "node:test";

import AiWorker from "../terraform/workers/ai/src/index.mjs";
import { generateToken } from "../terraform/workers/ai/src/lib/jwt.mjs";

const JWT_SECRET = "test-secret";

// In-memory mock of CHAT_DB (dev-chat: chat_sessions + chat_access +
// chat_messages), same approach as tests/graph-worker.test.mjs's
// createGraphDB(): interprets prepare(sql).bind(...).first()/.all()/.run()
// via substring matching on the query text rather than executing real SQL.
// chat_access mirrors graph_access (see graph-worker.test.mjs's createGraphDB
// + seedGraph) adapted to sessions instead of graphs.
function createChatDB(seedSessions = [], seedAccess = [], seedMessages = []) {
  const sessions = [...seedSessions];
  const access = [...seedAccess];
  const messages = [...seedMessages];

  // Monotonic fake clock so created_at/updated_at strictly increase across
  // inserts/updates, even when several happen within the same millisecond --
  // needed to deterministically test ordering/pagination.
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
        if (sql.includes("FROM chat_sessions") && sql.includes("WHERE id = ?")) {
          const [id] = boundArgs;
          return sessions.find((s) => s.id === id) || null;
        }
        if (sql.includes("FROM chat_messages") && sql.includes("WHERE id = ?")) {
          const [id] = boundArgs;
          return messages.find((m) => m.id === id) || null;
        }
        if (sql.includes("FROM chat_access") && sql.includes("WHERE session_id = ? AND user_id = ?")) {
          const [sessionId, userId] = boundArgs;
          return access.find((a) => a.session_id === sessionId && a.user_id === userId) || null;
        }
        return null;
      },
      async all() {
        if (sql.includes("FROM chat_sessions cs") && sql.includes("JOIN chat_access ca")) {
          const hasCursor = sql.includes("cs.updated_at <");
          const userId = boundArgs[0];
          let cursorValue = null;
          let cursorId = null;
          let limit;
          if (hasCursor) {
            [, cursorValue, , cursorId, limit] = boundArgs;
          } else {
            [, limit] = boundArgs;
          }

          let results = sessions
            .filter((s) => access.some((a) => a.session_id === s.id && a.user_id === userId))
            .map((s) => ({ ...s, role: access.find((a) => a.session_id === s.id && a.user_id === userId).role }))
            .sort((a, b) => {
              const byUpdated = (b.updated_at || "").localeCompare(a.updated_at || "");
              return byUpdated !== 0 ? byUpdated : (b.id || "").localeCompare(a.id || "");
            });

          if (hasCursor) {
            results = results.filter(
              (s) => s.updated_at < cursorValue || (s.updated_at === cursorValue && s.id < cursorId)
            );
          }

          return { results: results.slice(0, limit) };
        }
        if (sql.includes("FROM chat_messages cm") && sql.includes("WHERE cm.session_id = ?")) {
          const hasCursor = sql.includes("cm.created_at >");
          const sessionId = boundArgs[0];
          let cursorValue = null;
          let cursorId = null;
          let limit;
          if (hasCursor) {
            [, cursorValue, , cursorId, limit] = boundArgs;
          } else {
            [, limit] = boundArgs;
          }

          let results = messages
            .filter((m) => m.session_id === sessionId)
            .sort((a, b) => {
              const byCreated = (a.created_at || "").localeCompare(b.created_at || "");
              return byCreated !== 0 ? byCreated : (a.id || "").localeCompare(b.id || "");
            });

          if (hasCursor) {
            results = results.filter(
              (m) => m.created_at > cursorValue || (m.created_at === cursorValue && m.id > cursorId)
            );
          }

          return { results: results.slice(0, limit) };
        }
        if (sql.includes("FROM chat_messages") && sql.includes("ORDER BY created_at DESC LIMIT ?")) {
          const [sessionId, limit] = boundArgs;
          const results = messages
            .filter((m) => m.session_id === sessionId)
            .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""))
            .slice(0, limit);
          return { results };
        }
        if (sql.includes("FROM chat_access") && sql.includes("WHERE session_id = ?") && sql.includes("ORDER BY created_at")) {
          const [sessionId] = boundArgs;
          const results = access
            .filter((a) => a.session_id === sessionId)
            .sort((x, y) => (x.created_at || "").localeCompare(y.created_at || ""));
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
        if (sql.startsWith("INSERT INTO chat_access")) {
          const [id, sessionId, userId, role] = boundArgs;
          access.push({ id, session_id: sessionId, user_id: userId, role, created_at: nextTimestamp() });
          return { success: true };
        }
        if (sql.startsWith("UPDATE chat_access")) {
          const [role, sessionId, userId] = boundArgs;
          const row = access.find((a) => a.session_id === sessionId && a.user_id === userId);
          if (row) row.role = role;
          return { success: true };
        }
        if (sql.startsWith("DELETE FROM chat_access")) {
          const [sessionId, userId] = boundArgs;
          const index = access.findIndex((a) => a.session_id === sessionId && a.user_id === userId);
          if (index !== -1) access.splice(index, 1);
          return { success: true };
        }
        if (sql.startsWith("INSERT INTO chat_messages")) {
          const [id, sessionId, role, content] = boundArgs;
          messages.push({ id, session_id: sessionId, role, content, created_at: nextTimestamp() });
          return { success: true };
        }
        // touchSession: UPDATE chat_sessions SET updated_at = CURRENT_TIMESTAMP, title = COALESCE(title, ?) WHERE id = ?
        if (sql.includes("COALESCE")) {
          const [title, id] = boundArgs;
          const row = sessions.find((s) => s.id === id);
          if (row) {
            row.updated_at = nextTimestamp();
            if (row.title === null || row.title === undefined) row.title = title;
          }
          return { success: true };
        }
        // renameSession: UPDATE chat_sessions SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
        if (sql.startsWith("UPDATE chat_sessions") && sql.includes("title = ?")) {
          const [title, id] = boundArgs;
          const row = sessions.find((s) => s.id === id);
          if (row) {
            row.title = title;
            row.updated_at = nextTimestamp();
          }
          return { success: true };
        }
        if (sql.startsWith("DELETE FROM chat_sessions")) {
          const [id] = boundArgs;
          const index = sessions.findIndex((s) => s.id === id);
          if (index !== -1) {
            sessions.splice(index, 1);
            // Simulates the ON DELETE CASCADE constraints on chat_messages
            // (migration 0014) and chat_access (migration 0015) -- no manual
            // cleanup needed in chat-db.mjs.
            for (let i = messages.length - 1; i >= 0; i--) {
              if (messages[i].session_id === id) messages.splice(i, 1);
            }
            for (let i = access.length - 1; i >= 0; i--) {
              if (access[i].session_id === id) access.splice(i, 1);
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
    _access: access,
    _messages: messages,
    _nextTimestamp: nextTimestamp,
  };
}

// Seeds a session plus its chat_access rows directly in the mock D1,
// mirroring tests/graph-worker.test.mjs's seedGraph() helper.
function seedSession(db, { id = "s1", userId = "user-1", title = null, owners, editors = [], viewers = [] } = {}) {
  const ownerIds = owners || [userId];
  const createdAt = db._nextTimestamp();
  db._sessions.push({ id, user_id: userId, title, created_at: createdAt, updated_at: createdAt });
  for (const uid of ownerIds) {
    db._access.push({ id: `acc-${id}-${uid}`, session_id: id, user_id: uid, role: "owner", created_at: db._nextTimestamp() });
  }
  for (const uid of editors) {
    db._access.push({ id: `acc-${id}-${uid}`, session_id: id, user_id: uid, role: "editor", created_at: db._nextTimestamp() });
  }
  for (const uid of viewers) {
    db._access.push({ id: `acc-${id}-${uid}`, session_id: id, user_id: uid, role: "viewer", created_at: db._nextTimestamp() });
  }
  return id;
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
  const put = (path, body, headers = {}) =>
    call(path, { method: "PUT", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });
  const patch = (path, body, headers = {}) =>
    call(path, { method: "PATCH", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });
  const del = (path, headers = {}) => call(path, { method: "DELETE", headers });

  return { env, worker, runCalls, chatDb, call, get, post, put, patch, del };
}

async function authHeader(payload = { sub: "user-1", permissions: ["ai:chat"] }) {
  const token = await generateToken(payload, JWT_SECRET);
  return { authorization: `Bearer ${token}` };
}

// Second AI.run() mock mode: when called with stream: true, returns a raw
// Workers AI SSE ReadableStream (`data: {"response":"token"}\n\n`, terminated
// by `data: [DONE]\n\n`) instead of the plain object the default harness mock
// returns. `failAfter` simulates the underlying stream erroring out mid-way
// (e.g. a model failure) by calling controller.error() instead of enqueuing
// the remaining chunks.
function createStreamingAI({
  chunks = ["mocked ", "response"],
  usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  failAfter = null,
  runCalls,
} = {}) {
  const encoder = new TextEncoder();
  return {
    async run(model, input) {
      if (runCalls) runCalls.push({ model, input });

      if (!input.stream) {
        return { response: chunks.join(""), usage };
      }

      return new ReadableStream({
        async start(controller) {
          for (let i = 0; i < chunks.length; i++) {
            if (failAfter !== null && i === failAfter) {
              controller.error(new Error("simulated stream failure"));
              return;
            }
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ response: chunks[i] })}\n\n`));
            // Yield a macrotask (not just a microtask) so the consumer's
            // reader.read() pipeline actually has a chance to drain this
            // chunk first -- per the ReadableStream spec, controller.error()
            // discards any chunks still sitting in the internal queue that
            // no pending read() has claimed yet, so a same-tick error right
            // after enqueue() can silently drop it before any test assertion
            // ever sees it.
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ response: "", usage })}\n\n`));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
    },
  };
}

// Reads a text/event-stream Response body fully and splits it back into
// individual events: parsed JSON for `data: {...}` lines, or the literal
// string "[DONE]" for the terminator.
async function readSSEEvents(response) {
  const text = await response.text();
  return text
    .split("\n\n")
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => chunk.replace(/^data:\s*/, ""))
    .map((payload) => (payload === "[DONE]" ? "[DONE]" : JSON.parse(payload)));
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
  assert.ok(root.body.endpoints.list_messages);
  assert.ok(root.body.endpoints.grant_access);

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

// --- Streaming (docs/specs/chat-streaming.md) ---

test("POST /v1/chat/completions with stream: true returns chat.completion.chunk SSE events", async () => {
  const { worker } = harness({ AI: createStreamingAI({ chunks: ["hello ", "world"] }) });
  const headers = await authHeader();

  const response = await worker.fetch(
    new Request("https://ai.test/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], stream: true }),
      headers: { "content-type": "application/json", ...headers },
    })
  );

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);

  const events = await readSSEEvents(response);
  assert.equal(events[events.length - 1], "[DONE]");

  const contentEvents = events.slice(0, -3);
  assert.deepEqual(
    contentEvents.map((e) => e.choices[0].delta.content),
    ["hello ", "world"]
  );
  for (const e of contentEvents) {
    assert.equal(e.object, "chat.completion.chunk");
    assert.equal(e.choices[0].finish_reason, null);
  }

  const [finishEvent, usageEvent] = events.slice(-3, -1);
  assert.deepEqual(finishEvent.choices[0].delta, {});
  assert.equal(finishEvent.choices[0].finish_reason, "stop");
  assert.deepEqual(usageEvent.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
});

test("POST /v1/chat/completions without stream (or stream: false) behaves exactly as before", async () => {
  const { post } = harness({ AI: createStreamingAI({ chunks: ["hello ", "world"] }) });
  const headers = await authHeader();

  const withoutField = await post("/v1/chat/completions", { messages: [{ role: "user", content: "hi" }] }, headers);
  assert.equal(withoutField.status, 200);
  assert.equal(withoutField.body.object, "chat.completion");
  assert.equal(withoutField.body.choices[0].message.content, "hello world");

  const explicitFalse = await post(
    "/v1/chat/completions",
    { messages: [{ role: "user", content: "hi" }], stream: false },
    headers
  );
  assert.equal(explicitFalse.status, 200);
  assert.equal(explicitFalse.body.object, "chat.completion");
});

test("a failure mid-stream in /v1/chat/completions emits an error chunk + [DONE], HTTP status stays 200", async () => {
  const { worker } = harness({ AI: createStreamingAI({ chunks: ["hello ", "world"], failAfter: 1 }) });
  const headers = await authHeader();

  const response = await worker.fetch(
    new Request("https://ai.test/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], stream: true }),
      headers: { "content-type": "application/json", ...headers },
    })
  );

  assert.equal(response.status, 200);

  const events = await readSSEEvents(response);
  assert.equal(events[events.length - 1], "[DONE]");

  const errorEvent = events[events.length - 2];
  assert.ok(errorEvent.error);
  assert.equal(errorEvent.error.type, "internal_error");
  assert.match(errorEvent.error.message, /simulated stream failure/);

  // Only the one content chunk before the failure should have been forwarded.
  assert.equal(events.length, 3);
  assert.equal(events[0].choices[0].delta.content, "hello ");
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

// --- Chat sessions (docs/specs/chat-sessions.md, chat-sessions-sharing-and-pagination.md) ---

test("POST /v1/sessions creates an empty session with a null title, and the creator becomes owner", async () => {
  const { post, chatDb } = harness();
  const headers = await authHeader();

  const { status, body } = await post("/v1/sessions", {}, headers);

  assert.equal(status, 201);
  assert.ok(body.id);
  assert.equal(body.title, null);
  assert.ok(body.created_at);

  const access = chatDb._access.find((a) => a.session_id === body.id && a.user_id === "user-1");
  assert.equal(access.role, "owner");
});

test("session routes require a valid JWT with the ai:chat permission", async () => {
  const { post } = harness();

  const noToken = await post("/v1/sessions", {});
  assert.equal(noToken.status, 401);

  const withoutPermission = await authHeader({ sub: "user-1", permissions: [] });
  const forbidden = await post("/v1/sessions", {}, withoutPermission);
  assert.equal(forbidden.status, 403);
});

test("a user with no chat_access row at all gets 404 on every /v1/sessions/:id* route", async () => {
  const { post, get, patch, del } = harness();
  const ownerHeaders = await authHeader({ sub: "user-1", permissions: ["ai:chat"] });
  const strangerHeaders = await authHeader({ sub: "user-2", permissions: ["ai:chat"] });

  const created = await post("/v1/sessions", {}, ownerHeaders);
  const sessionId = created.body.id;

  assert.equal((await get(`/v1/sessions/${sessionId}`, strangerHeaders)).status, 404);
  assert.equal((await del(`/v1/sessions/${sessionId}`, strangerHeaders)).status, 404);
  assert.equal((await patch(`/v1/sessions/${sessionId}`, { title: "x" }, strangerHeaders)).status, 404);

  const message = await post(`/v1/sessions/${sessionId}/messages`, { content: "hi" }, strangerHeaders);
  assert.equal(message.status, 404);
  assert.match(message.body.error.message, /not found/i);

  assert.equal((await get(`/v1/sessions/${sessionId}/messages`, strangerHeaders)).status, 404);
});

test("GET /v1/sessions/:id returns metadata and role, without an inline messages array", async () => {
  const { post, get } = harness();
  const headers = await authHeader();

  const created = await post("/v1/sessions", {}, headers);
  const sessionId = created.body.id;
  await post(`/v1/sessions/${sessionId}/messages`, { content: "hello" }, headers);

  const { status, body } = await get(`/v1/sessions/${sessionId}`, headers);

  assert.equal(status, 200);
  assert.equal(body.id, sessionId);
  assert.equal(body.role, "owner");
  assert.equal(body.messages, undefined);
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

test("POST /v1/sessions/:id/messages with stream: true persists the full assistant message only after the stream ends", async () => {
  const { worker, post, get } = harness({ AI: createStreamingAI({ chunks: ["hello ", "world"] }) });
  const headers = await authHeader();

  const created = await post("/v1/sessions", {}, headers);
  const sessionId = created.body.id;

  const response = await worker.fetch(
    new Request(`https://ai.test/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "hi", stream: true }),
      headers: { "content-type": "application/json", ...headers },
    })
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);

  const events = await readSSEEvents(response);
  assert.equal(events[events.length - 1], "[DONE]");

  const messagesAfter = await get(`/v1/sessions/${sessionId}/messages`, headers);
  const assistantMessage = messagesAfter.body.data.find((m) => m.role === "assistant");
  assert.ok(assistantMessage, "assistant message should be persisted after the stream ends");
  assert.equal(assistantMessage.content, "hello world");

  const userMessage = messagesAfter.body.data.find((m) => m.role === "user");
  assert.equal(userMessage.content, "hi");
});

test("a failure mid-stream in /v1/sessions/:id/messages persists nothing from the assistant, but the user message stays", async () => {
  const { worker, post, get } = harness({ AI: createStreamingAI({ chunks: ["hello ", "world"], failAfter: 1 }) });
  const headers = await authHeader();

  const created = await post("/v1/sessions", {}, headers);
  const sessionId = created.body.id;

  const response = await worker.fetch(
    new Request(`https://ai.test/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "hi", stream: true }),
      headers: { "content-type": "application/json", ...headers },
    })
  );
  assert.equal(response.status, 200);

  const events = await readSSEEvents(response);
  const errorEvent = events[events.length - 2];
  assert.ok(errorEvent.error);

  const messagesAfter = await get(`/v1/sessions/${sessionId}/messages`, headers);
  assert.equal(messagesAfter.body.data.filter((m) => m.role === "assistant").length, 0);
  assert.equal(messagesAfter.body.data.filter((m) => m.role === "user").length, 1);
  assert.equal(messagesAfter.body.data[0].content, "hi");
});

test("a viewer with stream: true on /v1/sessions/:id/messages gets 403 without starting a stream", async () => {
  const db = createChatDB();
  seedSession(db, { id: "s1", owners: ["user-1"], viewers: ["user-2"] });
  const { post } = harness({ CHAT_DB: db, AI: createStreamingAI() });
  const viewerHeaders = await authHeader({ sub: "user-2", permissions: ["ai:chat"] });

  const { status, body } = await post("/v1/sessions/s1/messages", { content: "hi", stream: true }, viewerHeaders);

  assert.equal(status, 403);
  assert.equal(body.error !== undefined, true);
});

test("a session with more than 20 messages only sends the last 20 to the model, but every message stays persisted", async () => {
  const { post, runCalls, chatDb } = harness();
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
  // all persisted, nothing is discarded.
  assert.equal(chatDb._messages.filter((m) => m.session_id === sessionId).length, 27);
});

test("DELETE /v1/sessions/:id cascades to its messages and chat_access rows", async () => {
  const { post, get, del, chatDb } = harness();
  const headers = await authHeader();

  const created = await post("/v1/sessions", {}, headers);
  const sessionId = created.body.id;
  await post(`/v1/sessions/${sessionId}/messages`, { content: "hello" }, headers);

  assert.ok(chatDb._messages.some((m) => m.session_id === sessionId));
  assert.ok(chatDb._access.some((a) => a.session_id === sessionId));

  const { status, body } = await del(`/v1/sessions/${sessionId}`, headers);
  assert.equal(status, 200);
  assert.deepEqual(body, { success: true });

  assert.equal(chatDb._sessions.some((s) => s.id === sessionId), false);
  assert.equal(chatDb._messages.some((m) => m.session_id === sessionId), false);
  assert.equal(chatDb._access.some((a) => a.session_id === sessionId), false);

  const afterDelete = await get(`/v1/sessions/${sessionId}`, headers);
  assert.equal(afterDelete.status, 404);
});

test("GET /v1/sessions lists the user's sessions ordered by updated_at desc, with role and a null next_cursor when done", async () => {
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
  assert.equal(body.data[0].role, "owner");
  assert.equal(body.next_cursor, null);
});

test("GET /v1/sessions only returns sessions the caller has chat_access to", async () => {
  const { post, get } = harness();
  const user1Headers = await authHeader({ sub: "user-1", permissions: ["ai:chat"] });
  const user2Headers = await authHeader({ sub: "user-2", permissions: ["ai:chat"] });

  await post("/v1/sessions", {}, user1Headers);
  await post("/v1/sessions", {}, user2Headers);

  const { body } = await get("/v1/sessions", user1Headers);

  assert.equal(body.data.length, 1);
});

test("GET /v1/sessions paginates without losing or duplicating sessions across pages", async () => {
  const db = createChatDB();
  for (let i = 1; i <= 25; i++) {
    seedSession(db, { id: `s${i}`, userId: "user-1" });
  }
  const { get } = harness({ CHAT_DB: db });
  const headers = await authHeader();

  const seen = [];
  let cursor = null;
  let pages = 0;
  do {
    const path = cursor ? `/v1/sessions?limit=10&cursor=${encodeURIComponent(cursor)}` : "/v1/sessions?limit=10";
    const { status, body } = await get(path, headers);
    assert.equal(status, 200);
    assert.ok(body.data.length <= 10);
    seen.push(...body.data.map((s) => s.id));
    cursor = body.next_cursor;
    pages += 1;
    assert.ok(pages <= 10, "pagination should terminate well before this many pages");
  } while (cursor);

  assert.equal(pages, 3);
  assert.equal(seen.length, 25);
  assert.equal(new Set(seen).size, 25, "no session id should repeat across pages");
});

test("GET /v1/sessions/:id/messages paginates the full history without losing or duplicating messages", async () => {
  const { post, get, chatDb } = harness();
  const headers = await authHeader();

  const created = await post("/v1/sessions", {}, headers);
  const sessionId = created.body.id;

  for (let i = 1; i <= 25; i++) {
    chatDb._messages.push({
      id: `m${i}`,
      session_id: sessionId,
      role: i % 2 === 0 ? "assistant" : "user",
      content: `message ${i}`,
      created_at: new Date(Date.UTC(2023, 0, 1, 0, 0, i)).toISOString(),
    });
  }

  const seen = [];
  let cursor = null;
  let pages = 0;
  do {
    const path = cursor
      ? `/v1/sessions/${sessionId}/messages?limit=10&cursor=${encodeURIComponent(cursor)}`
      : `/v1/sessions/${sessionId}/messages?limit=10`;
    const { status, body } = await get(path, headers);
    assert.equal(status, 200);
    assert.ok(body.data.length <= 10);
    seen.push(...body.data.map((m) => m.id));
    cursor = body.next_cursor;
    pages += 1;
    assert.ok(pages <= 10, "pagination should terminate well before this many pages");
  } while (cursor);

  assert.equal(pages, 3);
  assert.equal(seen.length, 25);
  assert.equal(new Set(seen).size, 25, "no message id should repeat across pages");
  // Oldest first (created_at asc), consistent across page boundaries.
  assert.deepEqual(
    seen,
    Array.from({ length: 25 }, (_, i) => `m${i + 1}`)
  );
});

// --- Sharing / ACL (docs/specs/chat-sessions-sharing-and-pagination.md) ---

test("PUT /v1/sessions/:id/access/:userId grants editor: that user can send messages and rename, but not manage access or delete", async () => {
  const db = createChatDB();
  seedSession(db, { id: "s1", owners: ["user-1"] });
  const { put, post, patch, del } = harness({ CHAT_DB: db });
  const ownerHeaders = await authHeader({ sub: "user-1", permissions: ["ai:chat"] });
  const editorHeaders = await authHeader({ sub: "user-2", permissions: ["ai:chat"] });

  const granted = await put("/v1/sessions/s1/access/user-2", { role: "editor" }, ownerHeaders);
  assert.equal(granted.status, 200);
  assert.deepEqual(granted.body.data, { session_id: "s1", user_id: "user-2", role: "editor" });

  assert.equal((await post("/v1/sessions/s1/messages", { content: "hi" }, editorHeaders)).status, 200);
  assert.equal((await patch("/v1/sessions/s1", { title: "renamed" }, editorHeaders)).status, 200);

  assert.equal((await put("/v1/sessions/s1/access/user-3", { role: "viewer" }, editorHeaders)).status, 403);
  assert.equal((await del("/v1/sessions/s1/access/user-1", editorHeaders)).status, 403);
  assert.equal((await del("/v1/sessions/s1", editorHeaders)).status, 403);
});

test("a viewer cannot send messages, rename, or delete the session (403)", async () => {
  const db = createChatDB();
  seedSession(db, { id: "s1", owners: ["user-1"], viewers: ["user-2"] });
  const { post, patch, del } = harness({ CHAT_DB: db });
  const viewerHeaders = await authHeader({ sub: "user-2", permissions: ["ai:chat"] });

  assert.equal((await post("/v1/sessions/s1/messages", { content: "hi" }, viewerHeaders)).status, 403);
  assert.equal((await patch("/v1/sessions/s1", { title: "x" }, viewerHeaders)).status, 403);
  assert.equal((await del("/v1/sessions/s1", viewerHeaders)).status, 403);
});

test("PUT /v1/sessions/:id/access/:userId rejects an invalid role with 400", async () => {
  const db = createChatDB();
  seedSession(db, { id: "s1", owners: ["user-1"] });
  const { put } = harness({ CHAT_DB: db });
  const headers = await authHeader();

  const { status, body } = await put("/v1/sessions/s1/access/user-2", { role: "admin" }, headers);

  assert.equal(status, 400);
  assert.match(body.error.message, /role/);
});

test("PUT /v1/sessions/:id/access/:userId rejects downgrading the sole owner with 409", async () => {
  const db = createChatDB();
  seedSession(db, { id: "s1", owners: ["user-1"] });
  const { put } = harness({ CHAT_DB: db });
  const headers = await authHeader();

  const { status, body } = await put("/v1/sessions/s1/access/user-1", { role: "editor" }, headers);

  assert.equal(status, 409);
  assert.match(body.error.message, /at least one owner/);
});

test("PUT /v1/sessions/:id/access/:userId upserts: granting to an existing collaborator updates the role instead of duplicating", async () => {
  const db = createChatDB();
  seedSession(db, { id: "s1", owners: ["user-1"], viewers: ["user-2"] });
  const { put } = harness({ CHAT_DB: db });
  const headers = await authHeader();

  const { status, body } = await put("/v1/sessions/s1/access/user-2", { role: "editor" }, headers);

  assert.equal(status, 200);
  assert.equal(body.data.role, "editor");
  assert.equal(db._access.filter((a) => a.user_id === "user-2").length, 1);
  assert.equal(db._access.find((a) => a.user_id === "user-2").role, "editor");
});

test("DELETE /v1/sessions/:id/access/:userId of oneself succeeds even as a mere viewer", async () => {
  const db = createChatDB();
  seedSession(db, { id: "s1", owners: ["user-1"], viewers: ["user-2"] });
  const { del } = harness({ CHAT_DB: db });
  const viewerHeaders = await authHeader({ sub: "user-2", permissions: ["ai:chat"] });

  const { status } = await del("/v1/sessions/s1/access/user-2", viewerHeaders);

  assert.equal(status, 200);
  assert.equal(db._access.some((a) => a.user_id === "user-2"), false);
});

test("DELETE /v1/sessions/:id/access/:userId rejects removing the sole owner, self or by another owner, with 409", async () => {
  const db = createChatDB();
  seedSession(db, { id: "s1", owners: ["user-1"] });
  const { del } = harness({ CHAT_DB: db });
  const selfHeaders = await authHeader({ sub: "user-1", permissions: ["ai:chat"] });

  const selfRemoval = await del("/v1/sessions/s1/access/user-1", selfHeaders);
  assert.equal(selfRemoval.status, 409);
  assert.match(selfRemoval.body.error.message, /at least one owner/);

  const db2 = createChatDB();
  seedSession(db2, { id: "s2", owners: ["user-1", "user-2"] });
  const { del: del2 } = harness({ CHAT_DB: db2 });
  const otherOwnerHeaders = await authHeader({ sub: "user-1", permissions: ["ai:chat"] });

  const firstRemoval = await del2("/v1/sessions/s2/access/user-2", otherOwnerHeaders);
  assert.equal(firstRemoval.status, 200);

  const lastOwnerRemoval = await del2("/v1/sessions/s2/access/user-1", otherOwnerHeaders);
  assert.equal(lastOwnerRemoval.status, 409);
  assert.match(lastOwnerRemoval.body.error.message, /at least one owner/);
});

test("DELETE /v1/sessions/:id/access/:userId returns 404 when the target has no access row", async () => {
  const db = createChatDB();
  seedSession(db, { id: "s1", owners: ["user-1"] });
  const { del } = harness({ CHAT_DB: db });
  const headers = await authHeader();

  const { status, body } = await del("/v1/sessions/s1/access/user-2", headers);

  assert.equal(status, 404);
  assert.match(body.error.message, /not found/i);
});

test("GET /v1/sessions/:id/access can be called by a viewer and lists every collaborator", async () => {
  const db = createChatDB();
  seedSession(db, { id: "s1", owners: ["user-2"], viewers: ["user-1"] });
  const { get } = harness({ CHAT_DB: db });
  const headers = await authHeader({ sub: "user-1", permissions: ["ai:chat"] });

  const { status, body } = await get("/v1/sessions/s1/access", headers);

  assert.equal(status, 200);
  assert.equal(body.count, 2);
  const byUser = Object.fromEntries(body.data.map((row) => [row.user_id, row.role]));
  assert.equal(byUser["user-1"], "viewer");
  assert.equal(byUser["user-2"], "owner");
});

test("access routes 404 for a session no one has access to (nonexistent session)", async () => {
  const { put, del, get } = harness();
  const headers = await authHeader();

  assert.equal((await put("/v1/sessions/missing/access/user-2", { role: "viewer" }, headers)).status, 404);
  assert.equal((await del("/v1/sessions/missing/access/user-2", headers)).status, 404);
  assert.equal((await get("/v1/sessions/missing/access", headers)).status, 404);
});

test("PATCH /v1/sessions/:id renames the session and rejects invalid titles", async () => {
  const db = createChatDB();
  seedSession(db, { id: "s1", owners: ["user-1"] });
  const { patch } = harness({ CHAT_DB: db });
  const headers = await authHeader();

  const renamed = await patch("/v1/sessions/s1", { title: "New title" }, headers);
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.title, "New title");
  assert.equal(renamed.body.role, "owner");

  assert.equal((await patch("/v1/sessions/s1", { title: "" }, headers)).status, 400);
  assert.equal((await patch("/v1/sessions/s1", { title: "   " }, headers)).status, 400);
  assert.equal((await patch("/v1/sessions/s1", { title: "a".repeat(201) }, headers)).status, 400);
  assert.equal((await patch("/v1/sessions/s1", { title: "a".repeat(200) }, headers)).status, 200);
});

test("a session created before the chat_access migration works after a simulated backfill", async () => {
  // Simulates a session row that predates migration 0015 (chat_access): it
  // exists in chat_sessions but has no corresponding chat_access row yet.
  const db = createChatDB();
  db._sessions.push({ id: "legacy-1", user_id: "user-1", title: null, created_at: "t0", updated_at: "t0" });
  const { get } = harness({ CHAT_DB: db });
  const headers = await authHeader({ sub: "user-1", permissions: ["ai:chat"] });

  const beforeBackfill = await get("/v1/sessions/legacy-1", headers);
  assert.equal(beforeBackfill.status, 404);

  // The migration's backfill inserts an owner row for chat_sessions.user_id.
  db._access.push({ id: "backfill-1", session_id: "legacy-1", user_id: "user-1", role: "owner", created_at: db._nextTimestamp() });

  const afterBackfill = await get("/v1/sessions/legacy-1", headers);
  assert.equal(afterBackfill.status, 200);
  assert.equal(afterBackfill.body.role, "owner");
});
