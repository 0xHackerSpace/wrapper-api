// Extracts entities and relations from ingested text via the ai-worker RPC
// (Service Binding, `env.AI_WORKER.chat(...)`), so the resulting graph can be
// enriched automatically as documents are ingested (Fase 3 of the GraphRAG
// roadmap). This module never throws: a misbehaving model, an unreachable
// AI_WORKER binding, or malformed JSON all degrade to an empty result rather
// than failing the caller's /ingest request.

const EXTRACTION_PROMPT = [
  'Extract entities and relations as strict JSON: {"entities":[{"type":"...","label":"..."}],',
  '"relations":[{"from":"<label>","to":"<label>","relation":"..."}]}.',
  "Only use labels from your own entities list. No prose, JSON only.",
].join(" ");

function emptyResult() {
  return { entities: [], relations: [] };
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

function isValidRelation(relation) {
  return (
    relation !== null &&
    typeof relation === "object" &&
    typeof relation.from === "string" &&
    relation.from.trim().length > 0 &&
    typeof relation.to === "string" &&
    relation.to.trim().length > 0 &&
    typeof relation.relation === "string" &&
    relation.relation.trim().length > 0
  );
}

// chatCompletion() (ai-worker's lib/ai.mjs) returns an OpenAI-shaped completion:
// { choices: [{ message: { role, content } }], ... }. The extracted entities/
// relations JSON is expected as the assistant message's `content`.
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

    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.entities) || !Array.isArray(parsed.relations)) {
      console.error("entity extraction: unexpected JSON shape from AI_WORKER.chat()", parsed);
      return emptyResult();
    }

    return {
      entities: parsed.entities.filter(isValidEntity),
      relations: parsed.relations.filter(isValidRelation),
    };
  } catch (error) {
    console.error("entity extraction: failed to parse AI_WORKER.chat() output as JSON", error);
    return emptyResult();
  }
}

export async function extractEntities(aiWorkerBinding, text) {
  if (!aiWorkerBinding) {
    console.error("entity extraction: AI_WORKER binding not configured");
    return emptyResult();
  }

  try {
    const result = await aiWorkerBinding.chat(
      [
        { role: "system", content: EXTRACTION_PROMPT },
        { role: "user", content: text },
      ],
      { temperature: 0 },
    );
    return parseEntitiesJson(result);
  } catch (error) {
    console.error("entity extraction: AI_WORKER.chat() call failed", error);
    return emptyResult();
  }
}
