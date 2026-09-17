-- Migration: 0019_add_tools_to_agents
-- Description: Adds nullable "tools" and "max_tool_iterations" columns to
-- agents (D1 dev-agents) -- see docs/specs/agent-tool-calling.md. `tools` is
-- a JSON-serialized array of tool names (e.g. ["query_knowledge_base"])
-- validated against a fixed catalog of known tools in the ai-worker code
-- (not a table -- the set of tools is small and part of the ai-worker
-- deploy, not user data). `max_tool_iterations` caps the number of
-- model->tool->model cycles before a final answer is forced.
-- Created: 2026-09-17

ALTER TABLE agents ADD COLUMN tools TEXT;
ALTER TABLE agents ADD COLUMN max_tool_iterations INTEGER NOT NULL DEFAULT 5;
