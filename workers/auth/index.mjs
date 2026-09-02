// Authentication and authorization Worker. Clients live in the CLIENTS KV namespace and tokens are signed
// with the SIGNING_KEY secret binding, so no credential or environment specific value lives in this file.

const SERVICE = "auth";
const TOKEN_TYPE = "Bearer";
const ALGORITHM = "HS256";
const CLIENT_PREFIX = "client:";
const MIN_SIGNING_KEY_LENGTH = 32;
const MAX_FIELD_LENGTH = 256;
const MAX_TOKEN_LENGTH = 4096;
// Compared against the supplied secret when the client is unknown, so both paths cost the same.
const ABSENT_CLIENT_HASH = "0".repeat(64);

const DEFAULTS = {
  tokenTtl: 3600,
  issuer: "auth",
};

class HttpError extends Error {
  constructor(status, message, description) {
    super(message);
    this.status = status;
    this.description = description;
  }
}

function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...init.headers,
    },
  });
}

function integer(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

function configuration(env) {
  return {
    environment: env.ENVIRONMENT ?? "unknown",
    issuer: env.TOKEN_ISSUER ?? DEFAULTS.issuer,
    tokenTtl: clamp(integer(env.TOKEN_TTL, DEFAULTS.tokenTtl), 60, 86400),
  };
}

function requireBindings(env) {
  for (const binding of ["CLIENTS", "SIGNING_KEY"]) {
    if (!env[binding]) {
      throw new HttpError(500, "server_error", `missing binding ${binding}`);
    }
  }
  if (env.SIGNING_KEY.length < MIN_SIGNING_KEY_LENGTH) {
    throw new HttpError(500, "server_error", `SIGNING_KEY must have at least ${MIN_SIGNING_KEY_LENGTH} characters`);
  }
}

const encoder = new TextEncoder();

function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlDecode(value) {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function constantTimeEquals(left, right) {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let mismatch = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    mismatch |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return mismatch === 0;
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function signingKey(env) {
  return crypto.subtle.importKey("raw", encoder.encode(env.SIGNING_KEY), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

async function issueToken(env, claims) {
  const header = base64UrlEncode(encoder.encode(JSON.stringify({ alg: ALGORITHM, typ: "JWT" })));
  const payload = base64UrlEncode(encoder.encode(JSON.stringify(claims)));
  const body = `${header}.${payload}`;
  const signature = await crypto.subtle.sign("HMAC", await signingKey(env), encoder.encode(body));
  return `${body}.${base64UrlEncode(signature)}`;
}

async function readToken(env, token) {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }
  const [header, payload, signature] = parts;
  let valid = false;
  let claims = null;
  try {
    valid = await crypto.subtle.verify(
      "HMAC",
      await signingKey(env),
      base64UrlDecode(signature),
      encoder.encode(`${header}.${payload}`),
    );
    claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload)));
  } catch {
    return null;
  }
  if (!valid || claims === null || typeof claims !== "object") {
    return null;
  }
  return claims;
}

// Authentication is opt-in and guards introspection only: /token authenticates itself with client credentials.
function authorizeCaller(request, env) {
  if (!env.AUTH_TOKEN) {
    return;
  }
  const header = request.headers.get("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!constantTimeEquals(provided, env.AUTH_TOKEN)) {
    throw new HttpError(401, "unauthorized", "the introspection endpoint requires a bearer token");
  }
}

async function readJson(request) {
  try {
    const body = await request.json();
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("not an object");
    }
    return body;
  } catch {
    throw new HttpError(400, "invalid_request", "request body must be a JSON object");
  }
}

function field(value, name, { required = true, maxLength = MAX_FIELD_LENGTH } = {}) {
  if (value === undefined || value === null) {
    if (required) {
      throw new HttpError(400, "invalid_request", `field '${name}' is required`);
    }
    return null;
  }
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new HttpError(400, "invalid_request", `field '${name}' must be a string of 1 to ${maxLength} characters`);
  }
  return value;
}

function parseScope(value, name) {
  const scope = field(value, name, { required: false });
  if (scope === null) {
    return null;
  }
  const scopes = scope.split(" ").filter((entry) => entry.length > 0);
  if (scopes.length === 0) {
    throw new HttpError(400, "invalid_scope", `field '${name}' must list space separated scopes`);
  }
  return scopes;
}

// Credentials arrive either as HTTP Basic, per RFC 6749, or in the JSON body.
function credentials(request, body) {
  const header = request.headers.get("authorization") ?? "";
  if (header.startsWith("Basic ")) {
    let decoded = "";
    try {
      decoded = new TextDecoder().decode(Uint8Array.from(atob(header.slice(6)), (character) => character.charCodeAt(0)));
    } catch {
      throw new HttpError(400, "invalid_request", "the Basic credentials are not valid base64");
    }
    const separator = decoded.indexOf(":");
    if (separator === -1) {
      throw new HttpError(400, "invalid_request", "the Basic credentials must be client_id:client_secret");
    }
    return {
      clientId: field(decoded.slice(0, separator), "client_id"),
      clientSecret: field(decoded.slice(separator + 1), "client_secret"),
    };
  }
  return {
    clientId: field(body.client_id, "client_id"),
    clientSecret: field(body.client_secret, "client_secret"),
  };
}

