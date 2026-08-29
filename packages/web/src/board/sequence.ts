import type { Workspace } from "@lucent/core";

/**
 * Derive a sequence diagram from the semantic graph (docs/15 Phase D). Actors
 * are the nodes; messages are the edges, ordered by a topological-ish walk from
 * source nodes so the flow reads top-to-bottom. Pure: graph in, sequence model
 * out — no DOM, unit-testable.
 */
export interface SequenceActor {
  id: string;
  label: string;
  x: number;
}
export interface SequenceMessage {
  from: string;
  to: string;
  label: string;
  y: number;
  kind: "sync" | "return";
}
export interface SequenceModel {
  actors: SequenceActor[];
  messages: SequenceMessage[];
}

const ACTOR_GAP = 180;
const ACTOR_X0 = 160;
const MSG_Y0 = 160;
const MSG_GAP = 50;

export function toSequence(ws: Workspace): SequenceModel {
  const nodes = Object.values(ws.nodes);
  const edges = Object.values(ws.edges);

  // Order actors by a breadth-first walk from nodes with no incoming edges, so
  // the leftmost actor is an entry point. Fall back to insertion order.
  const indeg = new Map<string, number>();
  for (const n of nodes) indeg.set(n.id, 0);
  for (const e of edges)
    if (indeg.has(e.target)) indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);

  const order: string[] = [];
  const seen = new Set<string>();
  const queue = nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id);
  const outByNode = new Map<string, string[]>();
  for (const e of edges) {
    if (!outByNode.has(e.source)) outByNode.set(e.source, []);
    outByNode.get(e.source)!.push(e.target);
  }
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    order.push(id);
    for (const t of outByNode.get(id) ?? []) if (!seen.has(t)) queue.push(t);
  }
  for (const n of nodes) if (!seen.has(n.id)) order.push(n.id);

  const actorX = new Map<string, number>();
  const actors: SequenceActor[] = order.map((id, i) => {
    const x = ACTOR_X0 + i * ACTOR_GAP;
    actorX.set(id, x);
    return { id, label: ws.nodes[id]?.label ?? id, x };
  });

  // Messages follow the same BFS edge order so the vertical flow matches.
  const messages: SequenceMessage[] = edges.map((e, i) => {
    const forward = (actorX.get(e.source) ?? 0) <= (actorX.get(e.target) ?? 0);
    return {
      from: e.source,
      to: e.target,
      label: e.relationship,
      y: MSG_Y0 + i * MSG_GAP,
      kind: forward ? "sync" : "return",
    };
  });

  return { actors, messages };
}
