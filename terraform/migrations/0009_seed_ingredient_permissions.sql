-- Migration: 0009_seed_ingredient_permissions
-- Description: Add ingredient CRUD permissions and Ingredient User/Admin profiles
-- Created: 2026-09-12

INSERT INTO permissions (id, resource, action, description) VALUES
('perm-ingredient-create', 'ingredient', 'create', 'Create ingredients'),
('perm-ingredient-read', 'ingredient', 'read', 'Read ingredients'),
('perm-ingredient-update', 'ingredient', 'update', 'Update ingredients'),
('perm-ingredient-delete', 'ingredient', 'delete', 'Delete ingredients');

INSERT INTO profiles (id, name, description) VALUES
('profile-ingredient-user', 'Ingredient User', 'Read-only access to ingredients'),
('profile-ingredient-admin', 'Ingredient Admin', 'Full CRUD access to ingredients');

-- Admin gets full ingredient access, same as every other resource
INSERT INTO profile_permissions (id, profile_id, permission_id) VALUES
('pp-admin-ingredient-create', 'profile-admin', 'perm-ingredient-create'),
('pp-admin-ingredient-read', 'profile-admin', 'perm-ingredient-read'),
('pp-admin-ingredient-update', 'profile-admin', 'perm-ingredient-update'),
('pp-admin-ingredient-delete', 'profile-admin', 'perm-ingredient-delete');

-- Ingredient User profile: read-only, mirrors the base User profile's read-only
-- posture on rag/graph (api:access is included because api-worker currently
-- gates all ingredient routes on that permission, not the granular ones below)
INSERT INTO profile_permissions (id, profile_id, permission_id) VALUES
('pp-ingredient-user-auth-login', 'profile-ingredient-user', 'perm-auth-login'),
('pp-ingredient-user-auth-logout', 'profile-ingredient-user', 'perm-auth-logout'),
('pp-ingredient-user-api-access', 'profile-ingredient-user', 'perm-api-access'),
('pp-ingredient-user-ingredient-read', 'profile-ingredient-user', 'perm-ingredient-read');

-- Ingredient Admin profile: full CRUD
INSERT INTO profile_permissions (id, profile_id, permission_id) VALUES
('pp-ingredient-admin-auth-login', 'profile-ingredient-admin', 'perm-auth-login'),
('pp-ingredient-admin-auth-logout', 'profile-ingredient-admin', 'perm-auth-logout'),
('pp-ingredient-admin-api-access', 'profile-ingredient-admin', 'perm-api-access'),
('pp-ingredient-admin-ingredient-create', 'profile-ingredient-admin', 'perm-ingredient-create'),
('pp-ingredient-admin-ingredient-read', 'profile-ingredient-admin', 'perm-ingredient-read'),
('pp-ingredient-admin-ingredient-update', 'profile-ingredient-admin', 'perm-ingredient-update'),
('pp-ingredient-admin-ingredient-delete', 'profile-ingredient-admin', 'perm-ingredient-delete');
