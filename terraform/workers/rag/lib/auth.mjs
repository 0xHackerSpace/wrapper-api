import { verifyToken } from "./jwt.mjs";

export class AuthError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

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

export async function requireJWTAuth(request, env) {
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

export async function optionalJWTAuth(request, env) {
  try {
    return await requireJWTAuth(request, env);
  } catch (error) {
    if (error instanceof AuthError) {
      return null;
    }
    throw error;
  }
}
