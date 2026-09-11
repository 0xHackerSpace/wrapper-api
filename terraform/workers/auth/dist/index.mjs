// terraform/workers/auth/src/lib/jwt.mjs
var encoder = new TextEncoder();
var decoder = new TextDecoder();
async function generateToken(payload, secret, expiresIn = 3600) {
  const now = Math.floor(Date.now() / 1e3);
  const token = {
    header: { alg: "HS256", typ: "JWT" },
    payload: {
      ...payload,
      iat: now,
      exp: now + expiresIn
    }
  };
  const headerEncoded = base64url(JSON.stringify(token.header));
  const payloadEncoded = base64url(JSON.stringify(token.payload));
  const message = `${headerEncoded}.${payloadEncoded}`;
  const signature = await sign(message, secret);
  return `${message}.${signature}`;
}
async function verifyToken(token, secret) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [headerEncoded, payloadEncoded, signatureEncoded] = parts;
    const message = `${headerEncoded}.${payloadEncoded}`;
    const expectedSignature = await sign(message, secret);
    if (signatureEncoded !== expectedSignature) return null;
    const payload = JSON.parse(base64urlDecode(payloadEncoded));
    const now = Math.floor(Date.now() / 1e3);
    if (payload.exp && payload.exp < now) return null;
    return payload;
  } catch {
    return null;
  }
}
async function sign(message, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return base64url(String.fromCharCode(...new Uint8Array(signature)));
}
function base64url(str) {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
function base64urlDecode(str) {
  str += "===".slice((str.length + 3) % 4);
  return decoder.decode(
    Uint8Array.from(
      atob(str.replace(/-/g, "+").replace(/_/g, "/")),
      (c) => c.charCodeAt(0)
    )
  );
}

// terraform/workers/auth/src/lib/response.mjs
function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      ...headers
    }
  });
}
function error(message, status = 400, details = {}) {
  return json({ error: message, ...details }, status);
}
function unauthorized(message = "Unauthorized") {
  return error(message, 401);
}
function notFound() {
  return error("Not Found", 404);
}
function badRequest(message = "Bad Request") {
  return error(message, 400);
}
function internalError(message = "Internal Server Error", details = {}) {
  return error(message, 500, details);
}

// terraform/workers/auth/src/lib/db.mjs
var DatabaseError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "DatabaseError";
  }
};
async function getUserByUsername(db, username) {
  if (!db) {
    throw new DatabaseError("Database not configured");
  }
  const result = await db.prepare("SELECT id, username, email, password_hash, first_name, last_name, status FROM users WHERE username = ?").bind(username).first();
  return result || null;
}
async function createUser(db, { id, username, email, passwordHash, firstName, lastName }) {
  if (!db) {
    throw new DatabaseError("Database not configured");
  }
  const result = await db.prepare(
    "INSERT INTO users (id, username, email, password_hash, first_name, last_name, status) VALUES (?, ?, ?, ?, ?, ?, 'active')"
  ).bind(id, username, email, passwordHash, firstName || null, lastName || null).run();
  if (!result.success) {
    throw new DatabaseError("Failed to create user");
  }
  return { id, username, email, firstName, lastName };
}
async function updateLastLogin(db, userId) {
  if (!db) {
    throw new DatabaseError("Database not configured");
  }
  await db.prepare("UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?").bind(userId).run();
}
async function logAuthAttempt(db, { userId, action, ipAddress, userAgent, status }) {
  if (!db) {
    return;
  }
  const id = crypto.randomUUID();
  try {
    await db.prepare(
      "INSERT INTO auth_logs (id, user_id, action, ip_address, user_agent, status) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(id, userId || null, action, ipAddress, userAgent, status).run();
  } catch {
    console.warn("Failed to log auth attempt");
  }
}

// terraform/workers/auth/src/lib/password.mjs
var encoder2 = new TextEncoder();
var decoder2 = new TextDecoder();
async function hashPassword(password, salt = null) {
  if (!salt) {
    salt = crypto.getRandomValues(new Uint8Array(16));
  }
  const iterations = 1e5;
  const key = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations,
      hash: "SHA-256"
    },
    await crypto.subtle.importKey("raw", encoder2.encode(password), "PBKDF2", false, ["deriveKey"]),
    { name: "HMAC", hash: "SHA-256" },
    true,
    ["sign"]
  );
  const exportedKey = await crypto.subtle.exportKey("raw", key);
  const saltHex = Array.from(salt).map((b) => b.toString(16).padStart(2, "0")).join("");
  const keyHex = Array.from(new Uint8Array(exportedKey)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `pbkdf2:sha256:100000:${saltHex}:${keyHex}`;
}
async function verifyPassword(password, hash) {
  if (!hash || typeof hash !== "string") {
    return false;
  }
  const parts = hash.split(":");
  if (parts.length !== 5 || parts[0] !== "pbkdf2" || parts[1] !== "sha256") {
    return false;
  }
  const iterations = parseInt(parts[2], 10);
  const salt = new Uint8Array(parts[3].match(/.{1,2}/g).map((byte) => parseInt(byte, 16)));
  const storedKeyHex = parts[4];
  const newHash = await hashPassword(password, salt);
  const newParts = newHash.split(":");
  const newKeyHex = newParts[4];
  return storedKeyHex === newKeyHex;
}
function generateRandomId() {
  return crypto.randomUUID();
}

