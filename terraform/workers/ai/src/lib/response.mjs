export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
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

export function internalError(message) {
  return error(message, 500);
}
