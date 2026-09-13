-- Migration: 0015_add_chat_access
-- Description: Adds a chat_access ACL (role: owner/editor/viewer) to
-- chat_sessions, so the ai:chat RBAC permission on a JWT no longer implies
-- visibility into every chat session in dev-chat -- access is now decided by
-- a row in chat_access, same model as graph_access (migration 0010).
-- chat_sessions.user_id is kept as a historical "created by" metadata field,
-- but stops being the source of authorization.
--
-- Backfill: migration 0014 (already applied) created chat_sessions rows
-- without any chat_access row. Without this backfill, every session created
-- before this migration would become inaccessible to everyone once
-- authorization starts checking chat_access instead of chat_sessions.user_id
-- -- so each existing session's creator is granted an 'owner' row here.
--
-- id generation: D1 (like vanilla SQLite) supports the built-in randomblob()
-- and hex() scalar functions, so `lower(hex(randomblob(16)))` is used below
-- to generate a UUID-like id for the backfilled rows. This id only needs to
-- be unique (it is never parsed as a real UUID), so this is sufficient.
-- Created: 2026-09-13

CREATE TABLE IF NOT EXISTS chat_access (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES chat_sessions (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (session_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_access_user_id ON chat_access (user_id);

INSERT INTO chat_access (id, session_id, user_id, role)
SELECT lower(hex(randomblob(16))), id, user_id, 'owner'
FROM chat_sessions
WHERE NOT EXISTS (
  SELECT 1 FROM chat_access WHERE chat_access.session_id = chat_sessions.id
);
