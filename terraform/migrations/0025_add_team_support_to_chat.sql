-- Migration: 0025_add_team_support_to_chat
-- Description: Adds nullable columns to chat_sessions and chat_messages (D1
-- dev-chat) for the multi-agent orchestration feature -- see
-- docs/specs/agent-teams.md.
--
-- chat_sessions.team_id: a session may reference a team instead of a single
-- agent (mutually exclusive with agent_id, validated at the application
-- layer). Unlike agent_id (which snapshots the agent's config at creation
-- time -- migration 0018), team_id is a *live* reference: the session always
-- runs with the team's current config, no snapshot columns.
--
-- chat_messages.agent_id: marks which team member produced a given message
-- when it comes from a team orchestration (null for single-agent or
-- agent-less sessions).
--
-- No FOREIGN KEY on either column: dev-agents is a separate D1 database from
-- dev-chat, and D1/SQLite does not support cross-database foreign keys --
-- same reasoning already used for chat_sessions.agent_id and related columns
-- (migrations 0018/0020/0022).
-- Created: 2026-09-17

ALTER TABLE chat_sessions ADD COLUMN team_id TEXT;
ALTER TABLE chat_messages ADD COLUMN agent_id TEXT;