// terraform/workers/auth/src/index.mjs
var index_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname, searchParams } = url;
    if (!env.JWT_SECRET) {
      return internalError("JWT_SECRET not configured");
    }
    try {
      switch (pathname) {
        case "/health":
          return handleHealth(env);
        case "/":
          return handleInfo(env);
        case "/login":
          if (request.method !== "POST") return badRequest("Method not allowed");
          return await handleLogin(request, env);
        case "/signup":
          if (request.method !== "POST") return badRequest("Method not allowed");
          return await handleSignup(request, env);
        case "/verify":
          if (request.method !== "POST") return badRequest("Method not allowed");
          return handleVerify(request, env);
        case "/refresh":
          if (request.method !== "POST") return badRequest("Method not allowed");
          return handleRefresh(request, env);
        case "/stats":
          if (request.method !== "GET") return badRequest("Method not allowed");
          return await handleStats(env);
        default:
          return notFound();
      }
    } catch (err) {
      console.error(err);
      return internalError(err.message);
    }
  }
};
function handleHealth() {
  return json({ status: "ok", service: "auth", db: true });
}
function handleInfo(env) {
  return json({
    service: "auth",
    version: "1.0.0",
    database: env.DB ? "D1" : "none",
    endpoints: {
      health: "GET /health",
      signup: "POST /signup",
      login: "POST /login",
      verify: "POST /verify",
      refresh: "POST /refresh",
      stats: "GET /stats"
    },
    authentication: "JWT (Bearer token)"
  });
}
async function handleLogin(request, env) {
  try {
    const { username, password } = await request.json();
    if (!username || !password) {
      await logAuthAttempt(env.DB, {
        action: "login_attempt",
        status: "failed",
        ipAddress: request.headers.get("cf-connecting-ip"),
        userAgent: request.headers.get("user-agent")
      });
      return badRequest("username and password are required");
    }
    let user = null;
    if (env.DB) {
      try {
        user = await getUserByUsername(env.DB, username);
        if (!user) {
          await logAuthAttempt(env.DB, {
            action: "login_attempt",
            status: "failed",
            ipAddress: request.headers.get("cf-connecting-ip"),
            userAgent: request.headers.get("user-agent")
          });
          return unauthorized("Invalid credentials");
        }
        if (user.status !== "active") {
          await logAuthAttempt(env.DB, {
            userId: user.id,
            action: "login_blocked",
            status: "failed",
            ipAddress: request.headers.get("cf-connecting-ip"),
            userAgent: request.headers.get("user-agent")
          });
          return unauthorized("Account is not active");
        }
        const passwordValid = await verifyPassword(password, user.password_hash);
        if (!passwordValid) {
          await logAuthAttempt(env.DB, {
            userId: user.id,
            action: "login_attempt",
            status: "failed",
            ipAddress: request.headers.get("cf-connecting-ip"),
            userAgent: request.headers.get("user-agent")
          });
          return unauthorized("Invalid credentials");
        }
        await updateLastLogin(env.DB, user.id);
        await logAuthAttempt(env.DB, {
          userId: user.id,
          action: "login_success",
          status: "success",
          ipAddress: request.headers.get("cf-connecting-ip"),
          userAgent: request.headers.get("user-agent")
        });
      } catch (dbError) {
        console.error("Database error:", dbError);
        return internalError("Authentication service temporarily unavailable");
      }
    } else {
      if (username.length < 3) {
        return badRequest("Invalid username");
      }
      user = { id: username, username, email: null };
    }
    const payload = {
      sub: user.id,
      username: user.username,
      type: "access"
    };
    const token = await generateToken(payload, env.JWT_SECRET, 3600);
    const refreshToken = await generateToken(
      { ...payload, type: "refresh" },
      env.JWT_SECRET,
      86400 * 7
    );
    return json({
      token,
      refresh_token: refreshToken,
      token_type: "Bearer",
      expires_in: 3600,
      user: {
        id: user.id,
        username: user.username,
        email: user.email
      }
    });
  } catch (error2) {
    return badRequest("Invalid request body");
  }
}
async function handleSignup(request, env) {
  try {
    const { username, password, email, firstName, lastName } = await request.json();
    if (!username || !password || !email) {
      return badRequest("username, password, and email are required");
    }
    if (username.length < 3) {
      return badRequest("username must be at least 3 characters");
    }
    if (password.length < 8) {
      return badRequest("password must be at least 8 characters");
    }
    if (!email.includes("@")) {
      return badRequest("invalid email format");
    }
    if (env.DB) {
      try {
        const existingUser = await getUserByUsername(env.DB, username);
        if (existingUser) {
          await logAuthAttempt(env.DB, {
            action: "signup_attempt",
            status: "failed",
            ipAddress: request.headers.get("cf-connecting-ip"),
            userAgent: request.headers.get("user-agent")
          });
          return badRequest("username already exists");
        }
        const userId = generateRandomId();
        const passwordHash = await hashPassword(password);
        const newUser = await createUser(env.DB, {
          id: userId,
          username,
          email,
          passwordHash,
          firstName: firstName || null,
          lastName: lastName || null
        });
        await logAuthAttempt(env.DB, {
          userId,
          action: "signup_success",
          status: "success",
          ipAddress: request.headers.get("cf-connecting-ip"),
          userAgent: request.headers.get("user-agent")
        });
        return json({
          user: {
            id: newUser.id,
            username: newUser.username,
            email: newUser.email,
            firstName: newUser.firstName,
            lastName: newUser.lastName
          }
        }, 201);
      } catch (dbError) {
        console.error("Database error:", dbError);
        await logAuthAttempt(env.DB, {
          action: "signup_attempt",
          status: "failed",
          ipAddress: request.headers.get("cf-connecting-ip"),
          userAgent: request.headers.get("user-agent")
        });
        return internalError("Failed to create user");
      }
    } else {
      return internalError("User registration requires database connection");
    }
  } catch (error2) {
    return badRequest("Invalid request body");
  }
}
async function handleVerify(request, env) {
  try {
    const { token } = await request.json();
    if (!token) {
      return badRequest("token is required");
    }
    const payload = await verifyToken(token, env.JWT_SECRET);
    if (!payload) {
      return unauthorized("Invalid or expired token");
    }
    return json({
      valid: true,
      payload,
      user: { username: payload.username }
    });
  } catch (error2) {
    return badRequest("Invalid request body");
  }
}
async function handleRefresh(request, env) {
  try {
    const { refresh_token } = await request.json();
    if (!refresh_token) {
      return badRequest("refresh_token is required");
    }
    const payload = await verifyToken(refresh_token, env.JWT_SECRET);
    if (!payload || payload.type !== "refresh") {
      return unauthorized("Invalid or expired refresh token");
    }
    const newToken = await generateToken(
      {
        sub: payload.sub,
        username: payload.username,
        type: "access"
      },
      env.JWT_SECRET,
      3600
    );
    return json({
      token: newToken,
      token_type: "Bearer",
      expires_in: 3600
    });
  } catch (error2) {
    return badRequest("Invalid request body");
  }
}
async function handleStats(env) {
  if (!env.DB) {
    return json({
      total_users: 0,
      active_users: 0,
      database: "not configured"
    });
  }
  try {
    const stats = await env.DB.prepare("SELECT COUNT(*) as total, SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active FROM users").first();
    return json({
      total_users: stats?.total || 0,
      active_users: stats?.active || 0,
      database: "D1"
    });
  } catch (error2) {
    return json({
      error: "Failed to fetch stats",
      database: "D1"
    });
  }
}
export {
  index_default as default
};
