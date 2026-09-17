-- Migration: 0024_seed_team_permissions
-- Description: Add ai:teams permission, assigned to the same roles that
-- currently have ai:agents (paridade inicial -- see
-- docs/specs/agent-teams.md). Deliberately a separate permission from
-- ai:agents: "montar equipes de agents" is an administrative capability
-- distinct from "cadastrar um agent individual", and the two may diverge per
-- role in the future.
-- Created: 2026-09-17

INSERT INTO permissions (id, resource, action, description) VALUES
('perm-ai-teams', 'ai', 'teams', 'Manage AI agent teams (create, edit, delete, share)');

-- Same initial rollout as ai:agents (migration 0017): admin only.
INSERT INTO profile_permissions (id, profile_id, permission_id) VALUES
('pp-admin-ai-teams', 'profile-admin', 'perm-ai-teams');
