// Runs with the Node.js test runner and no dependencies: node --test 'tests/**/*.test.mjs'
import assert from "node:assert/strict";
import test from "node:test";

import worker from "../workers/auth/index.mjs";

const SIGNING_KEY = "a".repeat(48);
const CLIENT_ID = "rag-frontend";
const CLIENT_SECRET = "b".repeat(48);

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function harness(overrides = {}, client = {}) {
  const records = new Map([
    [
      `client:${CLIENT_ID}`,
      { secretHash: await sha256Hex(CLIENT_SECRET), scopes: ["rag:query", "rag:ingest"], ...client },
    ],
  ]);

  const env = {
    ENVIRONMENT: "test",
    TOKEN_ISSUER: "test-auth",
    TOKEN_TTL: "900",
    SIGNING_KEY,
    CLIENTS: {
      async get(key, type) {
        const record = records.get(key);
        if (record === undefined) return null;
        return type === "json" ? record : JSON.stringify(record);
      },
    },
    ...overrides,
  };

  const call = async (path, init) => {
    const response = await worker.fetch(new Request(`https://auth.test${path}`, init), env, {});
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  const post = (path, body, headers = {}) =>
    call(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });

  return { env, records, call, post };
}

const issue = async (post, body = {}) => post("/token", { client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...body });

test("GET /health reports the issuer and the bound resources", async () => {
  const { call } = await harness();
  const { status, body } = await call("/health", { method: "GET" });

  assert.equal(status, 200);
  assert.equal(body.service, "auth");
  assert.equal(body.issuer, "test-auth");
  assert.equal(body.tokenTtl, 900);
  assert.deepEqual(body.bindings, { clients: true, signingKey: true });
});

test("POST /token issues a signed token carrying the client scopes", async () => {
  const { post } = await harness();
  const { status, body } = await issue(post);

  assert.equal(status, 200);
  assert.equal(body.token_type, "Bearer");
  assert.equal(body.expires_in, 900);
  assert.equal(body.scope, "rag:query rag:ingest");

  const [header, payload, signature] = body.access_token.split(".");
  assert.ok(signature.length > 0);
  const decode = (part) => JSON.parse(Buffer.from(part, "base64url").toString());
  assert.deepEqual(decode(header), { alg: "HS256", typ: "JWT" });
  const claims = decode(payload);
  assert.equal(claims.iss, "test-auth");
  assert.equal(claims.sub, CLIENT_ID);
  assert.equal(claims.exp - claims.iat, 900);
  assert.ok(claims.jti.length > 0);
});

test("POST /token accepts HTTP Basic credentials", async () => {
  const { post } = await harness();
  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
  const { status, body } = await post("/token", {}, { authorization: `Basic ${basic}` });

  assert.equal(status, 200);
  assert.equal(body.scope, "rag:query rag:ingest");
});

test("POST /token narrows the token to the requested scopes", async () => {
  const { post } = await harness();
  const { status, body } = await issue(post, { scope: "rag:query" });

  assert.equal(status, 200);
  assert.equal(body.scope, "rag:query");
});

test("POST /token rejects bad credentials, disabled clients, and scope escalation", async () => {
  const { post } = await harness();

  const wrongSecret = await post("/token", { client_id: CLIENT_ID, client_secret: "wrong" });
  assert.equal(wrongSecret.status, 401);
  assert.equal(wrongSecret.body.error, "invalid_client");

  const unknown = await post("/token", { client_id: "ghost", client_secret: CLIENT_SECRET });
  assert.equal(unknown.status, 401);
  // An unknown client is indistinguishable from a wrong secret.
  assert.deepEqual(unknown.body, wrongSecret.body);

  const escalation = await issue(post, { scope: "admin:all" });
  assert.equal(escalation.status, 403);
  assert.equal(escalation.body.error, "invalid_scope");

  const disabled = await harness({}, { disabled: true });
  assert.equal((await issue(disabled.post)).status, 401);
});

test("POST /introspect confirms a token and checks a required scope", async () => {
  const { post } = await harness();
  const { body: issued } = await issue(post);

  const active = await post("/introspect", { token: issued.access_token });
  assert.equal(active.status, 200);
  assert.equal(active.body.active, true);
  assert.equal(active.body.authorized, true);
  assert.equal(active.body.subject, CLIENT_ID);
  assert.deepEqual(active.body.scopes, ["rag:query", "rag:ingest"]);

  const allowed = await post("/introspect", { token: issued.access_token, scope: "rag:query" });
  assert.equal(allowed.body.authorized, true);

  const denied = await post("/introspect", { token: issued.access_token, scope: "admin:all" });
  assert.equal(denied.status, 200);
  assert.equal(denied.body.active, true);
  assert.equal(denied.body.authorized, false);
  assert.deepEqual(denied.body.missingScopes, ["admin:all"]);
});

test("POST /introspect rejects tampered, foreign, and expired tokens", async () => {
  const { post } = await harness();
  const { body: issued } = await issue(post);
  const [header, payload, signature] = issued.access_token.split(".");

  const tampered = JSON.parse(Buffer.from(payload, "base64url").toString());
  tampered.scope = "admin:all";
  const forged = `${header}.${Buffer.from(JSON.stringify(tampered)).toString("base64url")}.${signature}`;
  assert.equal((await post("/introspect", { token: forged })).body.active, false);

  const foreign = await harness({ SIGNING_KEY: "c".repeat(48) });
  assert.equal((await foreign.post("/introspect", { token: issued.access_token })).body.active, false);

  const otherIssuer = await harness({ TOKEN_ISSUER: "someone-else" });
  assert.equal((await otherIssuer.post("/introspect", { token: issued.access_token })).body.active, false);

  assert.equal((await post("/introspect", { token: "not-a-token" })).body.active, false);
});

test("an expired token is inactive", async () => {
  const { post } = await harness({ TOKEN_TTL: "60" });
  const { body: issued } = await issue(post);

  const now = Date.now;
  Date.now = () => now() + 61_000;
  try {
    const { body } = await post("/introspect", { token: issued.access_token });
    assert.deepEqual(body, { active: false, authorized: false });
  } finally {
    Date.now = now;
  }
});

test("an AUTH_TOKEN binding protects introspection but not token issuing", async () => {
  const { post } = await harness({ AUTH_TOKEN: "s3cret" });
  const { body: issued } = await issue(post);

  assert.equal((await post("/introspect", { token: issued.access_token })).status, 401);
  assert.equal((await post("/introspect", { token: issued.access_token }, { authorization: "Bearer wrong" })).status, 401);
  const allowed = await post("/introspect", { token: issued.access_token }, { authorization: "Bearer s3cret" });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.active, true);
});

test("requests are validated and missing bindings fail closed", async () => {
  const { post, call } = await harness();

  assert.equal((await post("/token", { client_id: CLIENT_ID })).status, 400);
  assert.equal((await post("/token", { client_id: CLIENT_ID, client_secret: CLIENT_SECRET, scope: 42 })).status, 400);
  assert.equal((await call("/token", { method: "POST", body: "not json" })).status, 400);
  assert.equal((await post("/introspect", {})).status, 400);
  assert.equal((await call("/unknown", { method: "GET" })).status, 404);
  assert.equal((await call("/token", { method: "GET" })).status, 405);

  const unbound = await worker.fetch(new Request("https://auth.test/health"), { ENVIRONMENT: "test" }, {});
  assert.equal(unbound.status, 500);

  const shortKey = await worker.fetch(
    new Request("https://auth.test/health"),
    { CLIENTS: {}, SIGNING_KEY: "short" },
    {},
  );
  assert.equal(shortKey.status, 500);
});
