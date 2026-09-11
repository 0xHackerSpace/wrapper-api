import { json } from "./lib/response.mjs";
import { requireAuth, optionalAuth, AuthError } from "./lib/auth.mjs";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      switch (pathname) {
        case "/health":
          return handleHealth(env);

        case "/":
          return handleInfo(env);

        case "/protected":
          if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
          return handleProtected(request, env);

        case "/profile":
          if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
          return handleProfile(request, env);

        default:
          return json({ error: "Not Found" }, 404);
      }
    } catch (error) {
      if (error instanceof AuthError) {
        return json({ error: error.message }, error.status);
      }
      console.error(error);
      return json({ error: "Internal Server Error" }, 500);
    }
  },
};

function handleHealth(env) {
  return json({
    service: "api",
    status: "ok",
    environment: env.ENVIRONMENT ?? "unknown",
    authentication: "JWT Bearer Token",
  });
}

function handleInfo(env) {
  return json({
    service: "api",
    version: "1.0.0",
    environment: env.ENVIRONMENT ?? "unknown",
    endpoints: {
      health: "GET /health",
      info: "GET /",
      protected: "GET /protected (requires auth)",
      profile: "GET /profile (requires auth)",
    },
    authentication: {
      type: "JWT Bearer Token",
      header: "Authorization: Bearer {token}",
      token_source: "https://dev-auth.0xhackerspace.workers.dev/login",
    },
  });
}

async function handleProtected(request, env) {
  const payload = await requireAuth(request, env);

  return json({
    message: "Access to protected resource granted",
    user: {
      sub: payload.sub,
      username: payload.username,
    },
    token_info: {
      issued_at: new Date(payload.iat * 1000).toISOString(),
      expires_at: new Date(payload.exp * 1000).toISOString(),
      type: payload.type,
    },
  });
}

async function handleProfile(request, env) {
  const payload = await requireAuth(request, env);

  return json({
    profile: {
      username: payload.username,
      subject: payload.sub,
      authenticated: true,
      token_type: payload.type,
      issued_at: new Date(payload.iat * 1000).toISOString(),
      expires_at: new Date(payload.exp * 1000).toISOString(),
    },
  });
}
