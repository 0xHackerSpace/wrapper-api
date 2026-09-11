-- Migration: 0005_seed_roles_and_permissions
-- Description: Seed initial profiles and permissions
-- Created: 2026-09-11

-- Insert default permissions
INSERT INTO permissions (id, resource, action, description) VALUES
('perm-user-create', 'user', 'create', 'Create new users'),
('perm-user-read', 'user', 'read', 'Read user information'),
('perm-user-update', 'user', 'update', 'Update user information'),
('perm-user-delete', 'user', 'delete', 'Delete users'),
('perm-profile-create', 'profile', 'create', 'Create new profiles'),
('perm-profile-read', 'profile', 'read', 'Read profile information'),
('perm-profile-update', 'profile', 'update', 'Update profile information'),
('perm-profile-delete', 'profile', 'delete', 'Delete profiles'),
('perm-permission-create', 'permission', 'create', 'Create new permissions'),
('perm-permission-read', 'permission', 'read', 'Read permission information'),
('perm-permission-update', 'permission', 'update', 'Update permissions'),
('perm-permission-delete', 'permission', 'delete', 'Delete permissions'),
('perm-auth-login', 'auth', 'login', 'Login to application'),
('perm-auth-logout', 'auth', 'logout', 'Logout from application'),
('perm-api-access', 'api', 'access', 'Access API endpoints'),
('perm-rag-ingest', 'rag', 'ingest', 'Ingest data into RAG'),
('perm-rag-query', 'rag', 'query', 'Query RAG data');

-- Insert default profiles
INSERT INTO profiles (id, name, description) VALUES
('profile-admin', 'Admin', 'Administrator with full access'),
('profile-user', 'User', 'Regular user with basic access'),
('profile-guest', 'Guest', 'Guest user with limited access'),
('profile-rag-user', 'RAG User', 'User with RAG access'),
('profile-api-user', 'API User', 'User with API access');

-- Assign all permissions to admin profile
INSERT INTO profile_permissions (id, profile_id, permission_id) VALUES
('pp-admin-user-create', 'profile-admin', 'perm-user-create'),
('pp-admin-user-read', 'profile-admin', 'perm-user-read'),
('pp-admin-user-update', 'profile-admin', 'perm-user-update'),
('pp-admin-user-delete', 'profile-admin', 'perm-user-delete'),
('pp-admin-profile-create', 'profile-admin', 'perm-profile-create'),
('pp-admin-profile-read', 'profile-admin', 'perm-profile-read'),
('pp-admin-profile-update', 'profile-admin', 'perm-profile-update'),
('pp-admin-profile-delete', 'profile-admin', 'perm-profile-delete'),
('pp-admin-permission-create', 'profile-admin', 'perm-permission-create'),
('pp-admin-permission-read', 'profile-admin', 'perm-permission-read'),
('pp-admin-permission-update', 'profile-admin', 'perm-permission-update'),
('pp-admin-permission-delete', 'profile-admin', 'perm-permission-delete'),
('pp-admin-auth-login', 'profile-admin', 'perm-auth-login'),
('pp-admin-auth-logout', 'profile-admin', 'perm-auth-logout'),
('pp-admin-api-access', 'profile-admin', 'perm-api-access'),
('pp-admin-rag-ingest', 'profile-admin', 'perm-rag-ingest'),
('pp-admin-rag-query', 'profile-admin', 'perm-rag-query');

-- Assign basic permissions to user profile
INSERT INTO profile_permissions (id, profile_id, permission_id) VALUES
('pp-user-user-read', 'profile-user', 'perm-user-read'),
('pp-user-auth-login', 'profile-user', 'perm-auth-login'),
('pp-user-auth-logout', 'profile-user', 'perm-auth-logout'),
('pp-user-api-access', 'profile-user', 'perm-api-access'),
('pp-user-rag-query', 'profile-user', 'perm-rag-query');

-- Assign limited permissions to guest profile
INSERT INTO profile_permissions (id, profile_id, permission_id) VALUES
('pp-guest-auth-login', 'profile-guest', 'perm-auth-login'),
('pp-guest-rag-query', 'profile-guest', 'perm-rag-query');

-- Assign RAG permissions to rag-user profile
INSERT INTO profile_permissions (id, profile_id, permission_id) VALUES
('pp-rag-user-auth-login', 'profile-rag-user', 'perm-auth-login'),
('pp-rag-user-auth-logout', 'profile-rag-user', 'perm-auth-logout'),
('pp-rag-user-rag-ingest', 'profile-rag-user', 'perm-rag-ingest'),
('pp-rag-user-rag-query', 'profile-rag-user', 'perm-rag-query');

-- Assign API permissions to api-user profile
INSERT INTO profile_permissions (id, profile_id, permission_id) VALUES
('pp-api-user-auth-login', 'profile-api-user', 'perm-auth-login'),
('pp-api-user-auth-logout', 'profile-api-user', 'perm-auth-logout'),
('pp-api-user-api-access', 'profile-api-user', 'perm-api-access');

-- Assign admin profile to existing admin user
INSERT INTO user_profiles (id, user_id, profile_id)
SELECT 'up-admin-admin', id, 'profile-admin' FROM users WHERE username = 'admin';

-- Assign user profile to testuser
INSERT INTO user_profiles (id, user_id, profile_id)
SELECT 'up-admin-testuser', id, 'profile-user' FROM users WHERE username = 'testuser';

-- Assign user profile to demo user
INSERT INTO user_profiles (id, user_id, profile_id)
SELECT 'up-admin-demo', id, 'profile-user' FROM users WHERE username = 'demo';
