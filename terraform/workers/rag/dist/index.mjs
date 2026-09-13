// terraform/workers/rag/index.mjs
import { WorkerEntrypoint } from "cloudflare:workers";

// terraform/workers/rag/lib/jwt.mjs
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

// terraform/workers/rag/lib/entity-extraction.mjs
var EXTRACTION_PROMPT = [
  'Extract entities and relations as strict JSON: {"entities":[{"type":"...","label":"..."}],',
  '"relations":[{"from":"<label>","to":"<label>","relation":"..."}]}.',
  "Only use labels from your own entities list. No prose, JSON only."
].join(" ");
function emptyResult() {
  return { entities: [], relations: [] };
}
function isValidEntity(entity) {
  return entity !== null && typeof entity === "object" && typeof entity.type === "string" && entity.type.trim().length > 0 && typeof entity.label === "string" && entity.label.trim().length > 0;
}
function isValidRelation(relation) {
  return relation !== null && typeof relation === "object" && typeof relation.from === "string" && relation.from.trim().length > 0 && typeof relation.to === "string" && relation.to.trim().length > 0 && typeof relation.relation === "string" && relation.relation.trim().length > 0;
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
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.entities) || !Array.isArray(parsed.relations)) {
      console.error("entity extraction: unexpected JSON shape from AI_WORKER.chat()", parsed);
      return emptyResult();
    }
    return {
      entities: parsed.entities.filter(isValidEntity),
      relations: parsed.relations.filter(isValidRelation)
    };
  } catch (error) {
    console.error("entity extraction: failed to parse AI_WORKER.chat() output as JSON", error);
    return emptyResult();
  }
}
async function extractEntities(aiWorkerBinding, text) {
  if (!aiWorkerBinding) {
    console.error("entity extraction: AI_WORKER binding not configured");
    return emptyResult();
  }
  try {
    const result = await aiWorkerBinding.chat(
      [
        { role: "system", content: EXTRACTION_PROMPT },
        { role: "user", content: text }
      ],
      { temperature: 0 }
    );
    return parseEntitiesJson(result);
  } catch (error) {
    console.error("entity extraction: AI_WORKER.chat() call failed", error);
    return emptyResult();
  }
}

// terraform/workers/rag/lib/graph-sync.mjs
function isConflictError(error) {
  return typeof error?.message === "string" && /already exists/i.test(error.message);
}
async function syncEntitiesToGraph(graphWorkerBinding, graphId, documentId2, { entities, relations }) {
  if (!graphWorkerBinding) {
    console.error("graph sync: GRAPH_WORKER binding not configured");
    return;
  }
  const nodeIds = {};
  for (const entity of entities) {
    const node = await graphWorkerBinding.upsertNode(graphId, "svc-rag-enrichment", {
      type: entity.type,
      label: entity.label,
      source_document_id: documentId2
    });
    nodeIds[entity.label] = node.id;
  }
  for (const relation of relations) {
    const fromId = nodeIds[relation.from];
    const toId = nodeIds[relation.to];
    if (!fromId || !toId) {
      continue;
    }
    try {
      await graphWorkerBinding.createEdge(graphId, "svc-rag-enrichment", {
        from_node_id: fromId,
        to_node_id: toId,
        relation: relation.relation
      });
    } catch (error) {
      if (!isConflictError(error)) {
        throw error;
      }
    }
  }
}

