-- Migration: 0013_add_graphrag_permission
-- Description: Add graphrag:query permission, assigned to Admin and RAG User
-- Created: 2026-09-12

INSERT INTO permissions (id, resource, action, description) VALUES
('perm-graphrag-query', 'graphrag', 'query', 'Query the hybrid GraphRAG (RAG + graph traversal) endpoint');

-- Admin gets full access, same as every other resource
INSERT INTO profile_permissions (id, profile_id, permission_id) VALUES
('pp-admin-graphrag-query', 'profile-admin', 'perm-graphrag-query');

-- RAG User profile: graphrag is a natural extension of the RAG use case, so
-- users who already query RAG directly (perm-rag-query) get the hybrid
-- endpoint too.
INSERT INTO profile_permissions (id, profile_id, permission_id) VALUES
('pp-rag-user-graphrag-query', 'profile-rag-user', 'perm-graphrag-query');
