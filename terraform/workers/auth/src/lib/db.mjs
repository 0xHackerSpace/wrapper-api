export class DatabaseError extends Error {
  constructor(message) {
    super(message);
    this.name = "DatabaseError";
  }
}

export async function getUserByUsername(db, username) {
  if (!db) {
    throw new DatabaseError("Database not configured");
  }

  const result = await db
    .prepare("SELECT id, username, email, password_hash, first_name, last_name, status FROM users WHERE username = ?")
    .bind(username)
    .first();

  return result || null;
}

export async function createUser(db, { id, username, email, passwordHash, firstName, lastName }) {
  if (!db) {
    throw new DatabaseError("Database not configured");
  }

  const result = await db
    .prepare(
      "INSERT INTO users (id, username, email, password_hash, first_name, last_name, status) VALUES (?, ?, ?, ?, ?, ?, 'active')"
    )
    .bind(id, username, email, passwordHash, firstName || null, lastName || null)
    .run();

  if (!result.success) {
    throw new DatabaseError("Failed to create user");
  }

  return { id, username, email, firstName, lastName };
}

export async function updateLastLogin(db, userId) {
  if (!db) {
    throw new DatabaseError("Database not configured");
  }

  await db
    .prepare("UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(userId)
    .run();
}

export async function logAuthAttempt(db, { userId, action, ipAddress, userAgent, status }) {
  if (!db) {
    return;
  }

  const id = crypto.randomUUID();

  try {
    await db
      .prepare(
        "INSERT INTO auth_logs (id, user_id, action, ip_address, user_agent, status) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .bind(id, userId || null, action, ipAddress, userAgent, status)
      .run();
  } catch {
    // Silently fail logging - não deve impedir autenticação
    console.warn("Failed to log auth attempt");
  }
}

export async function getUserStats(db) {
  if (!db) {
    return null;
  }

  try {
    const result = await db
      .prepare(
        "SELECT COUNT(*) as total, SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active FROM users"
      )
      .first();

    return result;
  } catch {
    return null;
  }
}
