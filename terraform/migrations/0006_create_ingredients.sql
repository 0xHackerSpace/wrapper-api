-- Migration: 0006_create_ingredients
-- Description: Create ingredients table
-- Created: 2026-09-11

CREATE TABLE IF NOT EXISTS ingredients (
  id TEXT PRIMARY KEY,
  nome TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  reference TEXT,
  url TEXT,
  permissions TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_ingredients_slug ON ingredients(slug);
CREATE INDEX idx_ingredients_type ON ingredients(type);