async function loadClient(env, clientId) {
  const record = await env.CLIENTS.get(`${CLIENT_PREFIX}${clientId}`, "json");
  if (record === null || typeof record !== "object" || typeof record.secretHash !== "string") {
    return null;
  }
  return {
    secretHash: record.secretHash,
    scopes: Array.isArray(record.scopes) ? record.scopes.filter((scope) => typeof scope === "string") : [],
    disabled: record.disabled === true,
  };
}

async function token(request, env, config) {
  const body = await readJson(request);
  const { clientId, clientSecret } = credentials(request, body);
  const requested = parseScope(body.scope, "scope");

  const client = await loadClient(env, clientId);
  const providedHash = await sha256Hex(clientSecret);
  const expectedHash = client?.secretHash ?? ABSENT_CLIENT_HASH;
  // The comparison runs for unknown clients too, so a caller cannot tell them apart by response time.
  const secretMatches = constantTimeEquals(providedHash, expectedHash);

  if (client === null || client.disabled || !secretMatches) {
    throw new HttpError(401, "invalid_client", "unknown client or wrong secret");
  }

  const granted = requested ?? client.scopes;
  const unauthorized = granted.filter((scope) => !client.scopes.includes(scope));
  if (unauthorized.length > 0) {
    throw new HttpError(403, "invalid_scope", `the client is not allowed to request ${unauthorized.join(", ")}`);
  }

  const issuedAt = Math.floor(Date.now() / 1000);
  const claims = {
    iss: config.issuer,
    sub: clientId,
    scope: granted.join(" "),
    iat: issuedAt,
    exp: issuedAt + config.tokenTtl,
    jti: crypto.randomUUID(),
  };

  return json({
    access_token: await issueToken(env, claims),
    token_type: TOKEN_TYPE,
    expires_in: config.tokenTtl,
    scope: claims.scope,
  });
}

async function introspect(request, env, config) {
  const body = await readJson(request);
  const value = field(body.token, "token", { maxLength: MAX_TOKEN_LENGTH });
  const required = parseScope(body.scope, "scope");
  const inactive = { active: false, authorized: false };

  const claims = await readToken(env, value);
  if (claims === null || claims.iss !== config.issuer || typeof claims.sub !== "string") {
    return json(inactive);
  }
  if (typeof claims.exp !== "number" || claims.exp <= Math.floor(Date.now() / 1000)) {
    return json(inactive);
  }

  const scopes = typeof claims.scope === "string" ? claims.scope.split(" ").filter((scope) => scope.length > 0) : [];
  const missing = required === null ? [] : required.filter((scope) => !scopes.includes(scope));

  return json({
    active: true,
    authorized: missing.length === 0,
    missingScopes: missing,
    subject: claims.sub,
    scopes,
    issuer: claims.iss,
    tokenId: claims.jti ?? null,
    expiresAt: new Date(claims.exp * 1000).toISOString(),
  });
}

function health(env, config) {
  return json({
    service: SERVICE,
    status: "ok",
    environment: config.environment,
    issuer: config.issuer,
    tokenTtl: config.tokenTtl,
    algorithm: ALGORITHM,
    bindings: {
      clients: Boolean(env.CLIENTS),
      signingKey: Boolean(env.SIGNING_KEY),
    },
    introspectionProtected: Boolean(env.AUTH_TOKEN),
    timestamp: new Date().toISOString(),
  });
}

const ROUTES = {
  "/health": { method: "GET", handler: (request, env, config) => health(env, config), protected: false },
  "/token": { method: "POST", handler: token, protected: false },
  "/introspect": { method: "POST", handler: introspect, protected: true },
};

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    const route = ROUTES[pathname.replace(/\/+$/, "") || "/health"];

    if (route === undefined) {
      return json({ error: "not_found" }, { status: 404 });
    }
    if (request.method !== route.method) {
      return json({ error: "method_not_allowed" }, { status: 405, headers: { allow: route.method } });
    }

    try {
      requireBindings(env);
      if (route.protected) {
        authorizeCaller(request, env);
      }
      return await route.handler(request, env, configuration(env));
    } catch (error) {
      if (error instanceof HttpError) {
        const headers = error.status === 401 ? { "www-authenticate": TOKEN_TYPE } : {};
        return json({ error: error.message, error_description: error.description }, { status: error.status, headers });
      }
      console.error(error);
      return json({ error: "server_error" }, { status: 500 });
    }
  },
};
