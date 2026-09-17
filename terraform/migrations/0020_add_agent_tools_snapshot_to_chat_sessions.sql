-- Migration: 0020_add_agent_tools_snapshot_to_chat_sessions
-- Description: Adds nullable "agent_tools" and "agent_max_tool_iterations"
-- snapshot columns to chat_sessions (D1 dev-chat) -- see
-- docs/specs/agent-tool-calling.md. Mirrors the agent snapshot pattern from
-- migration 0018: when a session is created referencing an agent_id, the
-- ai-worker copies the agent's tools/max_tool_iterations (if any) into these
-- columns at creation time, and POST /v1/sessions/:id/messages always uses
-- this snapshot, never dev-agents again.
--
-- `agent_max_tool_iterations` has no default here (unlike agents.
-- max_tool_iterations, which defaults to 5): NULL means "session has no
-- agent, or the agent has no tools" -- the default of 5 only applies on the
-- agent side.
--
-- No FOREIGN KEY: dev-agents is a separate D1 database from dev-chat, and
-- D1/SQLite does not support cross-database foreign keys -- same reasoning
-- already used for the other agent_* columns on this table (migration 0018).
-- Created: 2026-09-17

ALTER TABLE chat_sessions ADD COLUMN agent_tools TEXT;
ALTER TABLE chat_sessions ADD COLUMN agent_max_tool_iterations INTEGER;
