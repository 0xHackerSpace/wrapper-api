// graphrag-worker: hybrid Q&A that combines vector search (rag-worker) with
// structural context from the knowledge graph (graph-worker), generating the
// final answer through ai-worker. HTTP-only -- unlike ai/graph/rag, nothing
// calls this worker via a Service Binding, so it stays a plain fetch handler
// rather than a WorkerEntrypoint (see docs/decisions/0015).
import { json, badRequest, notFound, internalError } from "./lib/response.mjs";
import { requirePermission, AuthError } from "./lib/auth.mjs";
import { extractEntitiesFromQuestion } from "./lib/entity-extraction.mjs";

const SERVICE = "graphrag";
const MAX_QUESTION_LENGTH = 2000;
const DEFAULT_GRAPH_ID = "rag-documents";
const DEFAULT_MAX_DEPTH = 2;

const HYBRID_SYSTEM_PROMPT = [
  "You answer questions by combining two sources of context: a vector-search-based",
  "summary and structured relations from a knowledge graph. Prefer the graph context",
  "for factual relationships between entities, and the vector context for prose/detail.",
  "Say plainly when neither source has enough information to answer.",
].join(" ");

export class ValidationError extends Error {}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);

    try {
      if (request.method === "GET" && pathname === "/health") {
        return handleHealth(env);
      }

      if (request.method === "POST" && pathname === "/v1/graphrag/query") {
        return await handleQuery(request, env);
      }

      return notFound("Endpoint not found");
    } catch (error) {
      if (error instanceof AuthError) {
        return json({ error: { message: error.message, type: "invalid_request_error" } }, error.status);
      }
      if (error instanceof ValidationError) {
        return badRequest(error.message);
      }
      console.error("graphrag:", error);
      return internalError(error.message);
    }
  },
};

function handleHealth(env) {
  return json({
    service: SERVICE,
    status: "ok",
    environment: env.ENVIRONMENT ?? "unknown",
    bindings: {
      rag: Boolean(env.RAG_WORKER),
      graph: Boolean(env.GRAPH_WORKER),
      ai: Boolean(env.AI_WORKER),
    },
  });
}

function requireBindings(env) {
  for (const name of ["RAG_WORKER", "GRAPH_WORKER", "AI_WORKER"]) {
    if (!env[name]) {
      throw new Error(`missing binding ${name}`);
    }
  }
}

function normalizeGraphId(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : DEFAULT_GRAPH_ID;
}

function normalizeMaxDepth(value) {
  return Number.isFinite(value) ? value : DEFAULT_MAX_DEPTH;
}

// Structural context from the graph, one entry per candidate entity that was
// actually found: { entity: <graph node>, paths: <findPaths() reachable-mode rows> }.
function formatGraphContext(graphContext) {
  if (graphContext.length === 0) {
    return "No related entities were found in the knowledge graph.";
  }

  return graphContext
    .map(({ entity, paths }) => {
      if (!Array.isArray(paths) || paths.length === 0) {
        return `${entity.type}:${entity.label} has no known relations within maxDepth.`;
      }

      const relations = paths.map((hop) => {
        const lastHop = Array.isArray(hop.path) ? hop.path[hop.path.length - 1] : undefined;
        const relationLabel = lastHop?.relation ?? "related_to";
        const neighborLabel = hop.node?.label ?? hop.node?.id ?? "unknown";
        return `${entity.label} -[${relationLabel}]-> ${neighborLabel} (distance ${hop.distance})`;
      });

      return relations.join("; ");
    })
    .join("\n");
}

function buildHybridPrompt(question, ragResult, graphContext) {
  const vectorContext =
    typeof ragResult?.answer === "string" && ragResult.answer.length > 0
      ? ragResult.answer
      : "No vector-search context is available.";

  return [
    { role: "system", content: HYBRID_SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        `Question: ${question}`,
        "",
        `Vector-search context:\n${vectorContext}`,
        "",
        `Knowledge graph context:\n${formatGraphContext(graphContext)}`,
      ].join("\n"),
    },
  ];
}

function extractAnswer(completion) {
  return completion?.choices?.[0]?.message?.content ?? "";
}

// Best-effort structural lookup for one candidate entity: missing node, no
// graph access, or any other GRAPH_WORKER RPC failure all degrade to "skip
// this entity" rather than failing the whole question (per the roadmap: only
// RAG_WORKER.query()/AI_WORKER.chat() are essential and allowed to fail the
// request).
async function lookupGraphContext(env, graphId, actorSub, maxDepth, candidate) {
  let node;
  try {
    node = await env.GRAPH_WORKER.findNodeByLabel(graphId, actorSub, candidate.type, candidate.label);
  } catch (error) {
    console.error("graphrag: findNodeByLabel failed, degrading gracefully", error);
    return null;
  }
  if (!node) {
    return null;
  }

  try {
    const paths = await env.GRAPH_WORKER.findPaths(graphId, actorSub, node.id, { maxDepth });
    return { entity: node, paths };
  } catch (error) {
    console.error("graphrag: findPaths failed, degrading gracefully", error);
    return null;
  }
}

async function handleQuery(request, env) {
  const payload = await requirePermission(request, env, "graphrag:query");
  requireBindings(env);

  const body = await request.json();
  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (question.length === 0) {
    throw new ValidationError("field 'question' is required and must be a non-empty string");
  }
  if (question.length > MAX_QUESTION_LENGTH) {
    throw new ValidationError(`field 'question' must be at most ${MAX_QUESTION_LENGTH} characters`);
  }

  const graphId = normalizeGraphId(body.graphId);
  const maxDepth = normalizeMaxDepth(body.maxDepth);

  // Essential calls: a failure here must surface as an error response, not degrade silently.
  const ragResult = await env.RAG_WORKER.query(question, { topK: body.topK });

  const { entities } = await extractEntitiesFromQuestion(env.AI_WORKER, question);

  const graphContext = [];
  for (const candidate of entities) {
    const found = await lookupGraphContext(env, graphId, payload.sub, maxDepth, candidate);
    if (found) {
      graphContext.push(found);
    }
  }

  const finalMessages = buildHybridPrompt(question, ragResult, graphContext);
  const completion = await env.AI_WORKER.chat(finalMessages);

  return json({
    question,
    answer: extractAnswer(completion),
    sources: ragResult.sources ?? [],
    graphContext,
  });
}
