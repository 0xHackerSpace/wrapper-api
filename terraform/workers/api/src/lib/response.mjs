export function json(body, statusOrInit = {}) {
  const init = typeof statusOrInit === "number" ? { status: statusOrInit } : statusOrInit;

  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...init.headers,
    },
  });
}
