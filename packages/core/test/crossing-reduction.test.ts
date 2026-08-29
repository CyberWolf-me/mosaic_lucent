import { describe, it, expect } from "vitest";
import { applyOperations, createWorkspace, computeLayout, type Operation } from "../src/index.js";

/**
 * Layered layout used raw insertion order within each layer, so a node's parents
 * could sit at the far end of the previous row and its edge cut across every
 * sibling. That tangle is the most visible defect in an AI-generated diagram.
 * These tests count real crossings rather than asserting exact coordinates, so
 * the ordering heuristic can improve without breaking them.
 */
function board(nodes: string[], edges: Array<[string, string]>) {
  const ws = createWorkspace({ diagramKind: "flowchart" });
  const ops: Operation[] = nodes.map((id) => ({
    op: "CREATE_NODE" as const,
    id,
    nodeType: "process",
    label: id,
  }));
  for (const [s, t] of edges) {
    ops.push({ op: "CONNECT_NODES", source: s, target: t, relationship: "next" });
  }
  return applyOperations(ws, ops);
}

/** Count pairs of edges whose straight segments cross between two layers. */
function countCrossings(
  layout: Record<string, { position: { x: number; y: number } }>,
  edges: Array<[string, string]>,
): number {
  let crossings = 0;
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const [a1, a2] = edges[i]!;
      const [b1, b2] = edges[j]!;
      const p = layout[a1],
        q = layout[a2],
        r = layout[b1],
        s = layout[b2];
      if (!p || !q || !r || !s) continue;
      // Only compare edges spanning the same layer pair (same source/target y).
      if (p.position.y !== r.position.y || q.position.y !== s.position.y) continue;
      const topOrder = Math.sign(p.position.x - r.position.x);
      const bottomOrder = Math.sign(q.position.x - s.position.x);
      if (topOrder !== 0 && bottomOrder !== 0 && topOrder !== bottomOrder) crossings++;
    }
  }
  return crossings;
}

describe("layered layout crossing reduction", () => {
  it("untangles a deliberately reversed bipartite graph", () => {
    // a,b,c feed z,y,x respectively — declaration order guarantees crossings
    // unless the layer is reordered.
    const nodes = ["a", "b", "c", "x", "y", "z"];
    const edges: Array<[string, string]> = [
      ["a", "z"],
      ["b", "y"],
      ["c", "x"],
    ];
    const layout = computeLayout(board(nodes, edges), { direction: "vertical" });
    expect(countCrossings(layout, edges)).toBe(0);
  });

  it("keeps a already-ordered graph crossing-free", () => {
    const nodes = ["a", "b", "c", "x", "y", "z"];
    const edges: Array<[string, string]> = [
      ["a", "x"],
      ["b", "y"],
      ["c", "z"],
    ];
    const layout = computeLayout(board(nodes, edges), { direction: "vertical" });
    expect(countCrossings(layout, edges)).toBe(0);
  });

  it("places every node exactly once and on its own layer row", () => {
    const nodes = ["a", "b", "c", "x", "y", "z"];
    const edges: Array<[string, string]> = [
      ["a", "z"],
      ["b", "y"],
      ["c", "x"],
    ];
    const layout = computeLayout(board(nodes, edges), { direction: "vertical" });
    expect(Object.keys(layout).sort()).toEqual([...nodes].sort());
    // Sources share one y, targets another.
    const ys = new Set(nodes.map((n) => layout[n]!.position.y));
    expect(ys.size).toBe(2);
  });

  it("is deterministic across runs", () => {
    const nodes = ["a", "b", "c", "d", "w", "x", "y", "z"];
    const edges: Array<[string, string]> = [
      ["a", "z"],
      ["b", "y"],
      ["c", "x"],
      ["d", "w"],
    ];
    const ws = board(nodes, edges);
    const first = computeLayout(ws, { direction: "vertical" });
    const second = computeLayout(ws, { direction: "vertical" });
    expect(second).toEqual(first);
  });

  it("handles a node with several parents without throwing", () => {
    const nodes = ["a", "b", "c", "hub"];
    const edges: Array<[string, string]> = [
      ["a", "hub"],
      ["b", "hub"],
      ["c", "hub"],
    ];
    const layout = computeLayout(board(nodes, edges), { direction: "vertical" });
    // The hub should sit near the mean x of its parents.
    const parentXs = ["a", "b", "c"].map((n) => layout[n]!.position.x);
    const mean = parentXs.reduce((p, q) => p + q, 0) / parentXs.length;
    expect(Math.abs(layout.hub!.position.x - mean)).toBeLessThan(200);
  });

  it("still lays out a cyclic graph", () => {
    const nodes = ["a", "b", "c"];
    const edges: Array<[string, string]> = [
      ["a", "b"],
      ["b", "c"],
      ["c", "a"],
    ];
    const layout = computeLayout(board(nodes, edges), { direction: "vertical" });
    expect(Object.keys(layout)).toHaveLength(3);
  });
});
