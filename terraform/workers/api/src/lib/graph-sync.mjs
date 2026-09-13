import { getIngredientById } from "./ingredients-db.mjs";

// Domain convention for the "ingredients" knowledge graph (documented further
// by doc-dev): a fixed graph id, a dedicated service actor for the ACL check
// on the RPC path (graph-worker's requireRole()), and one node per ingredient
// keyed by (type, label) where label is the ingredient's `nome`. The graph
// node keeps `properties.ingredientId` pointing back at the api-worker's row,
// which is how recommendations are mapped back to full ingredient records.
export const GRAPH_ID = "ingredients";
export const GRAPH_ACTOR_SUB = "svc-api-ingredients";
export const NODE_TYPE = "ingredient";

function toNodeProperties(ingredient) {
  return { ingredientId: ingredient.id };
}

// Best-effort, fire-and-forget graph sync: never awaited by the caller, always
// wrapped so a GRAPH_WORKER failure (binding missing, graph-worker down, ACL
// rejection, etc) never affects the api-worker's HTTP response. Call sites
// gate on `env.GRAPH_WORKER` before scheduling via `ctx.waitUntil()`.

export function syncIngredientCreated(env, ctx, ingredient) {
  if (!env.GRAPH_WORKER || !ctx) return;

  ctx.waitUntil(
    env.GRAPH_WORKER
      .upsertNode(GRAPH_ID, GRAPH_ACTOR_SUB, {
        type: NODE_TYPE,
        label: ingredient.nome,
        properties: toNodeProperties(ingredient),
      })
      .catch((err) => console.error("graph sync (create) failed", err)),
  );
}

// Node lookup is keyed by label, and label tracks `nome`, which is exactly
// the field a rename changes -- so a rename must be resolved by looking up
// the *pre-update* label (`before.nome`), not the new one. If no node is
// found (e.g. the ingredient was created before this sync existed, or a
// previous create-sync failed), self-heal by creating it instead of no-op'ing.
export function syncIngredientUpdated(env, ctx, before, after) {
  if (!env.GRAPH_WORKER || !ctx || !before) return;

  ctx.waitUntil(
    (async () => {
      const node = await env.GRAPH_WORKER.findNodeByLabel(GRAPH_ID, GRAPH_ACTOR_SUB, NODE_TYPE, before.nome);

      if (!node) {
        await env.GRAPH_WORKER.upsertNode(GRAPH_ID, GRAPH_ACTOR_SUB, {
          type: NODE_TYPE,
          label: after.nome,
          properties: toNodeProperties(after),
        });
        return;
      }

      await env.GRAPH_WORKER.updateNode(GRAPH_ID, GRAPH_ACTOR_SUB, node.id, {
        label: after.nome,
        properties: toNodeProperties(after),
      });
    })().catch((err) => console.error("graph sync (update) failed", err)),
  );
}

export function syncIngredientDeleted(env, ctx, ingredient) {
  if (!env.GRAPH_WORKER || !ctx) return;

  ctx.waitUntil(
    (async () => {
      const node = await env.GRAPH_WORKER.findNodeByLabel(GRAPH_ID, GRAPH_ACTOR_SUB, NODE_TYPE, ingredient.nome);
      if (!node) return;

      await env.GRAPH_WORKER.deleteNode(GRAPH_ID, GRAPH_ACTOR_SUB, node.id);
    })().catch((err) => console.error("graph sync (delete) failed", err)),
  );
}

// Resolves an ingredient's graph node the same way the sync helpers above
// key it: (graphId "ingredients", type "ingredient", label = nome). Used by
// the /recommendations endpoint. Returns null if the ingredient was never
// synced to the graph (e.g. created before GRAPH_WORKER existed, or a
// create-sync failed) -- callers should treat that as "no recommendations
// yet", not as an error.
export async function resolveIngredientNode(env, ingredient) {
  return env.GRAPH_WORKER.findNodeByLabel(GRAPH_ID, GRAPH_ACTOR_SUB, NODE_TYPE, ingredient.nome);
}

// Maps a graph node back to a full ingredient record via
// `properties.ingredientId` + a D1 lookup. Falls back to the bare node
// identity (`nodeId`/`label`) when the property is missing or the ingredient
// no longer exists in D1 (e.g. deleted without the graph node being cleaned
// up yet) -- a full recommendation is nice-to-have, not a hard requirement.
export async function enrichGraphNode(env, node) {
  const ingredientId = node?.properties?.ingredientId;
  if (!ingredientId) {
    return { nodeId: node.id, label: node.label };
  }

  const ingredient = await getIngredientById(env.INGREDIENTS_DB, ingredientId);
  if (!ingredient) {
    return { nodeId: node.id, label: node.label };
  }

  return { nodeId: node.id, label: node.label, ingredient };
}
