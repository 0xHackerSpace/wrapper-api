-- Migration: 0022_add_agent_graph_id_snapshot_to_chat_sessions
-- Description: Adds a nullable "agent_graph_id" snapshot column to
-- chat_sessions (D1 dev-chat) -- see docs/specs/agent-graph-tool.md. Mirrors
-- the agent snapshot pattern from migration 0018: when a session is created
-- referencing an agent_id, the ai-worker copies the agent's graph_id (if
-- any) into this column at creation time, and the tool-calling loop always
-- uses this snapshot, never dev-agents again -- editing the agent's
-- graph_id later does not affect sessions already created.
--
-- No FOREIGN KEY: dev-agents and dev-graph are separate D1 databases from
-- dev-chat, and D1/SQLite does not support cross-database foreign keys --
-- same reasoning already used for the other agent_* columns on this table
-- (migrations 0018/0020).
-- Created: 2026-09-17

ALTER TABLE chat_sessions ADD COLUMN agent_graph_id TEXT;
