// Runs with the Node.js test runner and no dependencies: node --test tests
import assert from "node:assert/strict";
import test from "node:test";

import HuggingFaceWorker from "../terraform/workers/huggingface/src/index.mjs";
import { generateToken } from "../terraform/workers/huggingface/src/lib/jwt.mjs";

const JWT_SECRET = "test-secret";
const HF_TOKEN = "hf_test_token";

function harness(overrides = {}) {
  const env = {
    JWT_SECRET,
    HF_TOKEN,
    ...overrides,
  };

  const call = async (path, init) => {
    const response = await HuggingFaceWorker.fetch(new Request(`https://huggingface.test${path}`, init), env, {});
    return response;
  };

  const callJson = async (path, init) => {
    const response = await call(path, init);
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
  };

  return { env, call, callJson };
}

async function authHeader(payload = { sub: "user-1", permissions: ["huggingface:use"] }) {
  const token = await generateToken(payload, JWT_SECRET);
  return { authorization: `Bearer ${token}` };
}

// Installs a fake global.fetch for the duration of a test and restores the
// original afterwards -- this is the boundary the worker itself calls out to
// (router.huggingface.co), equivalent to mocking env.AI.run()/env.RAG_WORKER
// in other workers' tests, but here it's a raw fetch() call instead of a
// binding method (docs/specs/huggingface-worker.md: "fetch cru contra
// router.huggingface.co").
function mockFetch(implementation) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: typeof url === "string" ? url : url.toString(), init });
    return implementation(url, init);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

test("GET /health reports service status", async () => {
  const { callJson } = harness();
  const { status, body } = await callJson("/health");

  assert.equal(status, 200);
  assert.equal(body.service, "huggingface");
  assert.equal(body.status, "ok");
});

test("GET / and GET /v1 describe all 19 task routes without requiring auth", async () => {
  const { callJson } = harness();

  const root = await callJson("/");
  assert.equal(root.status, 200);
  assert.equal(root.body.service, "huggingface");
  assert.equal(Object.keys(root.body.endpoints).length, 21); // 19 tasks + health + info... info itself isn't listed, chat+18 tasks
  assert.ok(root.body.endpoints.chat_completions);
  assert.ok(root.body.endpoints.feature_extraction);
  assert.ok(root.body.endpoints.image_classification);
  assert.ok(root.body.endpoints.audio_classification);

  const v1 = await callJson("/v1");
  assert.equal(v1.status, 200);
  assert.equal(v1.body.service, "huggingface");
});

test("OPTIONS preflight requests return 204 with CORS headers", async () => {
  const { call } = harness();
  const response = await call("/v1/chat/completions", { method: "OPTIONS" });

  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
});

test("every task route requires a valid JWT with the huggingface:use permission", async () => {
  const { callJson } = harness();

  const noToken = await callJson("/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "m", messages: [] }),
    headers: { "content-type": "application/json" },
  });
  assert.equal(noToken.status, 401);

  const withoutPermission = await authHeader({ sub: "user-1", permissions: [] });
  const forbidden = await callJson("/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "m", messages: [] }),
    headers: { "content-type": "application/json", ...withoutPermission },
  });
  assert.equal(forbidden.status, 403);
});

