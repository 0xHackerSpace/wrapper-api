-- Migration: 0008_seed_graph_permissions
-- Description: Add graph resource permissions, a Graph User profile, and extend Admin/User with graph access
-- Created: 2026-09-12

INSERT INTO permissions (id, resource, action, description) VALUES
('perm-graph-read', 'graph', 'read', 'Read graph nodes and relations'),
('perm-graph-write', 'graph', 'write', 'Create graph nodes and edges');

INSERT INTO profiles (id, name, description) VALUES
('profile-graph-user', 'Graph User', 'User with graph read/write access');

-- Admin gets full graph access
INSERT INTO profile_permissions (id, profile_id, permission_id) VALUES
('pp-admin-graph-read', 'profile-admin', 'perm-graph-read'),
('pp-admin-graph-write', 'profile-admin', 'perm-graph-write');

-- Regular users get read-only graph access, mirroring their read-only rag:query access
INSERT INTO profile_permissions (id, profile_id, permission_id) VALUES
('pp-user-graph-read', 'profile-user', 'perm-graph-read');

-- Graph User profile: full graph access
INSERT INTO profile_permissions (id, profile_id, permission_id) VALUES
('pp-graph-user-auth-login', 'profile-graph-user', 'perm-auth-login'),
('pp-graph-user-auth-logout', 'profile-graph-user', 'perm-auth-logout'),
('pp-graph-user-graph-read', 'profile-graph-user', 'perm-graph-read'),
('pp-graph-user-graph-write', 'profile-graph-user', 'perm-graph-write');
