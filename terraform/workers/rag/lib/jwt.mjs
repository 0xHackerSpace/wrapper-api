const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function generateToken(payload, secret, expiresIn = 3600) {
  const now = Math.floor(Date.now() / 1000);
  const token = {
    header: { alg: "HS256", typ: "JWT" },
    payload: {
      ...payload,
      iat: now,
      exp: now + expiresIn,
    },
  };

  const headerEncoded = base64url(JSON.stringify(token.header));
  const payloadEncoded = base64url(JSON.stringify(token.payload));
  const message = `${headerEncoded}.${payloadEncoded}`;

  const signature = await sign(message, secret);
  return `${message}.${signature}`;
}

export async function verifyToken(token, secret) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const [headerEncoded, payloadEncoded, signatureEncoded] = parts;
    const message = `${headerEncoded}.${payloadEncoded}`;

    const expectedSignature = await sign(message, secret);
    if (signatureEncoded !== expectedSignature) return null;

    const payload = JSON.parse(base64urlDecode(payloadEncoded));
    const now = Math.floor(Date.now() / 1000);

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
  return btoa(str)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
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
