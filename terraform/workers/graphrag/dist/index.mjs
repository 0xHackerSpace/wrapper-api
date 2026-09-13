// terraform/workers/graphrag/src/lib/response.mjs
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
function error(message, status = 400) {
  return json({ error: { message, type: "invalid_request_error" } }, status);
}
function badRequest(message) {
  return error(message, 400);
}
function notFound(message = "Not found") {
  return error(message, 404);
}
function internalError(message) {
  return error(message, 500);
}

// terraform/workers/graphrag/src/lib/jwt.mjs
var encoder = new TextEncoder();
var decoder = new TextDecoder();
async function verifyToken(token, secret) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [headerEncoded, payloadEncoded, signatureEncoded] = parts;
    const message = `${headerEncoded}.${payloadEncoded}`;
    const expectedSignature = await sign(message, secret);
    if (signatureEncoded !== expectedSignature) return null;
    const payload = JSON.parse(base64urlDecode(payloadEncoded));
    const now = Math.floor(Date.now() / 1e3);
    if (payload.exp && payload.exp < now) return null;
    return payload;
  } catch {
    return null;
  }
}
async function sign(message, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return base64url(String.fromCharCode(...new Uint8Array(signature)));
}
function base64url(str) {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
function base64urlDecode(str) {
  str += "===".slice((str.length + 3) % 4);
  return decoder.decode(
    Uint8Array.from(
      atob(str.replace(/-/g, "+").replace(/_/g, "/")),
      (c) => c.charCodeAt(0)
    )
  );
}

// terraform/workers/graphrag/src/lib/auth.mjs
var AuthError = class extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
};
async function extractToken(request) {
  const authHeader = request.headers.get("authorization");
  if (!authHeader) {
    return null;
  }
  if (!authHeader.startsWith("Bearer ")) {
    throw new AuthError(401, "Invalid authorization header format");
  }
  return authHeader.slice(7);
}
async function requireAuth(request, env) {
  if (!env.JWT_SECRET) {
    throw new AuthError(500, "JWT_SECRET not configured");
  }
  const token = await extractToken(request);
  if (!token) {
    throw new AuthError(401, "Missing authorization token");
  }
  const payload = await verifyToken(token, env.JWT_SECRET);
  if (!payload) {
    throw new AuthError(401, "Invalid or expired token");
  }
  return payload;
}
async function requirePermission(request, env, permission) {
  const payload = await requireAuth(request, env);
  if (!Array.isArray(payload.permissions) || !payload.permissions.includes(permission)) {
    throw new AuthError(403, `Missing required permission: ${permission}`);
  }
  return payload;
}

// terraform/workers/graphrag/src/lib/entity-extraction.mjs
var EXTRACTION_PROMPT = [
  "Extract candidate entities mentioned or implied in the question, as strict JSON:",
  '{"entities":[{"type":"...","label":"..."}]}.',
  "Types should be short nouns (e.g. ingredient, person, concept). No prose, JSON only.",
  "If no entities are identifiable, return an empty entities array."
].join(" ");
function emptyResult() {
  return { entities: [] };
}
function isValidEntity(entity) {
  return entity !== null && typeof entity === "object" && typeof entity.type === "string" && entity.type.trim().length > 0 && typeof entity.label === "string" && entity.label.trim().length > 0;
}
function extractContent(chatResult) {
  return chatResult?.choices?.[0]?.message?.content;
}
function parseEntitiesJson(chatResult) {
  const raw = extractContent(chatResult);
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return emptyResult();
  }
  try {
    const jsonBlock = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonBlock ? jsonBlock[0] : raw);
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.entities)) {
      console.error("graphrag entity extraction: unexpected JSON shape from AI_WORKER.chat()", parsed);
      return emptyResult();
    }
    return { entities: parsed.entities.filter(isValidEntity) };
  } catch (error2) {
    console.error("graphrag entity extraction: failed to parse AI_WORKER.chat() output as JSON", error2);
    return emptyResult();
  }
}
async function extractEntitiesFromQuestion(aiWorkerBinding, question) {
  if (!aiWorkerBinding) {
    console.error("graphrag entity extraction: AI_WORKER binding not configured");
    return emptyResult();
  }
  try {
    const result = await aiWorkerBinding.chat(
      [
        { role: "system", content: EXTRACTION_PROMPT },
        { role: "user", content: question }
      ],
      { temperature: 0 }
    );
    return parseEntitiesJson(result);
  } catch (error2) {
    console.error("graphrag entity extraction: AI_WORKER.chat() call failed", error2);
    return emptyResult();
  }
}

