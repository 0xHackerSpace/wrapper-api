-- Migration: 0017_seed_agent_permissions
-- Description: Add ai:agents permission, assigned to the same roles that
-- currently have ai:chat (paridade inicial -- see
-- docs/specs/agent-registration.md). Deliberately a separate permission from
-- ai:chat: managing agents (create/edit/delete/share) is an
-- administrative/configuration capability distinct from just chatting, and
-- the two may diverge per role in the future.
-- Created: 2026-09-17

INSERT INTO permissions (id, resource, action, description) VALUES
('perm-ai-agents', 'ai', 'agents', 'Manage AI agents (create, edit, delete, share)');

-- Same initial rollout as ai:chat (migration 0011): admin only.
INSERT INTO profile_permissions (id, profile_id, permission_id) VALUES
('pp-admin-ai-agents', 'profile-admin', 'perm-ai-agents');
