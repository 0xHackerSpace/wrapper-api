export class ValidationError extends Error {}

function normalizeMessages(messages) {
  const normalized = [];
  let systemPrompt = "";

  for (const msg of messages) {
    if (msg.role === "system") {
      systemPrompt += (systemPrompt ? "\n\n" : "") + msg.content;
    } else {
      normalized.push(msg);
    }
  }

  if (systemPrompt && normalized.length > 0 && normalized[0].role === "user") {
    normalized[0] = {
      role: "user",
      content: `${systemPrompt}\n\n${normalized[0].content}`,
    };
  }

  return normalized;
}

export async function chatCompletion(ai, messages, options = {}) {
  const {
    model = "@cf/mistral/mistral-7b-instruct-v0.1",
    temperature = 0.7,
    max_tokens = 1024,
    top_p = 1,
  } = options;

  try {
    const normalizedMessages = normalizeMessages(messages);

    const response = await ai.run(model, {
      messages: normalizedMessages,
      temperature,
      max_tokens,
      top_p,
    });

    return {
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: response.response || response,
          },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: response.usage?.prompt_tokens || 0,
        completion_tokens: response.usage?.completion_tokens || 0,
        total_tokens: response.usage?.total_tokens || 0,
      },
    };
  } catch (error) {
    throw new Error(`AI model error: ${error.message}`);
  }
}

// Parses the raw SSE stream Workers AI returns when ai.run() is called with
// stream: true (`data: {"response":"token"}\n\n`, terminated by
// `data: [DONE]\n\n`) into the decoded JSON events. Buffers across chunk
// boundaries since a single controller.enqueue() on the source stream isn't
// guaranteed to line up with a full "\n\n"-terminated SSE event.
async function* parseRawAiStream(rawStream) {
  const reader = rawStream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, boundary).trim();
        buffer = buffer.slice(boundary + 2);

        if (!rawEvent.startsWith("data:")) continue;
        const payload = rawEvent.slice(5).trim();
        if (payload === "[DONE]") return;

        yield JSON.parse(payload);
      }
    }
  } finally {
    reader.releaseLock?.();
  }
}

// Translates raw Workers AI SSE events into a small internal event vocabulary
// ({ type: "content" } for each token, { type: "usage" } once available at
// the end of the stream -- Workers AI doesn't expose partial token counts).
// A failure here (network error, model error mid-generation) surfaces as a
// thrown error from the async generator, which the caller (index.mjs, via
// createChatCompletionChunkStream) turns into an SSE error chunk instead of
// an HTTP error response, since headers/status are already sent by then.
async function* streamChatEvents(rawStream) {
  try {
    for await (const event of parseRawAiStream(rawStream)) {
      if (event.response) {
        yield { type: "content", content: event.response };
      }
      if (event.usage) {
        yield { type: "usage", usage: event.usage };
      }
    }
  } catch (error) {
    throw new Error(`AI model error: ${error.message}`);
  }
}

// Streaming counterpart to chatCompletion(): calls ai.run() with stream: true
// and returns the chunk metadata (id/created/model, mirroring the
// non-streaming response shape) plus an async generator of translated events.
// Building the actual SSE `chat.completion.chunk` wire format is left to
// createChatCompletionChunkStream() below, kept separate so index.mjs can
// inject session-persistence behavior (buffer + forward) between the content
// events ending and the final chunks being emitted.
export async function chatCompletionStream(ai, messages, options = {}) {
  const {
    model = "@cf/mistral/mistral-7b-instruct-v0.1",
    temperature = 0.7,
    max_tokens = 1024,
    top_p = 1,
  } = options;

  let rawStream;
  try {
    const normalizedMessages = normalizeMessages(messages);
    rawStream = await ai.run(model, {
      messages: normalizedMessages,
      temperature,
      max_tokens,
      top_p,
      stream: true,
    });
  } catch (error) {
    throw new Error(`AI model error: ${error.message}`);
  }

  return {
    id: `chatcmpl-${Date.now()}`,
    created: Math.floor(Date.now() / 1000),
    model,
    events: streamChatEvents(rawStream),
  };
}

function sseLine(data) {
  return `data: ${JSON.stringify(data)}\n\n`;
}

// Builds the client-facing ReadableStream of chat.completion.chunk SSE
// events out of the internal event generator from chatCompletionStream().
// `onComplete(content, usage)`, when provided, runs after all content events
// have been consumed but before the finish_reason/usage/[DONE] chunks are
// emitted -- this is the hook POST /v1/sessions/:id/messages uses to persist
// the full assistant message only once the stream has ended successfully.
// If the source stream (or onComplete) throws, an error chunk is emitted
// instead of the finish_reason/usage chunks, followed by [DONE]; the HTTP
// status stays 200 since headers were already sent when this stream started.
export function createChatCompletionChunkStream(events, { id, created, model }, { onComplete } = {}) {
  const encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
      let content = "";

      try {
        for await (const event of events) {
          if (event.type === "content") {
            content += event.content;
            controller.enqueue(
              encoder.encode(
                sseLine({
                  id,
                  object: "chat.completion.chunk",
                  created,
                  model,
                  choices: [{ index: 0, delta: { content: event.content }, finish_reason: null }],
                })
              )
            );
          } else if (event.type === "usage") {
            usage = {
              prompt_tokens: event.usage.prompt_tokens || 0,
              completion_tokens: event.usage.completion_tokens || 0,
              total_tokens: event.usage.total_tokens || 0,
            };
          }
        }

        if (onComplete) {
          await onComplete(content, usage);
        }

        controller.enqueue(
          encoder.encode(
            sseLine({
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            })
          )
        );
        controller.enqueue(encoder.encode(sseLine({ id, object: "chat.completion.chunk", created, model, usage })));
      } catch (error) {
        controller.enqueue(encoder.encode(sseLine({ error: { message: error.message, type: "internal_error" } })));
      } finally {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    },
  });
}

export function getAvailableModels() {
  return {
    object: "list",
    data: [
      {
        id: "@cf/meta/llama-2-7b-chat-int8",
        object: "model",
        owned_by: "cloudflare",
        permission: [],
      },
      {
        id: "@cf/mistral/mistral-7b-instruct-v0.1",
        object: "model",
        owned_by: "cloudflare",
        permission: [],
      },
      {
        id: "@cf/baai/bge-base-en-v1.5",
        object: "model",
        owned_by: "cloudflare",
        permission: [],
      },
    ],
  };
}

export function validateChatCompletionRequest(body) {
  if (!body.messages || !Array.isArray(body.messages)) {
    throw new ValidationError("messages is required and must be an array");
  }

  if (body.messages.length === 0) {
    throw new ValidationError("messages array cannot be empty");
  }

  for (const msg of body.messages) {
    if (!msg.role || !msg.content) {
      throw new ValidationError("each message must have role and content");
    }

    if (!["user", "assistant", "system"].includes(msg.role)) {
      throw new ValidationError("message role must be user, assistant, or system");
    }
  }

  return {
    model: body.model || "@cf/meta/llama-2-7b-chat-int8",
    messages: body.messages,
    temperature: body.temperature || 0.7,
    max_tokens: body.max_tokens || 1024,
    top_p: body.top_p || 1,
  };
}