// terraform/workers/graphrag/src/index.mjs
var SERVICE = "graphrag";
var MAX_QUESTION_LENGTH = 2e3;
var DEFAULT_GRAPH_ID = "rag-documents";
var DEFAULT_MAX_DEPTH = 2;
var HYBRID_SYSTEM_PROMPT = [
  "You answer questions by combining two sources of context: a vector-search-based",
  "summary and structured relations from a knowledge graph. Prefer the graph context",
  "for factual relationships between entities, and the vector context for prose/detail.",
  "Say plainly when neither source has enough information to answer."
].join(" ");
var ValidationError = class extends Error {
};
var index_default = {
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
    } catch (error2) {
      if (error2 instanceof AuthError) {
        return json({ error: { message: error2.message, type: "invalid_request_error" } }, error2.status);
      }
      if (error2 instanceof ValidationError) {
        return badRequest(error2.message);
      }
      console.error("graphrag:", error2);
      return internalError(error2.message);
    }
  }
};
function handleHealth(env) {
  return json({
    service: SERVICE,
    status: "ok",
    environment: env.ENVIRONMENT ?? "unknown",
    bindings: {
      rag: Boolean(env.RAG_WORKER),
      graph: Boolean(env.GRAPH_WORKER),
      ai: Boolean(env.AI_WORKER)
    }
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
function formatGraphContext(graphContext) {
  if (graphContext.length === 0) {
    return "No related entities were found in the knowledge graph.";
  }
  return graphContext.map(({ entity, paths }) => {
    if (!Array.isArray(paths) || paths.length === 0) {
      return `${entity.type}:${entity.label} has no known relations within maxDepth.`;
    }
    const relations = paths.map((hop) => {
      const lastHop = Array.isArray(hop.path) ? hop.path[hop.path.length - 1] : void 0;
      const relationLabel = lastHop?.relation ?? "related_to";
      const neighborLabel = hop.node?.label ?? hop.node?.id ?? "unknown";
      return `${entity.label} -[${relationLabel}]-> ${neighborLabel} (distance ${hop.distance})`;
    });
    return relations.join("; ");
  }).join("\n");
}
function buildHybridPrompt(question, ragResult, graphContext) {
  const vectorContext = typeof ragResult?.answer === "string" && ragResult.answer.length > 0 ? ragResult.answer : "No vector-search context is available.";
  return [
    { role: "system", content: HYBRID_SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        `Question: ${question}`,
        "",
        `Vector-search context:
${vectorContext}`,
        "",
        `Knowledge graph context:
${formatGraphContext(graphContext)}`
      ].join("\n")
    }
  ];
}
function extractAnswer(completion) {
  return completion?.choices?.[0]?.message?.content ?? "";
}
async function lookupGraphContext(env, graphId, actorSub, maxDepth, candidate) {
  let node;
  try {
    node = await env.GRAPH_WORKER.findNodeByLabel(graphId, actorSub, candidate.type, candidate.label);
  } catch (error2) {
    console.error("graphrag: findNodeByLabel failed, degrading gracefully", error2);
    return null;
  }
  if (!node) {
    return null;
  }
  try {
    const paths = await env.GRAPH_WORKER.findPaths(graphId, actorSub, node.id, { maxDepth });
    return { entity: node, paths };
  } catch (error2) {
    console.error("graphrag: findPaths failed, degrading gracefully", error2);
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
    graphContext
  });
}
export {
  ValidationError,
  index_default as default
};
