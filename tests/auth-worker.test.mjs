// Runs with the Node.js test runner and no dependencies: node --test tests
import assert from "node:assert/strict";
import test from "node:test";

import worker from "../terraform/workers/auth/src/index.mjs";
import { hashPassword } from "../terraform/workers/auth/src/lib/password.mjs";

function createAuthDB({ users = [], permissionsByUser = {}, profilesByUser = {} } = {}) {
  const usersTable = [...users];
  const authLogs = [];

  function makeStatement(sql) {
    let boundArgs = [];
    return {
      bind(...args) {
        boundArgs = args;
        return this;
      },
      async first() {
        if (sql.includes("FROM users WHERE username = ?")) {
          return usersTable.find((u) => u.username === boundArgs[0]) || null;
        }
        if (sql.includes("COUNT(*) as total")) {
          return {
            total: usersTable.length,
            active: usersTable.filter((u) => u.status === "active").length,
          };
        }
        return null;
      },
      async all() {
        if (sql.includes("profile_permissions")) {
          return { results: permissionsByUser[boundArgs[0]] || [] };
        }
        if (sql.includes("FROM user_profiles up")) {
          return { results: profilesByUser[boundArgs[0]] || [] };
        }
        return { results: [] };
      },
      async run() {
        if (sql.startsWith("INSERT INTO users")) {
          const [id, username, email, password_hash, first_name, last_name] = boundArgs;
          usersTable.push({ id, username, email, password_hash, first_name, last_name, status: "active" });
          return { success: true };
        }
        // UPDATE users (last login) and INSERT INTO auth_logs are logging side effects
        if (sql.startsWith("INSERT INTO auth_logs")) {
          authLogs.push(boundArgs);
        }
        return { success: true };
      },
    };
  }

  return {
    prepare: (sql) => makeStatement(sql),
    _users: usersTable,
    _authLogs: authLogs,
  };
}

const JWT_SECRET = "test-secret";

function harness(overrides = {}) {
  const db = "DB" in overrides ? overrides.DB : createAuthDB();
  const env = {
    ENVIRONMENT: "test",
    JWT_SECRET,
    ...overrides,
    DB: db,
  };

  const call = async (path, init) => {
    const response = await worker.fetch(new Request(`https://auth.test${path}`, init), env, {});
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  const get = (path, headers = {}) => call(path, { method: "GET", headers });
  const post = (path, body, headers = {}) =>
    call(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });

  return { env, db, call, get, post };
}

async function seededUser(overrides = {}) {
  return {
    id: "user-1",
    username: "ianoliv",
    email: "ian@example.com",
    password_hash: await hashPassword("password123"),
    first_name: null,
    last_name: null,
    status: "active",
    ...overrides,
  };
}

test("GET /health reports service status", async () => {
  const { get } = harness();
  const { status, body } = await get("/health");

  assert.equal(status, 200);
  assert.equal(body.service, "auth");
  assert.equal(body.status, "ok");
});

test("GET / lists available endpoints", async () => {
  const { get } = harness();
  const { status, body } = await get("/");

  assert.equal(status, 200);
  assert.equal(body.service, "auth");
  assert.ok(body.endpoints.login);
});

test("all routes fail closed when JWT_SECRET is missing", async () => {
  const { get } = harness({ JWT_SECRET: undefined });
  const { status, body } = await get("/health");

  assert.equal(status, 500);
  assert.match(body.error, /JWT_SECRET/);
});

test("POST /login rejects missing credentials", async () => {
  const { post } = harness();
  const { status, body } = await post("/login", { username: "ianoliv" });

  assert.equal(status, 400);
  assert.match(body.error, /username and password/);
});

test("POST /login rejects unknown username", async () => {
  const { post } = harness();
  const { status, body } = await post("/login", { username: "nobody", password: "x" });

  assert.equal(status, 401);
  assert.match(body.error, /Invalid credentials/);
});

test("POST /login rejects wrong password", async () => {
  const user = await seededUser();
  const { post } = harness({ DB: createAuthDB({ users: [user] }) });

  const { status, body } = await post("/login", { username: "ianoliv", password: "wrong-password" });

  assert.equal(status, 401);
  assert.match(body.error, /Invalid credentials/);
});

test("POST /login rejects inactive accounts", async () => {
  const user = await seededUser({ status: "suspended" });
  const { post } = harness({ DB: createAuthDB({ users: [user] }) });

  const { status, body } = await post("/login", { username: "ianoliv", password: "password123" });

  assert.equal(status, 401);
  assert.match(body.error, /not active/);
});

