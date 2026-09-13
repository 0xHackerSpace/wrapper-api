export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
  });
}

export function error(message, status = 400, details = {}) {
  return json({ error: message, ...details }, status);
}

export function unauthorized(message = "Unauthorized") {
  return error(message, 401);
}

export function forbidden(message = "Forbidden") {
  return error(message, 403);
}

export function notFound() {
  return error("Not Found", 404);
}

export function badRequest(message = "Bad Request") {
  return error(message, 400);
}

export function internalError(message = "Internal Server Error", details = {}) {
  return error(message, 500, details);
}
