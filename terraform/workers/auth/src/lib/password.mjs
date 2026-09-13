const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function hashPassword(password, salt = null) {
  if (!salt) {
    salt = crypto.getRandomValues(new Uint8Array(16));
  }

  const iterations = 100000;
  const key = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations,
      hash: "SHA-256",
    },
    await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveKey"]),
    { name: "HMAC", hash: "SHA-256" },
    true,
    ["sign"]
  );

  const exportedKey = await crypto.subtle.exportKey("raw", key);
  const saltHex = Array.from(salt).map((b) => b.toString(16).padStart(2, "0")).join("");
  const keyHex = Array.from(new Uint8Array(exportedKey))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return `pbkdf2:sha256:100000:${saltHex}:${keyHex}`;
}

export async function verifyPassword(password, hash) {
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

export function generateRandomId() {
  return crypto.randomUUID();
}
