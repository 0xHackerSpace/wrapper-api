-- Migration: 0011_seed_ai_permissions
-- Description: Add ai:chat permission, assigned to Admin only
-- Created: 2026-09-12

INSERT INTO permissions (id, resource, action, description) VALUES
('perm-ai-chat', 'ai', 'chat', 'Use AI chat completions');

-- Deliberately admin-only: no intermediate profile (not even the base User)
-- receives ai:chat. A single-action permission like this doesn't warrant a
-- dedicated profile the way graph:*/ingredient:* do.
INSERT INTO profile_permissions (id, profile_id, permission_id) VALUES
('pp-admin-ai-chat', 'profile-admin', 'perm-ai-chat');
