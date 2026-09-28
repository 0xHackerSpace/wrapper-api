export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

export function error(message, status = 400) {
  return json({ error: { message, type: "invalid_request_error" } }, status);
}

export function badRequest(message) {
  return error(message, 400);
}

export function unauthorized(message) {
  return error(message, 401);
}

export function forbidden(message) {
  return error(message, 403);
}

export function notFound(message = "Not found") {
  return error(message, 404);
}

export function conflict(message) {
  return error(message, 409);
}

export function internalError(message) {
  return error(message, 500);
}
