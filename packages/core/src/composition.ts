/**
 * COMPOSITION DERIVATION (V1, the 2026-09 review's "AI diagram composition"
 * answered deterministically): read the composition a board ALREADY has —
 * its main subject, primary flow, clusters, and emphasis candidates — as a
 * pure function of the workspace. This is the reading half of composition
 * intent: the AI still constructs by emitting operations (the non-negotiable
 * rule holds), and this layer derives the structure that lets the overview
 * and the AI explanation path NAME what the board is about ("the main story
 * is X: A → B → C, in three clusters").
 *
 * Deliberately NOT here: emitting coordinates (never), writing composition
 * back into the model, or any prompt-side behaviour — those are separate
 * decisions with their own gates.
 */

import type { Workspace } from "./model.js";

export interface Composition {
  /**
   * The board's main subject: the highest-degree node (in + out edges),
 * tie-broken by declaration order. A board with no edges has no subject.
   */
  mainSubject: string | null;
  /**
   * The primary flow: the longest deterministic chain through the main
   * subject (greedy walk: always the first-created outgoing edge, then the
   * first-created incoming continuation backwards when the subject is not a
   * source). Single ids, source→target order.
   */
  primaryFlow: string[];
  /** Cluster labels: kind-regions (groups with a kind) in declaration order. */
  clusters: Array<{ id: string; label: string; memberCount: number }>;
  /** Node counts the explanation surfaces want. */
  stats: { nodes: number; edges: number; groups: number };
}

/**
 * Derive a board's composition. Pure and cheap (single pass over nodes and
 * edges), so the overview can call it on every render and the AI-explain
 * path can embed it in the board summary.
 */
export function deriveComposition(workspace: Workspace): Composition {
  const nodes = Object.values(workspace.nodes);
  const edges = Object.values(workspace.edges);

  // Degree (in + out) per node, first-edge-wins for deterministic ties.
  const degree = new Map<string, number>();
  const firstOut = new Map<string, string[]>();
  for (const edge of edges) {
    if (!workspace.nodes[edge.source] || !workspace.nodes[edge.target]) continue;
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
    const outs = firstOut.get(edge.source) ?? [];
    outs.push(edge.target);
    firstOut.set(edge.source, outs);
  }

  // Main subject: highest degree; ties keep the earlier-declared node.
  let mainSubject: string | null = null;
  let bestDegree = -1;
  for (const node of nodes) {
    const d = degree.get(node.id) ?? 0;
    if (d > bestDegree) {
      bestDegree = d;
      mainSubject = node.id;
    }
  }

  // Primary flow: from the subject, walk the FIRST outgoing edge repeatedly
  // (no revisits) — the forward spine. A SINK subject (no outgoing edges)
  // walks backwards first, by the first incoming edge, so the flow starts
  // at its chain head instead of mid-chain.
  const flow: string[] = [];
  if (mainSubject) {
    const seen = new Set<string>();
    let head = mainSubject;
    if ((firstOut.get(mainSubject) ?? []).length === 0) {
      // Sink: walk backwards to the head. `seen` guards the cycle case.
      seen.add(head);
      for (let guard = 0; guard < nodes.length + 1; guard++) {
        const parent = edges.find(
          (e) =>
            e.target === head &&
            workspace.nodes[e.source] &&
            !seen.has(e.source) &&
            e.source !== head,
        )?.source;
        if (!parent) break;
        seen.add(parent);
        head = parent;
      }
      seen.clear();
    }
    let cursor: string | null = head;
    while (cursor && !seen.has(cursor) && flow.length <= nodes.length) {
      seen.add(cursor);
      flow.push(cursor);
      cursor = (firstOut.get(cursor) ?? []).find((t) => !seen.has(t)) ?? null;
    }
  }

  // Clusters: kind-regions only (plain groups are visual containers, not
  // composition).
  const clusters = Object.values(workspace.groups)
    .filter((g) => g.kind)
    .map((g) => ({
      id: g.id,
      label: g.label,
      memberCount: g.children.filter((id) => workspace.nodes[id]).length,
    }));

  return {
    mainSubject,
    primaryFlow: flow,
    clusters,
    stats: {
      nodes: nodes.length,
      edges: edges.length,
      groups: Object.keys(workspace.groups).length,
    },
  };
}

/**
 * One-line composition summary for the AI explanation path and the overview
 * ("The main story: Checkout → Payments → Ledger, across 3 clusters").
 * Empty board: an empty string, so callers append nothing.
 */
export function compositionLine(workspace: Workspace): string {
  const c = deriveComposition(workspace);
  if (!c.mainSubject) return "";
  const subjectLabel = workspace.nodes[c.mainSubject]?.label ?? c.mainSubject;
  const flowLabels = c.primaryFlow
    .slice(0, 5)
    .map((id) => workspace.nodes[id]?.label ?? id);
  const parts: string[] = [];
  if (flowLabels.length > 1) {
    parts.push(`The main story: ${flowLabels.join(" → ")}`);
  } else {
    parts.push(`Central node: ${subjectLabel}`);
  }
  if (c.clusters.length > 0) {
    parts.push(
      `${c.clusters.length} region${c.clusters.length === 1 ? "" : "s"} (${c.clusters
        .slice(0, 3)
        .map((cl) => cl.label)
        .join(", ")})`,
    );
  }
  return parts.join(" · ");
}
