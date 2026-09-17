-- Migration: 0018_add_agent_snapshot_to_chat_sessions
-- Description: Adds nullable "agent snapshot" columns to chat_sessions (D1
-- dev-chat) -- see docs/specs/agent-registration.md. When a session is
-- created referencing an agent_id (D1 dev-agents), the ai-worker copies the
-- agent's system_prompt/model/temperature/max_tokens/top_p into these
-- columns at creation time. POST /v1/sessions/:id/messages always uses this
-- snapshot, never dev-agents again -- editing or deleting the agent later
-- does not affect sessions already created.
--
-- No FOREIGN KEY on agent_id: dev-agents is a separate D1 database from
-- dev-chat, and D1/SQLite does not support cross-database foreign keys. This
-- is intentional (see spec) -- referential integrity for agent_id is an
-- application-level concern, not enforced by the database.
-- Created: 2026-09-17

ALTER TABLE chat_sessions ADD COLUMN agent_id TEXT;
ALTER TABLE chat_sessions ADD COLUMN agent_system_prompt TEXT;
ALTER TABLE chat_sessions ADD COLUMN agent_model TEXT;
ALTER TABLE chat_sessions ADD COLUMN agent_temperature REAL;
ALTER TABLE chat_sessions ADD COLUMN agent_max_tokens INTEGER;
ALTER TABLE chat_sessions ADD COLUMN agent_top_p REAL;
