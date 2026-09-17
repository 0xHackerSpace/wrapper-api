// Fixed catalog of tools an agent can enable (docs/specs/agent-tool-calling.md).
// Deliberately not a D1 table: the set of tools is small and tied to the
// ai-worker's own deploy (a new tool means new code here + a new deploy), not
// user-managed data -- same reasoning the spec gives for keeping this in code.
//
// Each entry pairs the OpenAI-style `function` definition (passed verbatim to
// ai.run({ tools })) with an `execute(env, args, context)` that performs the
// actual RPC and returns a plain JS value (the caller in index.mjs is
// responsible for JSON.stringify()-ing it into the `role: "tool"` message
// content, and for catching a thrown error -- a failing tool never aborts the
// loop, see spec's "Erro de tool" section). `context` is built once per
// runToolCallingLoop() call from the session/user -- never from the model's
// own arguments (docs/specs/agent-graph-tool.md, "Contexto extra em
// execute()"); most tools ignore it, same as query_knowledge_base below.
export const TOOL_CATALOG = {
  query_knowledge_base: {
    definition: {
      type: "function",
      function: {
        name: "query_knowledge_base",
        description: "Busca informação relevante na base de conhecimento (RAG) para responder a uma pergunta.",
        parameters: {
          type: "object",
          properties: {
            question: {
              type: "string",
              description: "A pergunta a ser respondida usando a base de conhecimento.",
            },
          },
          required: ["question"],
        },
      },
    },
    // rag-worker's query() has no ACL/actorSub (single Vectorize index, no
    // multi-tenancy) -- called with an empty options object, same as
    // graphrag-worker's own use of this RPC. `context` is unused.
    async execute(env, args) {
      if (!env.RAG_WORKER) {
        throw new Error("RAG_WORKER binding not configured");
      }

      const { question } = args || {};
      const { answer, sources } = await env.RAG_WORKER.query(question, {});

      return { answer, sources };
    },
  },

  // docs/specs/agent-graph-tool.md: exact (type, label) lookup in the graph
  // the agent was configured with (agent.graph_id, snapshotted onto the
  // session at creation time). Unlike query_knowledge_base, this tool needs
  // context the model never provides: which graph, and whose access to check
  // it against -- always the real user sending the message (context.actorSub),
  // never a shared/service identity. graph-worker's findNodeByLabel RPC
  // enforces the ACL itself (requireRole(..., "viewer")) and throws
  // AuthError(403) when actorSub has no/insufficient access; that's left to
  // propagate to the try/catch already in runToolCallingLoop(), which turns
  // it into a normal `{ error }` tool result -- no special handling here.
  find_node: {
    definition: {
      type: "function",
      function: {
        name: "find_node",
        description: "Busca um node específico no grafo de conhecimento pelo tipo e rótulo exatos.",
        parameters: {
          type: "object",
          properties: {
            type: {
              type: "string",
              description: "O tipo do node (ex.: 'Ingredient', 'Recipe').",
            },
            label: {
              type: "string",
              description: "O rótulo/nome exato do node a ser encontrado.",
            },
          },
          required: ["type", "label"],
        },
      },
    },
    async execute(env, args, context) {
      if (!env.GRAPH_WORKER) {
        throw new Error("GRAPH_WORKER binding not configured");
      }
      if (!context?.graphId) {
        throw new Error("Agent has no graph_id configured");
      }

      const { type, label } = args || {};
      const node = await env.GRAPH_WORKER.findNodeByLabel(context.graphId, context.actorSub, type, label);

      return node ?? { found: false };
    },
  },
};

export function isKnownTool(name) {
  return Object.prototype.hasOwnProperty.call(TOOL_CATALOG, name);
}

// Maps agent.tools (array of names) to the array of `definition` objects
// ai.run({ tools }) expects. Unknown names are silently dropped here --
// validation that every name is known happens once, at agent creation/update
// time (agent-db.mjs's validateAgentFields), not on every message.
export function getToolDefinitions(names) {
  return (names || []).map((name) => TOOL_CATALOG[name]?.definition).filter(Boolean);
}
