// Extracts candidate entities from a user's question via the ai-worker RPC
// (Service Binding, `env.AI_WORKER.chat(...)`), so graphrag-worker can look
// them up in the knowledge graph (findNodeByLabel/findPaths) for structural
// context (Fase 4 of the GraphRAG roadmap).
//
// This is a question-focused variant of rag-worker's own
// lib/entity-extraction.mjs, duplicated rather than imported: esbuild
// (scripts/build-workers.mjs) compiles each worker's src/ tree in isolation
// from its own entry point, and each Worker is deployed independently, so
// reaching into terraform/workers/rag/lib/ from here would couple two
// separately deployed Workers' source trees together. The prompt itself also
// differs on purpose -- extracting candidate entities to look up from a
// short question is a narrower task than extracting entities+relations from
// a whole ingested document, so relations aren't requested here at all.
//
// Like its rag-worker counterpart, this module never throws: a misbehaving
// model, an unreachable AI_WORKER binding, or malformed JSON all degrade to
// an empty result rather than failing the caller's question.

const EXTRACTION_PROMPT = [
  "Extract candidate entities mentioned or implied in the question, as strict JSON:",
  '{"entities":[{"type":"...","label":"..."}]}.',
  "Types should be short nouns (e.g. ingredient, person, concept). No prose, JSON only.",
  "If no entities are identifiable, return an empty entities array.",
].join(" ");

function emptyResult() {
  return { entities: [] };
}

function isValidEntity(entity) {
  return (
    entity !== null &&
    typeof entity === "object" &&
    typeof entity.type === "string" &&
    entity.type.trim().length > 0 &&
    typeof entity.label === "string" &&
    entity.label.trim().length > 0
  );
}

// chatCompletion() (ai-worker's lib/ai.mjs) returns an OpenAI-shaped completion:
// { choices: [{ message: { role, content } }], ... }. The extracted entities
// JSON is expected as the assistant message's `content`.
function extractContent(chatResult) {
  return chatResult?.choices?.[0]?.message?.content;
}

// Defensive parsing: the model is instructed to return JSON only, but nothing
// guarantees it will (prose wrapper, markdown code fences, truncated output).
// Any failure to parse or match the expected shape returns an empty result
// instead of throwing, and logs the reason.
export function parseEntitiesJson(chatResult) {
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
  } catch (error) {
    console.error("graphrag entity extraction: failed to parse AI_WORKER.chat() output as JSON", error);
    return emptyResult();
  }
}

export async function extractEntitiesFromQuestion(aiWorkerBinding, question) {
  if (!aiWorkerBinding) {
    console.error("graphrag entity extraction: AI_WORKER binding not configured");
    return emptyResult();
  }

  try {
    const result = await aiWorkerBinding.chat(
      [
        { role: "system", content: EXTRACTION_PROMPT },
        { role: "user", content: question },
      ],
      { temperature: 0 },
    );
    return parseEntitiesJson(result);
  } catch (error) {
    console.error("graphrag entity extraction: AI_WORKER.chat() call failed", error);
    return emptyResult();
  }
}
