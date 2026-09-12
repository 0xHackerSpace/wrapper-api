-- Migration: 0010_add_graph_containers_and_access
-- Description: Adds isolated "graphs" as containers for nodes/edges plus a
-- graph_access ACL (role: owner/editor/viewer), so the graph:read/graph:write
-- RBAC permission on a JWT no longer implies visibility into every node/edge
-- in dev-graph. Migration 0007 (already applied) created nodes/edges without
-- a graph_id; existing rows are backfilled into a "default" graph here so
-- nothing already in the database is lost or orphaned.
--
-- IMPORTANT, manual follow-up required: this migration does NOT grant anyone
-- graph_access to the "default" graph, because it has no way to know which
-- user(s) should own pre-existing data (nodes/edges were never attributed to
-- a specific user before this model existed). Without a graph_access row,
-- NO ONE can read/write the "default" graph through the API after this
-- migration, even though the rows still exist in the database. Grant access
-- immediately after applying, e.g.:
--
--   wrangler d1 execute dev-graph --remote --command \
--     "INSERT INTO graph_access (id, graph_id, user_id, role) VALUES ('<uuid>', 'default', '<your JWT sub>', 'owner')"
--
-- graph_id is nullable at the schema level (SQLite cannot add a NOT NULL
-- column without a constant default), but graph-db.mjs always supplies it on
-- every insert -- treat it as required at the application layer.
-- Created: 2026-09-12

CREATE TABLE IF NOT EXISTS graphs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS graph_access (
  id TEXT PRIMARY KEY,
  graph_id TEXT NOT NULL REFERENCES graphs (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (graph_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_graph_access_user_id ON graph_access (user_id);

INSERT INTO graphs (id, name, created_by)
SELECT 'default', 'Default', 'system'
WHERE NOT EXISTS (SELECT 1 FROM graphs WHERE id = 'default');

ALTER TABLE nodes ADD COLUMN graph_id TEXT REFERENCES graphs (id) ON DELETE CASCADE;
UPDATE nodes SET graph_id = 'default' WHERE graph_id IS NULL;

DROP INDEX IF EXISTS idx_nodes_type_label;
CREATE INDEX IF NOT EXISTS idx_nodes_graph_type_label ON nodes (graph_id, type, label);
