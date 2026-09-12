-- Knowledge graph schema for the `graph` worker.
-- Apply manually with: wrangler d1 execute dev-graph --remote < terraform/migrations/0007_create_graph_nodes_and_edges.sql

CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  label TEXT NOT NULL,
  properties TEXT,
  source_document_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes (type);
CREATE INDEX IF NOT EXISTS idx_nodes_source_document_id ON nodes (source_document_id);

CREATE TABLE IF NOT EXISTS edges (
  id TEXT PRIMARY KEY,
  from_node_id TEXT NOT NULL REFERENCES nodes (id),
  to_node_id TEXT NOT NULL REFERENCES nodes (id),
  relation TEXT NOT NULL,
  properties TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_edges_from_node_id ON edges (from_node_id);
CREATE INDEX IF NOT EXISTS idx_edges_to_node_id ON edges (to_node_id);
