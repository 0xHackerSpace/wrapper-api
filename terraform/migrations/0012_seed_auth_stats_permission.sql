-- Migration: 0012_seed_auth_stats_permission
-- Description: Add auth:stats permission, assigned to Admin only
-- Created: 2026-09-12

INSERT INTO permissions (id, resource, action, description) VALUES
('perm-auth-stats', 'auth', 'stats', 'Read aggregate user statistics');

-- Deliberately admin-only: user:read is already held by the base User
-- profile, which would make it too broad for aggregate admin-facing stats.
INSERT INTO profile_permissions (id, profile_id, permission_id) VALUES
('pp-admin-auth-stats', 'profile-admin', 'perm-auth-stats');
