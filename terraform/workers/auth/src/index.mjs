import { generateToken, verifyToken } from "./lib/jwt.mjs";
import { json, error, unauthorized, badRequest, notFound, internalError } from "./lib/response.mjs";
import { getUserByUsername, updateLastLogin, logAuthAttempt, createUser, getUserPermissions, getUserProfiles } from "./lib/db.mjs";
import { verifyPassword, hashPassword, generateRandomId } from "./lib/password.mjs";
import { requirePermission, AuthError } from "./lib/auth.mjs";

export default {
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
          return await handleStats(request, env);

        default:
          return notFound();
      }
    } catch (err) {
      if (err instanceof AuthError) {
        return error(err.message, err.status);
      }
      console.error(err);
      return internalError(err.message);
    }
  },
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
      stats: "GET /stats (requires auth + auth:stats permission)",
    },
    authentication: "JWT (Bearer token)",
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
        userAgent: request.headers.get("user-agent"),
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
            userAgent: request.headers.get("user-agent"),
          });
          return unauthorized("Invalid credentials");
        }

        if (user.status !== "active") {
          await logAuthAttempt(env.DB, {
            userId: user.id,
            action: "login_blocked",
            status: "failed",
            ipAddress: request.headers.get("cf-connecting-ip"),
            userAgent: request.headers.get("user-agent"),
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
            userAgent: request.headers.get("user-agent"),
          });
          return unauthorized("Invalid credentials");
        }

        await updateLastLogin(env.DB, user.id);
        await logAuthAttempt(env.DB, {
          userId: user.id,
          action: "login_success",
          status: "success",
          ipAddress: request.headers.get("cf-connecting-ip"),
          userAgent: request.headers.get("user-agent"),
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

    let permissions = [];
    let profiles = [];

    if (env.DB) {
      try {
        permissions = await getUserPermissions(env.DB, user.id);
        profiles = await getUserProfiles(env.DB, user.id);
      } catch (permError) {
        console.warn("Failed to fetch user permissions:", permError);
      }
    }

    const payload = {
      sub: user.id,
      username: user.username,
      type: "access",
      permissions: permissions.map(p => `${p.resource}:${p.action}`),
      profiles: profiles.map(p => p.name),
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
        email: user.email,
      },
      permissions,
      profiles,
    });
  } catch (error) {
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
            userAgent: request.headers.get("user-agent"),
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
          lastName: lastName || null,
        });

        await logAuthAttempt(env.DB, {
          userId,
          action: "signup_success",
          status: "success",
          ipAddress: request.headers.get("cf-connecting-ip"),
          userAgent: request.headers.get("user-agent"),
        });

        return json({
          user: {
            id: newUser.id,
            username: newUser.username,
            email: newUser.email,
            firstName: newUser.firstName,
            lastName: newUser.lastName,
          },
        }, 201);
      } catch (dbError) {
        console.error("Database error:", dbError);
        await logAuthAttempt(env.DB, {
          action: "signup_attempt",
          status: "failed",
          ipAddress: request.headers.get("cf-connecting-ip"),
          userAgent: request.headers.get("user-agent"),
        });
        return internalError("Failed to create user");
      }
    } else {
      return internalError("User registration requires database connection");
    }
  } catch (error) {
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
      user: { username: payload.username },
    });
  } catch (error) {
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
        type: "access",
      },
      env.JWT_SECRET,
      3600
    );

    return json({
      token: newToken,
      token_type: "Bearer",
      expires_in: 3600,
    });
  } catch (error) {
    return badRequest("Invalid request body");
  }
}

async function handleStats(request, env) {
  await requirePermission(request, env, "auth:stats");

  if (!env.DB) {
    return json({
      total_users: 0,
      active_users: 0,
      database: "not configured",
    });
  }

  try {
    const stats = await env.DB
      .prepare("SELECT COUNT(*) as total, SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active FROM users")
      .first();

    return json({
      total_users: stats?.total || 0,
      active_users: stats?.active || 0,
      database: "D1",
    });
  } catch (error) {
    return json({
      error: "Failed to fetch stats",
      database: "D1",
    });
  }
}
