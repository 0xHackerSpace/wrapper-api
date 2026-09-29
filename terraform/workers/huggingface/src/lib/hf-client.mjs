// Thin fetch-based client for the Hugging Face Inference Providers router
// (docs/specs/huggingface-worker.md). No SDK dependency -- see
// docs/specs/huggingface-worker-out-of-scope.md ("Dependency oficial").
import { CORS_HEADERS } from "./response.mjs";

export const HF_ROUTER_URL = "https://router.huggingface.co";

// hf-inference is the only provider whose URL shape was actually inspected in
// the HF SDK source (spec, "Fatos adicionais confirmados"), so it's the safe
// default when the caller omits `provider` on the 18 non-chat tasks. Chat
// completions never gets this default applied -- its `provider` (including
// "auto"/omitted) is forwarded to HF verbatim, see chatCompletion() below.
const DEFAULT_PROVIDER = "hf-inference";

// Single error class for both local validation failures (e.g. missing
// `model`, unparsable JSON body -- 400/500) and translated Hugging Face API
// errors, so index.mjs has one `instanceof` branch to handle in its catch
// block (see CLAUDE.md guidance against error.message.includes()).
export class HfError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function requireHfToken(env) {
  if (!env.HF_TOKEN) {
    throw new HfError(500, "HF_TOKEN not configured");
  }
}

async function fetchHf(url, init, env) {
  requireHfToken(env);

  let response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        ...init.headers,
        Authorization: `Bearer ${env.HF_TOKEN}`,
      },
    });
  } catch (err) {
    throw new HfError(502, `Failed to reach Hugging Face: ${err.message}`);
  }

  return response;
}

// Translates a non-2xx Hugging Face response into an HfError, preserving the
// original HTTP status (spec: "4xx da HF vira o mesmo 4xx").
async function toHfError(response) {
  let message = `Hugging Face request failed with status ${response.status}`;
  try {
    const body = await response.json();
    const extracted = body?.error?.message ?? body?.error ?? body?.message;
    if (extracted) message = typeof extracted === "string" ? extracted : JSON.stringify(extracted);
  } catch {
    // Response body wasn't JSON (or was empty) -- keep the generic message above.
  }
  return new HfError(response.status, message);
}

function proxyResponse(response, fallbackContentType) {
  return new Response(response.body, {
    status: response.status,
    headers: {
      "Content-Type": response.headers.get("content-type") || fallbackContentType,
      ...CORS_HEADERS,
    },
  });
}

function parseJsonBody(request) {
  return request.json().catch(() => {
    throw new HfError(400, "Invalid JSON body");
  });
}

// POST /v1/chat/completions -- the only unified, OpenAI-compatible HF
// endpoint (spec, "Fatos confirmados"). Payload/headers repassed almost
// verbatim; when body.stream is true the HF SSE ReadableStream is piped
// straight through, untouched.
export async function chatCompletion(request, env) {
  const body = await parseJsonBody(request);

  const response = await fetchHf(
    `${HF_ROUTER_URL}/v1/chat/completions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    env
  );

  if (!response.ok) {
    throw await toHfError(response);
  }

  return proxyResponse(response, body.stream ? "text/event-stream" : "application/json");
}

// {router}/{provider}/models/{model} for every non-chat task, except
// feature-extraction which uses the dedicated .../pipeline/feature-extraction
// route (spec, "Fatos adicionais confirmados").
function buildModelUrl(provider, model, task) {
  const base = `${HF_ROUTER_URL}/${provider}/models/${model}`;
  return task === "feature-extraction" ? `${base}/pipeline/feature-extraction` : base;
}

// JSON non-chat tasks (text-generation, feature-extraction, fill-mask,
// question-answering, summarization, table-question-answering,
// text-classification, token-classification, translation,
// zero-shot-classification): { inputs, parameters } in, JSON out.
export async function runJsonTask(request, env, task) {
  const body = await parseJsonBody(request);
  const { model, provider, inputs, parameters } = body;

  if (!model) {
    throw new HfError(400, "Missing required field: model");
  }

  const url = buildModelUrl(provider || DEFAULT_PROVIDER, model, task);
  const payload = parameters !== undefined ? { inputs, parameters } : { inputs };

  const response = await fetchHf(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    env
  );

  if (!response.ok) {
    throw await toHfError(response);
  }

  return proxyResponse(response, "application/json");
}

// Binary-output tasks (text-to-image, text-to-video): JSON in ({ inputs,
// parameters }, same URL shape as runJsonTask), binary out -- the HF response
// is proxied verbatim, never decoded/re-encoded.
export async function runBinaryOutputTask(request, env, task) {
  const body = await parseJsonBody(request);
  const { model, provider, inputs, parameters } = body;

  if (!model) {
    throw new HfError(400, "Missing required field: model");
  }

  const url = buildModelUrl(provider || DEFAULT_PROVIDER, model, task);
  const payload = parameters !== undefined ? { inputs, parameters } : { inputs };

  const response = await fetchHf(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    env
  );

  if (!response.ok) {
    throw await toHfError(response);
  }

  return proxyResponse(response, "application/octet-stream");
}

// Binary-input tasks (image-classification, image-segmentation,
// object-detection, automatic-speech-recognition, audio-classification,
// image-to-image): model/provider come from the query string, the client's
// raw request body is forwarded to HF untouched -- no JSON envelope, no
// decoding (confirmed by TaskProviderHelper.makeBody in the HF SDK source,
// spec "Fatos adicionais confirmados"). image-to-image is the only task with
// extra params (e.g. prompt) alongside the image; this worker forwards them
// as extra query params on the outgoing HF URL, a pragmatic choice flagged as
// unverified in the spec's "Casos a verificar".
export async function runBinaryInputTask(request, env, task, url) {
  const model = url.searchParams.get("model");
  const provider = url.searchParams.get("provider") || undefined;

  if (!model) {
    throw new HfError(400, "Missing required query parameter: model");
  }

  let targetUrl = buildModelUrl(provider || DEFAULT_PROVIDER, model, task);

  if (task === "image-to-image") {
    const extraParams = new URLSearchParams();
    for (const [key, value] of url.searchParams.entries()) {
      if (key === "model" || key === "provider") continue;
      extraParams.append(key, value);
    }
    const qs = extraParams.toString();
    if (qs) targetUrl += `?${qs}`;
  }

  const contentType = request.headers.get("content-type") || "application/octet-stream";

  const response = await fetchHf(
    targetUrl,
    {
      method: "POST",
      headers: { "Content-Type": contentType },
      body: request.body,
      duplex: "half",
    },
    env
  );

  if (!response.ok) {
    throw await toHfError(response);
  }

  return proxyResponse(response, "application/json");
}
