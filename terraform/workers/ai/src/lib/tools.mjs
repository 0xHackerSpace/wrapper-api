// Fixed catalog of tools an agent can enable (docs/specs/agent-tool-calling.md).
// Deliberately not a D1 table: the set of tools is small and tied to the
// ai-worker's own deploy (a new tool means new code here + a new deploy), not
// user-managed data -- same reasoning the spec gives for keeping this in code.
//
// Each entry pairs the OpenAI-style `function` definition (passed verbatim to
// ai.run({ tools })) with an `execute(env, args)` that performs the actual RPC
// and returns a plain JS value (the caller in index.mjs is responsible for
// JSON.stringify()-ing it into the `role: "tool"` message content, and for
// catching a thrown error -- a failing tool never aborts the loop, see spec's
// "Erro de tool" section).
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
    // graphrag-worker's own use of this RPC.
    async execute(env, args) {
      if (!env.RAG_WORKER) {
        throw new Error("RAG_WORKER binding not configured");
      }

      const { question } = args || {};
      const { answer, sources } = await env.RAG_WORKER.query(question, {});

      return { answer, sources };
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
