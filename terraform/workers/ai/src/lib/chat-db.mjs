// D1 access for chat sessions (dev-chat, binding CHAT_DB). See
// docs/specs/chat-sessions.md for the schema and endpoint contracts this
// module backs. Reuses ai.mjs's ValidationError instead of declaring a
// second one, mirroring how graph-db.mjs reuses AuthError from auth.mjs
// within the same worker.
import { ValidationError } from "./ai.mjs";

export { ValidationError };

const CONTEXT_WINDOW_SIZE = 20;

function mapSessionRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    user_id: row.user_id,
    title: row.title ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapMessageRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    session_id: row.session_id,
    role: row.role,
    content: row.content,
    created_at: row.created_at,
  };
}

export async function createSession(db, { userId }) {
  if (!db) {
    throw new Error("Database not configured");
  }

  const id = crypto.randomUUID();

  await db.prepare("INSERT INTO chat_sessions (id, user_id) VALUES (?, ?)").bind(id, userId).run();

  return getSessionForUser(db, id, userId);
}

export async function listSessionsForUser(db, userId) {
  if (!db) {
    throw new Error("Database not configured");
  }

  const results = await db
    .prepare(
      "SELECT id, user_id, title, created_at, updated_at FROM chat_sessions WHERE user_id = ? ORDER BY updated_at DESC"
    )
    .bind(userId)
    .all();

  return (results.results || []).map(mapSessionRow);
}

// Ownership is enforced in the query itself (user_id = ?), not checked
// afterwards -- callers get null both when the session doesn't exist and
// when it belongs to someone else, so a 404 never leaks which case it was.
export async function getSessionForUser(db, id, userId) {
  if (!db) {
    throw new Error("Database not configured");
  }

  const row = await db
    .prepare("SELECT id, user_id, title, created_at, updated_at FROM chat_sessions WHERE id = ? AND user_id = ?")
    .bind(id, userId)
    .first();

  return mapSessionRow(row);
}

// Full history, oldest first -- used by GET /v1/sessions/:id. Persisted
// messages are never dropped; only the context sent to the model is windowed
// (see listRecentMessages below).
export async function listMessages(db, sessionId) {
  if (!db) {
    throw new Error("Database not configured");
  }

  const results = await db
    .prepare("SELECT id, session_id, role, content, created_at FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC")
    .bind(sessionId)
    .all();

  return (results.results || []).map(mapMessageRow);
}

// Context window for AI.run(): last N messages (default 20, i.e. 10
// exchanges), oldest first. Fetched DESC + LIMIT then reversed so the query
// only ever has to scan the tail of a long session, not the whole table.
export async function listRecentMessages(db, sessionId, limit = CONTEXT_WINDOW_SIZE) {
  if (!db) {
    throw new Error("Database not configured");
  }

  const results = await db
    .prepare("SELECT id, session_id, role, content, created_at FROM chat_messages WHERE session_id = ? ORDER BY created_at DESC LIMIT ?")
    .bind(sessionId, limit)
    .all();

  return (results.results || []).map(mapMessageRow).reverse();
}

export async function addMessage(db, { sessionId, role, content }) {
  if (!db) {
    throw new Error("Database not configured");
  }

  const id = crypto.randomUUID();

  await db
    .prepare("INSERT INTO chat_messages (id, session_id, role, content) VALUES (?, ?, ?, ?)")
    .bind(id, sessionId, role, content)
    .run();

  const row = await db
    .prepare("SELECT id, session_id, role, content, created_at FROM chat_messages WHERE id = ?")
    .bind(id)
    .first();

  return mapMessageRow(row);
}

// Bumps updated_at (so GET /v1/sessions can order by recent activity) and
// fills title only if it is still null -- COALESCE keeps whatever title
// already exists, so this is safe to call after every message unconditionally.
export async function touchSession(db, id, { title } = {}) {
  if (!db) {
    throw new Error("Database not configured");
  }

  await db
    .prepare("UPDATE chat_sessions SET updated_at = CURRENT_TIMESTAMP, title = COALESCE(title, ?) WHERE id = ?")
    .bind(title ?? null, id)
    .run();
}

// Cascade to chat_messages is declared at the schema level (ON DELETE
// CASCADE, migration 0014) -- no manual cleanup needed here.
export async function deleteSession(db, id, userId) {
  if (!db) {
    throw new Error("Database not configured");
  }

  const existing = await getSessionForUser(db, id, userId);
  if (!existing) {
    return false;
  }

  await db.prepare("DELETE FROM chat_sessions WHERE id = ? AND user_id = ?").bind(id, userId).run();
  return true;
}
