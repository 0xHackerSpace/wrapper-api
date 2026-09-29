import { json, notFound, internalError, CORS_HEADERS } from "./lib/response.mjs";
import { requirePermission, AuthError } from "./lib/auth.mjs";
import { chatCompletion, runJsonTask, runBinaryOutputTask, runBinaryInputTask, HfError } from "./lib/hf-client.mjs";

const PERMISSION = "huggingface:use";

// docs/specs/huggingface-worker.md, "Uma rota HTTP por task": JSON in
// ({ model, inputs, parameters?, provider? }), JSON out.
const JSON_TASK_ROUTES = {
  "/v1/text-generation": "text-generation",
  "/v1/feature-extraction": "feature-extraction",
  "/v1/fill-mask": "fill-mask",
  "/v1/question-answering": "question-answering",
  "/v1/summarization": "summarization",
  "/v1/table-question-answering": "table-question-answering",
  "/v1/text-classification": "text-classification",
  "/v1/token-classification": "token-classification",
  "/v1/translation": "translation",
  "/v1/zero-shot-classification": "zero-shot-classification",
};

// JSON in ({ model, inputs, parameters?, provider? }), binary out.
const BINARY_OUTPUT_TASK_ROUTES = {
  "/v1/text-to-image": "text-to-image",
  "/v1/text-to-video": "text-to-video",
};

// Binary in (raw request body) + model/provider via query string, JSON out.
const BINARY_INPUT_TASK_ROUTES = {
  "/v1/image-to-image": "image-to-image",
  "/v1/image-classification": "image-classification",
  "/v1/image-segmentation": "image-segmentation",
  "/v1/object-detection": "object-detection",
  "/v1/automatic-speech-recognition": "automatic-speech-recognition",
  "/v1/audio-classification": "audio-classification",
};

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const { pathname } = url;

    try {
      if (pathname === "/health") return handleHealth(env);
      if (pathname === "/" || pathname === "/v1") return handleInfo(env);

      if (pathname === "/v1/chat/completions" && request.method === "POST") {
        return await handleChatCompletion(request, env);
      }

      if (JSON_TASK_ROUTES[pathname] && request.method === "POST") {
        return await handleJsonTask(request, env, JSON_TASK_ROUTES[pathname]);
      }

      if (BINARY_OUTPUT_TASK_ROUTES[pathname] && request.method === "POST") {
        return await handleBinaryOutputTask(request, env, BINARY_OUTPUT_TASK_ROUTES[pathname]);
      }

      if (BINARY_INPUT_TASK_ROUTES[pathname] && request.method === "POST") {
        return await handleBinaryInputTask(request, env, BINARY_INPUT_TASK_ROUTES[pathname], url);
      }

      return notFound("Endpoint not found");
    } catch (error) {
      if (error instanceof AuthError) {
        return json({ error: { message: error.message, type: "invalid_request_error" } }, error.status);
      }
      if (error instanceof HfError) {
        return json({ error: { message: error.message, type: "invalid_request_error" } }, error.status);
      }
      console.error(error);
      return internalError(error.message);
    }
  },
};

function handleHealth(env) {
  return json({
    service: "huggingface",
    status: "ok",
    environment: env.ENVIRONMENT ?? "unknown",
  });
}

function handleInfo(env) {
  return json({
    service: "huggingface",
    version: "1.0.0",
    description: "Proxy autenticado para a API de Inference Providers da Hugging Face (router.huggingface.co) -- 19 tasks de ML, multi-provider",
    environment: env.ENVIRONMENT ?? "unknown",
    endpoints: {
      health: "GET /health",
      info: "GET / or GET /v1",
      chat_completions: "POST /v1/chat/completions (requires auth, huggingface:use; JSON { model, messages, provider?, stream? }, OpenAI-compatible, streams SSE when stream: true)",
      text_generation: "POST /v1/text-generation (requires auth, huggingface:use; JSON { model, inputs, parameters?, provider? })",
      feature_extraction: "POST /v1/feature-extraction (requires auth, huggingface:use; JSON { model, inputs, provider? })",
      fill_mask: "POST /v1/fill-mask (requires auth, huggingface:use; JSON { model, inputs, provider? })",
      question_answering: "POST /v1/question-answering (requires auth, huggingface:use; JSON { model, inputs: { question, context }, provider? })",
      summarization: "POST /v1/summarization (requires auth, huggingface:use; JSON { model, inputs, parameters?, provider? })",
      table_question_answering: "POST /v1/table-question-answering (requires auth, huggingface:use; JSON { model, inputs: { query, table }, provider? })",
      text_classification: "POST /v1/text-classification (requires auth, huggingface:use; JSON { model, inputs, provider? })",
      token_classification: "POST /v1/token-classification (requires auth, huggingface:use; JSON { model, inputs, provider? })",
      translation: "POST /v1/translation (requires auth, huggingface:use; JSON { model, inputs, parameters?, provider? })",
      zero_shot_classification: "POST /v1/zero-shot-classification (requires auth, huggingface:use; JSON { model, inputs, parameters: { candidate_labels }, provider? })",
      text_to_image: "POST /v1/text-to-image (requires auth, huggingface:use; JSON { model, inputs, parameters?, provider? }, returns binary image)",
      text_to_video: "POST /v1/text-to-video (requires auth, huggingface:use; JSON { model, inputs, parameters?, provider? }, returns binary video)",
      image_to_image: "POST /v1/image-to-image (requires auth, huggingface:use; binary image body, model/provider/params via query string, returns binary image)",
      image_classification: "POST /v1/image-classification (requires auth, huggingface:use; binary image body, model/provider via query string)",
      image_segmentation: "POST /v1/image-segmentation (requires auth, huggingface:use; binary image body, model/provider via query string)",
      object_detection: "POST /v1/object-detection (requires auth, huggingface:use; binary image body, model/provider via query string)",
      automatic_speech_recognition: "POST /v1/automatic-speech-recognition (requires auth, huggingface:use; binary audio body, model/provider via query string)",
      audio_classification: "POST /v1/audio-classification (requires auth, huggingface:use; binary audio body, model/provider via query string)",
    },
    authentication: {
      type: "JWT Bearer Token",
      header: "Authorization: Bearer {token}",
      permission: PERMISSION,
    },
  });
}

async function handleChatCompletion(request, env) {
  await requirePermission(request, env, PERMISSION);
  return await chatCompletion(request, env);
}

async function handleJsonTask(request, env, task) {
  await requirePermission(request, env, PERMISSION);
  return await runJsonTask(request, env, task);
}

async function handleBinaryOutputTask(request, env, task) {
  await requirePermission(request, env, PERMISSION);
  return await runBinaryOutputTask(request, env, task);
}

async function handleBinaryInputTask(request, env, task, url) {
  await requirePermission(request, env, PERMISSION);
  return await runBinaryInputTask(request, env, task, url);
}
