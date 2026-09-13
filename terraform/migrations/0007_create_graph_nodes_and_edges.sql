-- Knowledge graph schema for the `graph` worker.
-- Apply manually with: wrangler d1 execute dev-graph --remote < terraform/migrations/0007_create_graph_nodes_and_edges.sql
--
-- D1 enables `PRAGMA foreign_keys` by default (unlike vanilla SQLite), so the
-- REFERENCES/ON DELETE CASCADE clauses below are actually enforced by the
-- database, on top of the existence checks graph-db.mjs already does before
-- inserting an edge.

CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  label TEXT NOT NULL,
  properties TEXT CHECK (properties IS NULL OR json_valid(properties)),
  source_document_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_nodes_type_label ON nodes (type, label);
CREATE INDEX IF NOT EXISTS idx_nodes_source_document_id ON nodes (source_document_id);

CREATE TABLE IF NOT EXISTS edges (
  id TEXT PRIMARY KEY,
  from_node_id TEXT NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,
  to_node_id TEXT NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,
  relation TEXT NOT NULL,
  properties TEXT CHECK (properties IS NULL OR json_valid(properties)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (from_node_id, to_node_id, relation)
);

CREATE INDEX IF NOT EXISTS idx_edges_from_node_id ON edges (from_node_id);
CREATE INDEX IF NOT EXISTS idx_edges_to_node_id ON edges (to_node_id);
