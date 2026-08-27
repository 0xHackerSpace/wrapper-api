// Retrieval-augmented generation Worker. Every account, bucket, index and model name arrives through
// bindings declared by Terraform, so this file stays environment agnostic.

const SERVICE = "rag";
const METADATA_TEXT_LIMIT = 2048;
const EMBEDDING_BATCH = 50;
const MAX_DOCUMENT_LENGTH = 512 * 1024;
const MAX_QUESTION_LENGTH = 2000;
const MAX_METADATA_ENTRIES = 16;

const DEFAULTS = {
  chunkSize: 1200,
  chunkOverlap: 150,
  topK: 5,
};

const SYSTEM_PROMPT = [
  "You answer questions using only the provided context.",
  "Cite nothing that is absent from the context and say when the context is insufficient.",
].join(" ");

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...init.headers,
    },
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
  const chunkSize = clamp(integer(env.CHUNK_SIZE, DEFAULTS.chunkSize), 200, 4000);
  return {
    environment: env.ENVIRONMENT ?? "unknown",
    embeddingModel: env.EMBEDDING_MODEL,
    generationModel: env.GENERATION_MODEL,
    chunkSize,
    chunkOverlap: clamp(integer(env.CHUNK_OVERLAP, DEFAULTS.chunkOverlap), 0, chunkSize - 1),
    topK: clamp(integer(env.TOP_K, DEFAULTS.topK), 1, 50),
  };
}

function requireBindings(env) {
  for (const binding of ["AI", "VECTORIZE", "DOCUMENTS", "EMBEDDING_MODEL", "GENERATION_MODEL"]) {
    if (!env[binding]) {
      throw new HttpError(500, `missing binding ${binding}`);
    }
  }
}

// Constant-time comparison so a bound token cannot be recovered by timing the endpoint.
function secretsMatch(provided, expected) {
  const encoder = new TextEncoder();
  const left = encoder.encode(provided);
  const right = encoder.encode(expected);
  let mismatch = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    mismatch |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return mismatch === 0;
}

// Authentication is opt-in: it applies only when an AUTH_TOKEN binding is attached to the Worker.
function authorize(request, env) {
  if (!env.AUTH_TOKEN) {
    return;
  }
  const header = request.headers.get("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!secretsMatch(provided, env.AUTH_TOKEN)) {
    throw new HttpError(401, "unauthorized");
  }
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
  if (value === undefined || value === null) {
    return crypto.randomUUID();
  }
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new HttpError(400, "id must match [A-Za-z0-9][A-Za-z0-9._-]{0,127}");
  }
  return value;
}

function extraMetadata(value) {
  if (value === undefined || value === null) {
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
    }),
  );
}

// Character based chunking with overlap, splitting on the last paragraph or sentence break when possible.
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
      generation: config.generationModel,
    },
    retrieval: {
      chunkSize: config.chunkSize,
      chunkOverlap: config.chunkOverlap,
      topK: config.topK,
    },
    bindings: {
      ai: Boolean(env.AI),
      vectorize: Boolean(env.VECTORIZE),
      documents: Boolean(env.DOCUMENTS),
    },
    authenticated: Boolean(env.AUTH_TOKEN),
    timestamp: new Date().toISOString(),
  });
}

