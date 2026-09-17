import { verifyToken } from "./jwt.mjs";

export class AuthError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Shared "would violate an ACL invariant" error (e.g. removing the last
// owner of a chat session or agent). Declared once here and re-exported by
// chat-db.mjs/agent-db.mjs -- same reasoning as ValidationError living in
// ai.mjs and being re-exported everywhere else -- so index.mjs's single
// `error instanceof ConflictError` check in its catch block works no matter
// which domain module actually threw it.
export class ConflictError extends Error {}

export async function extractToken(request) {
  const authHeader = request.headers.get("authorization");

  if (!authHeader) {
    return null;
  }

  if (!authHeader.startsWith("Bearer ")) {
    throw new AuthError(401, "Invalid authorization header format");
  }

  return authHeader.slice(7);
}

export async function requireAuth(request, env) {
  if (!env.JWT_SECRET) {
    throw new AuthError(500, "JWT_SECRET not configured");
  }

  const token = await extractToken(request);

  if (!token) {
    throw new AuthError(401, "Missing authorization token");
  }

  const payload = await verifyToken(token, env.JWT_SECRET);

  if (!payload) {
    throw new AuthError(401, "Invalid or expired token");
  }

  return payload;
}

export async function requirePermission(request, env, permission) {
  const payload = await requireAuth(request, env);

  if (!Array.isArray(payload.permissions) || !payload.permissions.includes(permission)) {
    throw new AuthError(403, `Missing required permission: ${permission}`);
  }

  return payload;
}
