-- Migration: 0026_seed_huggingface_permission
-- Description: Add huggingface:use permission, assigned to profile-admin
-- (paridade inicial -- see docs/specs/huggingface-worker.md). A single
-- permission covers all 19 Inference Providers tasks exposed by
-- huggingface-worker (chat completion, feature extraction, text-to-image,
-- etc.) -- unlike ai:chat/ai:agents/ai:teams, these routes are all the same
-- conceptual capability: "use the HF inference API".
-- Created: 2026-09-28

INSERT INTO permissions (id, resource, action, description) VALUES
('perm-huggingface-use', 'huggingface', 'use', 'Use Hugging Face Inference Providers API (all tasks)');

-- Same initial rollout as ai:agents/ai:teams (migrations 0017/0024): admin only.
INSERT INTO profile_permissions (id, profile_id, permission_id) VALUES
('pp-admin-huggingface-use', 'profile-admin', 'perm-huggingface-use');
