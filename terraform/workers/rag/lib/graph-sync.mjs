// Syncs entities/relations extracted from an ingested document (see
// lib/entity-extraction.mjs) into the graph-worker over a Service Binding RPC
// call, as the "svc-rag-enrichment" service actor (see docs/decisions/0015).
// upsertNode() on the graph-worker side already dedups by (type, label), so
// re-ingesting the same document is idempotent on the node side; edge
// idempotency is handled here by treating a duplicate-edge conflict as a
// silent success instead of an error.

// NOTE (unverified assumption, see docs/decisions/0015): graph-worker's
// ConflictError (lib/graph-db.mjs) never overrides `Error.prototype.name`, so
// even in-process `error.name` is "Error", not "ConflictError" -- and
// `instanceof ConflictError` cannot work across a Service Binding call in the
// first place, since the RPC boundary crosses into a different module/class
// realm. This has not been validated against a real workerd deploy. The only
// signal that plausibly survives RPC error serialization is the message
// string, so conflict detection here matches on message text rather than on
// `instanceof`/`.status`, per the roadmap's own risk note.
export function isConflictError(error) {
  return typeof error?.message === "string" && /already exists/i.test(error.message);
}

export async function syncEntitiesToGraph(graphWorkerBinding, graphId, documentId, { entities, relations }) {
  if (!graphWorkerBinding) {
    console.error("graph sync: GRAPH_WORKER binding not configured");
    return;
  }

  const nodeIds = {};
  for (const entity of entities) {
    const node = await graphWorkerBinding.upsertNode(graphId, "svc-rag-enrichment", {
      type: entity.type,
      label: entity.label,
      source_document_id: documentId,
    });
    nodeIds[entity.label] = node.id;
  }

  for (const relation of relations) {
    const fromId = nodeIds[relation.from];
    const toId = nodeIds[relation.to];
    if (!fromId || !toId) {
      // Relation referencing an entity the extractor didn't also return in this
      // same response -- nothing to link, discard rather than guess.
      continue;
    }

    try {
      await graphWorkerBinding.createEdge(graphId, "svc-rag-enrichment", {
        from_node_id: fromId,
        to_node_id: toId,
        relation: relation.relation,
      });
    } catch (error) {
      if (!isConflictError(error)) {
        throw error;
      }
      // Edge already exists (UNIQUE from_node_id/to_node_id/relation) -- reingestion
      // idempotency, not an error.
    }
  }
}
