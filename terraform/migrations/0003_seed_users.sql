-- Migration: 0003_seed_users
-- Description: Seed initial users for development
-- Created: 2026-09-11
-- Note: Use proper password hashing in production!

INSERT OR IGNORE INTO users (id, username, email, password_hash, first_name, last_name, status)
VALUES
  (
    'user-001',
    'admin',
    'admin@example.com',
    'pbkdf2:sha256:100000:90e8b3bfdfe77881bb67dc8dd11b9495:88de0621d1a49eb26165af930946be8b90e8b3bfdfe77881bb67dc8dd11b9495',
    'Admin',
    'User',
    'active'
  ),
  (
    'user-002',
    'testuser',
    'test@example.com',
    'pbkdf2:sha256:100000:90e8b3bfdfe77881bb67dc8dd11b9495:88de0621d1a49eb26165af930946be8b90e8b3bfdfe77881bb67dc8dd11b9495',
    'Test',
    'User',
    'active'
  ),
  (
    'user-003',
    'demo',
    'demo@example.com',
    'pbkdf2:sha256:100000:90e8b3bfdfe77881bb67dc8dd11b9495:88de0621d1a49eb26165af930946be8b90e8b3bfdfe77881bb67dc8dd11b9495',
    'Demo',
    'User',
    'active'
  );