test("POST /login succeeds and returns tokens with permissions/profiles", async () => {
  const user = await seededUser();
  const { post } = harness({
    DB: createAuthDB({
      users: [user],
      permissionsByUser: { "user-1": [{ resource: "api", action: "access" }] },
      profilesByUser: { "user-1": [{ id: "p1", name: "User", description: "" }] },
    }),
  });

  const { status, body } = await post("/login", { username: "ianoliv", password: "password123" });

  assert.equal(status, 200);
  assert.equal(body.token_type, "Bearer");
  assert.ok(body.token);
  assert.ok(body.refresh_token);
  assert.equal(body.user.username, "ianoliv");
  assert.deepEqual(body.permissions, [{ resource: "api", action: "access" }]);
  assert.equal(body.profiles[0].name, "User");
});

test("POST /signup validates input before touching the database", async () => {
  const { post } = harness();

  assert.equal((await post("/signup", { username: "ab", password: "password123", email: "a@b.com" })).status, 400);
  assert.equal((await post("/signup", { username: "abc", password: "short", email: "a@b.com" })).status, 400);
  assert.equal((await post("/signup", { username: "abc", password: "password123", email: "not-an-email" })).status, 400);
});

test("POST /signup creates a new user", async () => {
  const { post, db } = harness();

  const { status, body } = await post("/signup", {
    username: "newuser",
    password: "password123",
    email: "new@example.com",
  });

  assert.equal(status, 201);
  assert.equal(body.user.username, "newuser");
  assert.equal(db._users.length, 1);
});

test("POST /signup rejects duplicate usernames", async () => {
  const user = await seededUser();
  const { post } = harness({ DB: createAuthDB({ users: [user] }) });

  const { status, body } = await post("/signup", {
    username: "ianoliv",
    password: "password123",
    email: "dup@example.com",
  });

  assert.equal(status, 400);
  assert.match(body.error, /already exists/);
});

test("POST /signup requires a database connection", async () => {
  const { post } = harness({ DB: null });

  const { status, body } = await post("/signup", {
    username: "newuser",
    password: "password123",
    email: "new@example.com",
  });

  assert.equal(status, 500);
  assert.match(body.error, /database connection/);
});

test("POST /verify validates a JWT and returns its payload", async () => {
  const noDb = harness({ DB: null });
  const loginNoDb = await noDb.post("/login", { username: "guestuser", password: "password123" });
  assert.equal(loginNoDb.status, 200);

  const verifyOk = await noDb.post("/verify", { token: loginNoDb.body.token });
  assert.equal(verifyOk.status, 200);
  assert.equal(verifyOk.body.valid, true);
  assert.equal(verifyOk.body.user.username, "guestuser");

  const verifyBad = await noDb.post("/verify", { token: "not-a-valid-token" });
  assert.equal(verifyBad.status, 401);

  const verifyMissing = await noDb.post("/verify", {});
  assert.equal(verifyMissing.status, 400);
});

test("POST /refresh issues a new access token from a refresh token", async () => {
  const { post } = harness({ DB: null });
  const login = await post("/login", { username: "guestuser", password: "password123" });

  const refreshed = await post("/refresh", { refresh_token: login.body.refresh_token });
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.body.token_type, "Bearer");
  assert.ok(refreshed.body.token);

  const rejected = await post("/refresh", { refresh_token: login.body.token });
  assert.equal(rejected.status, 401);

  const missing = await post("/refresh", {});
  assert.equal(missing.status, 400);
});

test("GET /stats reports counts without a database", async () => {
  const { get } = harness({ DB: null });
  const { status, body } = await get("/stats");

  assert.equal(status, 200);
  assert.equal(body.total_users, 0);
  assert.equal(body.database, "not configured");
});

test("GET /stats reports counts from the database", async () => {
  const user = await seededUser();
  const { get } = harness({ DB: createAuthDB({ users: [user] }) });
  const { status, body } = await get("/stats");

  assert.equal(status, 200);
  assert.equal(body.total_users, 1);
  assert.equal(body.active_users, 1);
  assert.equal(body.database, "D1");
});

test("unknown routes return 404", async () => {
  const { get } = harness();
  const { status } = await get("/unknown");

  assert.equal(status, 404);
});