async function ingest(request, env, config) {
  const body = await readJson(request);
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (text.length === 0) {
    throw new HttpError(400, "field 'text' is required and must be a non-empty string");
  }
  if (text.length > MAX_DOCUMENT_LENGTH) {
    throw new HttpError(413, `field 'text' must be at most ${MAX_DOCUMENT_LENGTH} characters`);
  }
  if (body.source !== undefined && typeof body.source !== "string") {
    throw new HttpError(400, "field 'source' must be a string");
  }

  const id = documentId(body.id);
  const source = body.source ?? id;
  const metadata = extraMetadata(body.metadata);
  const pieces = chunk(text, config.chunkSize, config.chunkOverlap);
  if (pieces.length === 0) {
    throw new HttpError(400, "field 'text' produced no chunks");
  }

  const sourceKey = `documents/${id}/source.txt`;
  const manifestKey = `documents/${id}/manifest.json`;

  // The original document lands in R2 first so a failed indexing run can be replayed from storage.
  await env.DOCUMENTS.put(sourceKey, text, {
    httpMetadata: { contentType: "text/plain; charset=utf-8" },
    customMetadata: { documentId: id, source },
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
      text: piece.slice(0, METADATA_TEXT_LIMIT),
    },
  }));
  const mutation = await env.VECTORIZE.upsert(vectors);

  const manifest = {
    documentId: id,
    source,
    metadata,
    sourceKey,
    chunkCount: vectors.length,
    chunkSize: config.chunkSize,
    chunkOverlap: config.chunkOverlap,
    embeddingModel: config.embeddingModel,
    vectorIds: vectors.map((vector) => vector.id),
    ingestedAt: new Date().toISOString(),
  };
  await env.DOCUMENTS.put(manifestKey, JSON.stringify(manifest, null, 2), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: { documentId: id },
  });

  return json(
    {
      documentId: id,
      chunks: vectors.length,
      vectorIds: manifest.vectorIds,
      objects: { source: sourceKey, manifest: manifestKey },
      mutationId: mutation?.mutationId ?? null,
    },
    { status: 201 },
  );
}

async function query(request, env, config) {
  const body = await readJson(request);
  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (question.length === 0) {
    throw new HttpError(400, "field 'question' is required and must be a non-empty string");
  }
  if (question.length > MAX_QUESTION_LENGTH) {
    throw new HttpError(413, `field 'question' must be at most ${MAX_QUESTION_LENGTH} characters`);
  }
  if (body.filter !== undefined && (typeof body.filter !== "object" || body.filter === null || Array.isArray(body.filter))) {
    throw new HttpError(400, "field 'filter' must be a JSON object");
  }

  const topK = clamp(integer(body.topK, config.topK), 1, 50);
  const [vector] = await embed(env, [question]);
  const search = await env.VECTORIZE.query(vector, {
    topK,
    returnMetadata: "all",
    ...(body.filter === undefined ? {} : { filter: body.filter }),
  });

  const matches = Array.isArray(search?.matches) ? search.matches : [];
  const sources = matches.map((match) => ({
    id: match.id,
    score: match.score,
    documentId: match.metadata?.documentId ?? null,
    chunkIndex: match.metadata?.chunkIndex ?? null,
    source: match.metadata?.source ?? null,
  }));

  const context = matches
    .map((match, index) => {
      const text = match.metadata?.text;
      return typeof text === "string" ? `[${index + 1}] ${text}` : null;
    })
    .filter((entry) => entry !== null);

  if (context.length === 0) {
    return json({
      question,
      answer: "There is no indexed context available to answer this question.",
      sources,
    });
  }

  const completion = await env.AI.run(env.GENERATION_MODEL, {
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `Context:\n${context.join("\n\n")}\n\nQuestion: ${question}` },
    ],
  });
  const answer = typeof completion === "string" ? completion : (completion?.response ?? "");

  return json({ question, answer, sources });
}

const ROUTES = {
  "/health": { method: "GET", handler: (request, env, config) => health(env, config), authenticated: false },
  "/ingest": { method: "POST", handler: ingest, authenticated: true },
  "/query": { method: "POST", handler: query, authenticated: true },
};

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    const route = ROUTES[pathname.replace(/\/+$/, "") || "/health"];

    if (route === undefined) {
      return json({ error: "not found" }, { status: 404 });
    }
    if (request.method !== route.method) {
      return json({ error: "method not allowed" }, { status: 405, headers: { allow: route.method } });
    }

    try {
      requireBindings(env);
      if (route.authenticated) {
        authorize(request, env);
      }
      return await route.handler(request, env, configuration(env));
    } catch (error) {
      if (error instanceof HttpError) {
        return json({ error: error.message }, { status: error.status });
      }
      console.error(error);
      return json({ error: "internal error" }, { status: 500 });
    }
  },
};
