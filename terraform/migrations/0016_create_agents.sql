-- Migration: 0016_create_agents
-- Description: Creates the `agents` and `agent_access` tables (D1 dev-agents)
-- for the agent registration feature -- see docs/specs/agent-registration.md.
-- An agent is a reusable, named AI configuration (system prompt + generation
-- parameters) that a user registers once and can later reference when
-- creating a chat session (the session then snapshots these fields -- see
-- migration 0018 in dev-chat).
--
-- agent_access follows the same ACL model already used for chat_access
-- (migration 0015) and graph_access (migration 0010): role-based
-- (owner/editor/viewer), one row per (agent, user), invariant of >=1 owner
-- enforced at the application layer.
--
-- D1 enables `PRAGMA foreign_keys` by default (unlike vanilla SQLite), so the
-- REFERENCES/ON DELETE CASCADE clause below is actually enforced by the
-- database.
-- Created: 2026-09-17

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  system_prompt TEXT NOT NULL,
  model TEXT NOT NULL,
  temperature REAL,
  max_tokens INTEGER,
  top_p REAL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS agent_access (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (agent_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_access_user_id ON agent_access (user_id);