test("POST /v1/chat/completions builds the right URL/headers and proxies a non-streaming JSON response", async () => {
  const fetchMock = mockFetch(async () => {
    return new Response(JSON.stringify({ id: "chatcmpl-1", object: "chat.completion", choices: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  try {
    const { callJson } = harness();
    const headers = await authHeader();

    const { status, body } = await callJson("/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "openai/gpt-oss-120b", messages: [{ role: "user", content: "hi" }], provider: "auto" }),
      headers: { "content-type": "application/json", ...headers },
    });

    assert.equal(status, 200);
    assert.equal(body.object, "chat.completion");

    assert.equal(fetchMock.calls.length, 1);
    assert.equal(fetchMock.calls[0].url, "https://router.huggingface.co/v1/chat/completions");
    assert.equal(fetchMock.calls[0].init.method, "POST");
    assert.equal(fetchMock.calls[0].init.headers.Authorization, `Bearer ${HF_TOKEN}`);
    assert.equal(fetchMock.calls[0].init.headers["Content-Type"], "application/json");

    const sentBody = JSON.parse(fetchMock.calls[0].init.body);
    assert.equal(sentBody.model, "openai/gpt-oss-120b");
    assert.equal(sentBody.provider, "auto");
    assert.deepEqual(sentBody.messages, [{ role: "user", content: "hi" }]);
  } finally {
    fetchMock.restore();
  }
});

test("POST /v1/chat/completions with stream: true passes through the SSE ReadableStream untouched", async () => {
  const encoder = new TextEncoder();
  const upstreamStream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  const fetchMock = mockFetch(async () => {
    return new Response(upstreamStream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  });

  try {
    const { call } = harness();
    const headers = await authHeader();

    const response = await call("/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }], stream: true }),
      headers: { "content-type": "application/json", ...headers },
    });

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);

    const text = await response.text();
    assert.match(text, /"content":"hi"/);
    assert.match(text, /\[DONE\]/);

    assert.equal(fetchMock.calls[0].url, "https://router.huggingface.co/v1/chat/completions");
    const sentBody = JSON.parse(fetchMock.calls[0].init.body);
    assert.equal(sentBody.stream, true);
  } finally {
    fetchMock.restore();
  }
});

test("POST /v1/feature-extraction builds the pipeline URL and forwards inputs/parameters", async () => {
  const fetchMock = mockFetch(async () => {
    return new Response(JSON.stringify([[0.1, 0.2, 0.3]]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  try {
    const { callJson } = harness();
    const headers = await authHeader();

    const { status, body } = await callJson("/v1/feature-extraction", {
      method: "POST",
      body: JSON.stringify({ model: "sentence-transformers/all-MiniLM-L6-v2", inputs: "hello world" }),
      headers: { "content-type": "application/json", ...headers },
    });

    assert.equal(status, 200);
    assert.deepEqual(body, [[0.1, 0.2, 0.3]]);

    assert.equal(
      fetchMock.calls[0].url,
      "https://router.huggingface.co/hf-inference/models/sentence-transformers/all-MiniLM-L6-v2/pipeline/feature-extraction"
    );
    const sentBody = JSON.parse(fetchMock.calls[0].init.body);
    assert.equal(sentBody.inputs, "hello world");
    assert.equal(sentBody.parameters, undefined);
  } finally {
    fetchMock.restore();
  }
});

test("POST /v1/text-classification defaults provider to hf-inference and respects an explicit provider", async () => {
  const fetchMock = mockFetch(async () => new Response(JSON.stringify([{ label: "POSITIVE", score: 0.9 }]), { status: 200 }));

  try {
    const { callJson } = harness();
    const headers = await authHeader();

    await callJson("/v1/text-classification", {
      method: "POST",
      body: JSON.stringify({ model: "distilbert-base-uncased-finetuned-sst-2-english", inputs: "I love this" }),
      headers: { "content-type": "application/json", ...headers },
    });
    assert.equal(
      fetchMock.calls[0].url,
      "https://router.huggingface.co/hf-inference/models/distilbert-base-uncased-finetuned-sst-2-english"
    );

    await callJson("/v1/text-classification", {
      method: "POST",
      body: JSON.stringify({ model: "some/model", inputs: "hi", provider: "together" }),
      headers: { "content-type": "application/json", ...headers },
    });
    assert.equal(fetchMock.calls[1].url, "https://router.huggingface.co/together/models/some/model");
  } finally {
    fetchMock.restore();
  }
});

test("POST /v1/text-to-image proxies a binary image response verbatim", async () => {
  const fakeImageBytes = new Uint8Array([137, 80, 78, 71]); // PNG magic bytes
  const fetchMock = mockFetch(async () => {
    return new Response(fakeImageBytes, {
      status: 200,
      headers: { "content-type": "image/png" },
    });
  });

  try {
    const { call } = harness();
    const headers = await authHeader();

    const response = await call("/v1/text-to-image", {
      method: "POST",
      body: JSON.stringify({ model: "black-forest-labs/FLUX.1-dev", inputs: "a cat" }),
      headers: { "content-type": "application/json", ...headers },
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");

    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.deepEqual(Array.from(bytes), Array.from(fakeImageBytes));

    assert.equal(fetchMock.calls[0].url, "https://router.huggingface.co/hf-inference/models/black-forest-labs/FLUX.1-dev");
  } finally {
    fetchMock.restore();
  }
});

test("POST /v1/image-classification forwards the raw request body and reads model/provider from the query string", async () => {
  const fakeImageBytes = new Uint8Array([1, 2, 3, 4]);
  const fetchMock = mockFetch(async (url, init) => {
    return new Response(JSON.stringify([{ label: "cat", score: 0.95 }]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  try {
    const { callJson } = harness();
    const headers = await authHeader();

    const { status, body } = await callJson(
      "/v1/image-classification?model=google/vit-base-patch16-224&provider=hf-inference",
      {
        method: "POST",
        body: fakeImageBytes,
        headers: { "content-type": "image/png", ...headers },
      }
    );

    assert.equal(status, 200);
    assert.deepEqual(body, [{ label: "cat", score: 0.95 }]);

    assert.equal(fetchMock.calls.length, 1);
    assert.equal(fetchMock.calls[0].url, "https://router.huggingface.co/hf-inference/models/google/vit-base-patch16-224");
    assert.equal(fetchMock.calls[0].init.method, "POST");
    assert.equal(fetchMock.calls[0].init.headers["Content-Type"], "image/png");
    assert.equal(fetchMock.calls[0].init.headers.Authorization, `Bearer ${HF_TOKEN}`);

    const sentBytes = new Uint8Array(await new Response(fetchMock.calls[0].init.body).arrayBuffer());
    assert.deepEqual(Array.from(sentBytes), Array.from(fakeImageBytes));
  } finally {
    fetchMock.restore();
  }
});

test("POST /v1/image-classification requires model in the query string", async () => {
  const fetchMock = mockFetch(async () => new Response("should not be called", { status: 200 }));

  try {
    const { callJson } = harness();
    const headers = await authHeader();

    const { status, body } = await callJson("/v1/image-classification", {
      method: "POST",
      body: new Uint8Array([1, 2, 3]),
      headers: { "content-type": "image/png", ...headers },
    });

    assert.equal(status, 400);
    assert.match(body.error.message, /model/);
    assert.equal(fetchMock.calls.length, 0);
  } finally {
    fetchMock.restore();
  }
});

test("POST /v1/image-to-image forwards extra query params (e.g. prompt) onto the outgoing HF URL", async () => {
  const fakeImageBytes = new Uint8Array([9, 9, 9]);
  const fetchMock = mockFetch(async () => {
    return new Response(fakeImageBytes, { status: 200, headers: { "content-type": "image/png" } });
  });

  try {
    const { call } = harness();
    const headers = await authHeader();

    const response = await call(
      "/v1/image-to-image?model=some/model&provider=replicate&prompt=make%20it%20blue",
      {
        method: "POST",
        body: fakeImageBytes,
        headers: { "content-type": "image/png", ...headers },
      }
    );

    assert.equal(response.status, 200);
    const calledUrl = new URL(fetchMock.calls[0].url);
    assert.equal(calledUrl.origin + calledUrl.pathname, "https://router.huggingface.co/replicate/models/some/model");
    assert.equal(calledUrl.searchParams.get("prompt"), "make it blue");
    assert.equal(calledUrl.searchParams.has("model"), false);
    assert.equal(calledUrl.searchParams.has("provider"), false);
  } finally {
    fetchMock.restore();
  }
});

test("a 4xx error from Hugging Face is translated to {error:{message,type}} preserving the status", async () => {
  const fetchMock = mockFetch(async () => {
    return new Response(JSON.stringify({ error: "Model not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  });

  try {
    const { callJson } = harness();
    const headers = await authHeader();

    const { status, body } = await callJson("/v1/text-classification", {
      method: "POST",
      body: JSON.stringify({ model: "does/not-exist", inputs: "hi" }),
      headers: { "content-type": "application/json", ...headers },
    });

    assert.equal(status, 404);
    assert.equal(body.error.message, "Model not found");
    assert.equal(body.error.type, "invalid_request_error");
  } finally {
    fetchMock.restore();
  }
});

test("a 5xx error from Hugging Face is translated preserving the status", async () => {
  const fetchMock = mockFetch(async () => {
    return new Response(JSON.stringify({ error: { message: "provider overloaded" } }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  });

  try {
    const { callJson } = harness();
    const headers = await authHeader();

    const { status, body } = await callJson("/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
      headers: { "content-type": "application/json", ...headers },
    });

    assert.equal(status, 503);
    assert.equal(body.error.message, "provider overloaded");
  } finally {
    fetchMock.restore();
  }
});

test("a network failure calling Hugging Face is translated to 502", async () => {
  const fetchMock = mockFetch(async () => {
    throw new Error("connect ETIMEDOUT");
  });

  try {
    const { callJson } = harness();
    const headers = await authHeader();

    const { status, body } = await callJson("/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
      headers: { "content-type": "application/json", ...headers },
    });

    assert.equal(status, 502);
    assert.match(body.error.message, /ETIMEDOUT/);
  } finally {
    fetchMock.restore();
  }
});

test("fails closed with 500 when HF_TOKEN is missing", async () => {
  const fetchMock = mockFetch(async () => new Response("should not be called", { status: 200 }));

  try {
    const { callJson } = harness({ HF_TOKEN: undefined });
    const headers = await authHeader();

    const { status, body } = await callJson("/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
      headers: { "content-type": "application/json", ...headers },
    });

    assert.equal(status, 500);
    assert.match(body.error.message, /HF_TOKEN/);
    assert.equal(fetchMock.calls.length, 0);
  } finally {
    fetchMock.restore();
  }
});

test("unknown endpoints return 404", async () => {
  const { callJson } = harness();
  const { status } = await callJson("/unknown");

  assert.equal(status, 404);
});