// terraform/workers/rag/index.mjs
var SERVICE = "rag";
var METADATA_TEXT_LIMIT = 2048;
var EMBEDDING_BATCH = 50;
var MAX_DOCUMENT_LENGTH = 512 * 1024;
var MAX_QUESTION_LENGTH = 2e3;
var MAX_METADATA_ENTRIES = 16;
var ENTITY_EXTRACTION_TEXT_LIMIT = 8e3;
var DEFAULTS = {
  chunkSize: 1200,
  chunkOverlap: 150,
  topK: 5,
  graphId: "rag-documents"
};
var SYSTEM_PROMPT = [
  "You answer questions using only the provided context.",
  "Cite nothing that is absent from the context and say when the context is insufficient."
].join(" ");
var HttpError = class extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
};
function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...init.headers
    }
  });
}
function integer(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}
function configuration(env) {
  const chunkSize = clamp(integer(env.CHUNK_SIZE, DEFAULTS.chunkSize), 200, 4e3);
  return {
    environment: env.ENVIRONMENT ?? "unknown",
    embeddingModel: env.EMBEDDING_MODEL,
    generationModel: env.GENERATION_MODEL,
    chunkSize,
    chunkOverlap: clamp(integer(env.CHUNK_OVERLAP, DEFAULTS.chunkOverlap), 0, chunkSize - 1),
    topK: clamp(integer(env.TOP_K, DEFAULTS.topK), 1, 50)
  };
}
function requireBindings(env) {
  for (const binding of ["AI", "VECTORIZE", "DOCUMENTS", "EMBEDDING_MODEL", "GENERATION_MODEL"]) {
    if (!env[binding]) {
      throw new HttpError(500, `missing binding ${binding}`);
    }
  }
}
async function authorize(request, env, permission) {
  if (!env.JWT_SECRET) {
    return;
  }
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) {
    throw new HttpError(401, "Missing or invalid authorization header");
  }
  const token = header.slice(7);
  const payload = await verifyToken(token, env.JWT_SECRET);
  if (!payload) {
    throw new HttpError(401, "Invalid or expired token");
  }
  if (permission && (!Array.isArray(payload.permissions) || !payload.permissions.includes(permission))) {
    throw new HttpError(403, `Missing required permission: ${permission}`);
  }
  return payload;
}
async function readJson(request) {
  try {
    const body = await request.json();
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("not an object");
    }
    return body;
  } catch {
    throw new HttpError(400, "request body must be a JSON object");
  }
}
function documentId(value) {
  if (value === void 0 || value === null) {
    return crypto.randomUUID();
  }
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new HttpError(400, "id must match [A-Za-z0-9][A-Za-z0-9._-]{0,127}");
  }
  return value;
}
function graphIdentifier(value) {
  if (value === void 0 || value === null) {
    return DEFAULTS.graphId;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HttpError(400, "field 'graphId' must be a non-empty string");
  }
  return value;
}
function extraMetadata(value) {
  if (value === void 0 || value === null) {
    return {};
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "metadata must be a JSON object");
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_METADATA_ENTRIES) {
    throw new HttpError(400, `metadata accepts at most ${MAX_METADATA_ENTRIES} properties`);
  }
  return Object.fromEntries(
    entries.map(([key, entry]) => {
      if (["documentId", "chunkIndex", "source", "text"].includes(key)) {
        throw new HttpError(400, `metadata property ${key} is reserved`);
      }
      if (!["string", "number", "boolean"].includes(typeof entry)) {
        throw new HttpError(400, `metadata property ${key} must be a string, number, or boolean`);
      }
      return [key, entry];
    })
  );
}
function chunk(text, size, overlap) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + size, text.length);
    if (end < text.length) {
      const window = text.slice(start, end);
      const breakpoint = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf(". "));
      if (breakpoint > size * 0.5) {
        end = start + breakpoint + 1;
      }
    }
    const piece = text.slice(start, end).trim();
    if (piece.length > 0) {
      chunks.push(piece);
    }
    if (end >= text.length) {
      break;
    }
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}
async function embed(env, texts) {
  const vectors = [];
  for (let offset = 0; offset < texts.length; offset += EMBEDDING_BATCH) {
    const batch = texts.slice(offset, offset + EMBEDDING_BATCH);
    const result = await env.AI.run(env.EMBEDDING_MODEL, { text: batch });
    const data = Array.isArray(result?.data) ? result.data : [];
    if (data.length !== batch.length) {
      throw new HttpError(502, "the embedding model returned an unexpected number of vectors");
    }
    vectors.push(...data);
  }
  return vectors;
}
function health(env, config) {
  return json({
    service: SERVICE,
    status: "ok",
    environment: config.environment,
    models: {
      embedding: config.embeddingModel,
      generation: config.generationModel
    },
    retrieval: {
      chunkSize: config.chunkSize,
      chunkOverlap: config.chunkOverlap,
      topK: config.topK
    },
    bindings: {
      ai: Boolean(env.AI),
      vectorize: Boolean(env.VECTORIZE),
      documents: Boolean(env.DOCUMENTS)
    },
    authenticated: Boolean(env.AUTH_TOKEN),
    timestamp: (/* @__PURE__ */ new Date()).toISOString()
  });
}
function scheduleGraphEnrichment(ctx, env, graphId, docId, text) {
  if (!env.AI_WORKER || !env.GRAPH_WORKER) {
    console.warn("rag: skipping graph enrichment, AI_WORKER/GRAPH_WORKER binding not configured");
    return;
  }
  if (!ctx || typeof ctx.waitUntil !== "function") {
    return;
  }
  ctx.waitUntil(
    (async () => {
      const extracted = await extractEntities(env.AI_WORKER, text.slice(0, ENTITY_EXTRACTION_TEXT_LIMIT));
      if (extracted.entities.length > 0) {
        await syncEntitiesToGraph(env.GRAPH_WORKER, graphId, docId, extracted);
      }
    })().catch((error) => console.error("rag: graph enrichment failed", error))
  );
}
async function ingest(request, env, config, ctx) {
  const body = await readJson(request);
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (text.length === 0) {
    throw new HttpError(400, "field 'text' is required and must be a non-empty string");
  }
  if (text.length > MAX_DOCUMENT_LENGTH) {
    throw new HttpError(413, `field 'text' must be at most ${MAX_DOCUMENT_LENGTH} characters`);
  }
  if (body.source !== void 0 && typeof body.source !== "string") {
    throw new HttpError(400, "field 'source' must be a string");
  }
  const id = documentId(body.id);
  const source = body.source ?? id;
  const metadata = extraMetadata(body.metadata);
  const graphId = graphIdentifier(body.graphId);
  const pieces = chunk(text, config.chunkSize, config.chunkOverlap);
  if (pieces.length === 0) {
    throw new HttpError(400, "field 'text' produced no chunks");
  }
  const sourceKey = `documents/${id}/source.txt`;
  const manifestKey = `documents/${id}/manifest.json`;
  await env.DOCUMENTS.put(sourceKey, text, {
    httpMetadata: { contentType: "text/plain; charset=utf-8" },
    customMetadata: { documentId: id, source }
  });
  const embeddings = await embed(env, pieces);
  const vectors = pieces.map((piece, index) => ({
    id: `${id}#${index}`,
    values: embeddings[index],
    metadata: {
      ...metadata,
      documentId: id,
      chunkIndex: index,
      source,
      text: piece.slice(0, METADATA_TEXT_LIMIT)
    }
  }));
  const mutation = await env.VECTORIZE.upsert(vectors);
  const manifest = {
    documentId: id,
    source,
    metadata,
    graphId,
    sourceKey,
    chunkCount: vectors.length,
    chunkSize: config.chunkSize,
    chunkOverlap: config.chunkOverlap,
    embeddingModel: config.embeddingModel,
    vectorIds: vectors.map((vector) => vector.id),
    ingestedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  await env.DOCUMENTS.put(manifestKey, JSON.stringify(manifest, null, 2), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: { documentId: id }
  });
  scheduleGraphEnrichment(ctx, env, graphId, id, text);
  return json(
    {
      documentId: id,
      chunks: vectors.length,
      vectorIds: manifest.vectorIds,
      objects: { source: sourceKey, manifest: manifestKey },
      mutationId: mutation?.mutationId ?? null
    },
    { status: 201 }
  );
}
async function runQuery(env, config, question, { topK: topKOverride, filter } = {}) {
  const trimmedQuestion = typeof question === "string" ? question.trim() : "";
  if (trimmedQuestion.length === 0) {
    throw new HttpError(400, "field 'question' is required and must be a non-empty string");
  }
  if (trimmedQuestion.length > MAX_QUESTION_LENGTH) {
    throw new HttpError(413, `field 'question' must be at most ${MAX_QUESTION_LENGTH} characters`);
  }
  if (filter !== void 0 && (typeof filter !== "object" || filter === null || Array.isArray(filter))) {
    throw new HttpError(400, "field 'filter' must be a JSON object");
  }
  const topK = clamp(integer(topKOverride, config.topK), 1, 50);
  const [vector] = await embed(env, [trimmedQuestion]);
  const search = await env.VECTORIZE.query(vector, {
    topK,
    returnMetadata: "all",
    ...filter === void 0 ? {} : { filter }
  });
  const matches = Array.isArray(search?.matches) ? search.matches : [];
  const sources = matches.map((match) => ({
    id: match.id,
    score: match.score,
    documentId: match.metadata?.documentId ?? null,
    chunkIndex: match.metadata?.chunkIndex ?? null,
    source: match.metadata?.source ?? null
  }));
  const context = matches.map((match, index) => {
    const text = match.metadata?.text;
    return typeof text === "string" ? `[${index + 1}] ${text}` : null;
  }).filter((entry) => entry !== null);
  if (context.length === 0) {
    return {
      question: trimmedQuestion,
      answer: "There is no indexed context available to answer this question.",
      sources
    };
  }
  const completion = await env.AI.run(env.GENERATION_MODEL, {
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `Context:
${context.join("\n\n")}

Question: ${trimmedQuestion}` }
    ]
  });
  const answer = typeof completion === "string" ? completion : completion?.response ?? "";
  return { question: trimmedQuestion, answer, sources };
}
async function query(request, env, config) {
  const body = await readJson(request);
  const result = await runQuery(env, config, body.question, { topK: body.topK, filter: body.filter });
  return json(result);
}
var ROUTES = {
  "/health": { method: "GET", handler: (request, env, config) => health(env, config), authenticated: false },
  "/ingest": { method: "POST", handler: ingest, authenticated: true, permission: "rag:ingest" },
  "/query": { method: "POST", handler: query, authenticated: true, permission: "rag:query" }
};
var index_default = class extends WorkerEntrypoint {
  async fetch(request) {
    const env = this.env;
    const { pathname } = new URL(request.url);
    const route = ROUTES[pathname.replace(/\/+$/, "") || "/health"];
    if (route === void 0) {
      return json({ error: "not found" }, { status: 404 });
    }
    if (request.method !== route.method) {
      return json({ error: "method not allowed" }, { status: 405, headers: { allow: route.method } });
    }
    try {
      requireBindings(env);
      if (route.authenticated) {
        await authorize(request, env, route.permission);
      }
      return await route.handler(request, env, configuration(env), this.ctx);
    } catch (error) {
      if (error instanceof HttpError) {
        return json({ error: error.message }, { status: error.status });
      }
      console.error(error);
      return json({ error: "internal error" }, { status: 500 });
    }
  }
  // RPC entrypoint for other workers via Service Bindings (graphrag-worker, Fase 4 of
  // the GraphRAG roadmap). No requirePermission/JWT here: Service Bindings are only
  // reachable from within the same Cloudflare account -- same convention as
  // ai-worker's chat() and graph-worker's RPC surface.
  async query(question, opts = {}) {
    requireBindings(this.env);
    return runQuery(this.env, configuration(this.env), question, opts);
  }
};
export {
  index_default as default
};
