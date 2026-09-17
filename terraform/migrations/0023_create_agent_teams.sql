-- Migration: 0023_create_agent_teams
-- Description: Creates the `agent_teams`, `team_members` and `team_access`
-- tables (D1 dev-agents) for the multi-agent orchestration feature -- see
-- docs/specs/agent-teams.md.
--
-- A team groups multiple agents and coordinates them via one of 3
-- orchestration modes (`pipeline`, `debate`, `orchestrator`). Unlike the
-- agent snapshot copied into chat_sessions (migration 0018), team_members is
-- a *live* reference to agents(id): a team always runs with its members'
-- current config, so it gets a real FK (same D1 as agents) instead of a
-- snapshot.
--
-- team_access follows the same ACL model already used for agent_access
-- (migration 0016), chat_access (migration 0015) and graph_access
-- (migration 0010): role-based (owner/editor/viewer), one row per
-- (team, user), invariant of >=1 owner enforced at the application layer.
--
-- D1 enables `PRAGMA foreign_keys` by default (unlike vanilla SQLite), so the
-- REFERENCES/ON DELETE CASCADE clauses below are actually enforced by the
-- database.
-- Created: 2026-09-17

CREATE TABLE IF NOT EXISTS agent_teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  orchestration_mode TEXT NOT NULL CHECK (orchestration_mode IN ('pipeline', 'debate', 'orchestrator')),
  lead_agent_id TEXT REFERENCES agents (id),
  rounds INTEGER,
  termination_strategy TEXT CHECK (termination_strategy IN ('fixed_rounds', 'moderator')),
  max_orchestrator_steps INTEGER,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS team_members (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES agent_teams (id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents (id),
  order_index INTEGER NOT NULL,
  UNIQUE (team_id, agent_id)
);

CREATE TABLE IF NOT EXISTS team_access (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES agent_teams (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (team_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_team_access_user_id ON team_access (user_id);
