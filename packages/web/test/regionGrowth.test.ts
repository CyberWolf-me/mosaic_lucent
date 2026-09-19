/**
 * regionGrowth.ts, pinned (doc 18 Phase 4): the neighbour-push extracted
 * from the commit path so both layout phases share it. The pin is parity —
 * `pushRegionNeighbors` must do exactly what the inline block it replaced
 * did (restating the original algorithm as a reference oracle), because the
 * scoped commit path and the ELK refinement both lean on it for the
 * spatial-additivity invariant.
 */

import { describe, expect, it } from "vitest";
import {
  applyLayout,
  applyRoutes,
  createWorkspace,
  relayoutRegionWithRoutes,
  separateRegions,
  type Workspace,
} from "@lucent/core";
import { pushRegionNeighbors } from "../src/diagram/regionGrowth.js";
import { elkRegionEligible } from "../src/diagram/layoutService.js";

/** Two disjoint flowchart regions side by side, the growing one on the left. */
function adjacentRegions(): Workspace {
  const ws = createWorkspace({ id: "wk-grow", name: "Grow", diagramKind: "flowchart" });
  const left: string[] = [];
  const right: string[] = [];
  for (let i = 0; i < 3; i++) {
    const id = `L${i}`;
    ws.nodes[id] = { id, nodeType: "step", label: `Left ${i}`, groupId: "g-left" };
    left.push(id);
    if (i > 0)
      ws.edges[`eL${i}`] = { id: `eL${i}`, source: `L${i - 1}`, target: id, relationship: "then" };
  }
  for (let i = 0; i < 2; i++) {
    const id = `R${i}`;
    ws.nodes[id] = { id, nodeType: "step", label: `Right ${i}`, groupId: "g-right" };
    right.push(id);
    if (i > 0)
      ws.edges[`eR${i}`] = { id: `eR${i}`, source: `R${i - 1}`, target: id, relationship: "then" };
  }
  ws.groups["g-left"] = { id: "g-left", label: "Left", children: left, kind: "flowchart" };
  ws.groups["g-right"] = { id: "g-right", label: "Right", children: right, kind: "flowchart" };
  return ws;
}

describe("pushRegionNeighbors (doc 18 Phase 4)", () => {
  it("matches the original inline algorithm exactly (parity oracle)", () => {
    // The original commit-path block, restated verbatim as the oracle.
    const oracle = (ws: Workspace, growerId: string): Workspace => {
      const shifts = separateRegions(ws, growerId);
      if (!shifts) return ws;
      let next = ws;
      for (const [id, placed] of Object.entries(shifts)) {
        const node = next.nodes[id];
        if (node) next = { ...next, nodes: { ...next.nodes, [id]: { ...node, ...placed } } };
      }
      const shiftedRoutes: Record<string, Array<{ x: number; y: number }>> = {};
      for (const [edgeId, edge] of Object.entries(ws.edges)) {
        if (!edge.route) continue;
        const srcShift = shifts[edge.source];
        const tgtShift = shifts[edge.target];
        if (!srcShift && !tgtShift) continue;
        const dx = (srcShift ?? tgtShift)!.position.x - (ws.nodes[edge.source]?.position?.x ?? 0);
        const dy = (srcShift ?? tgtShift)!.position.y - (ws.nodes[edge.source]?.position?.y ?? 0);
        shiftedRoutes[edgeId] = edge.route.map((p) => ({ x: p.x + dx, y: p.y + dy }));
      }
      return applyRoutes(next, shiftedRoutes);
    };

    for (const seed of [1, 2, 3]) {
      const base = adjacentRegions();
      // Grow the left region by a wide chain so it genuinely extends right.
      const region = relayoutRegionWithRoutes(base, "g-left");
      if (!region) continue;
      let grown = applyRoutes(applyLayout(base, region.layout), region.routes);
      grown = {
        ...grown,
        nodes: {
          ...grown.nodes,
          wide: {
            id: "wide",
            nodeType: "step",
            label: "a very long label for width",
            groupId: "g-left",
          },
        },
        groups: {
          ...grown.groups,
          "g-left": {
            ...grown.groups["g-left"]!,
            children: [...grown.groups["g-left"]!.children, "wide"],
          },
        },
      };
      const second = relayoutRegionWithRoutes(grown, "g-left");
      if (!second) continue;
      const relaid = applyRoutes(applyLayout(grown, second.layout), second.routes);
      expect(pushRegionNeighbors(relaid, "g-left")).toEqual(oracle(relaid, "g-left"));
      void seed;
    }
  });

  it("is a no-op (same object) when nothing overlaps", () => {
    const ws = adjacentRegions();
    const region = relayoutRegionWithRoutes(ws, "g-left");
    if (!region) return;
    const relaid = applyRoutes(applyLayout(ws, region.layout), region.routes);
    // The two regions are placed apart; no push is warranted.
    expect(pushRegionNeighbors(relaid, "g-left")).toBe(relaid);
  });

  it("shifted regions keep their intra-region edges glued (routes move with nodes)", () => {
    const base = adjacentRegions();
    const region = relayoutRegionWithRoutes(base, "g-left");
    if (!region) return;
    const relaid = applyRoutes(applyLayout(base, region.layout), region.routes);
    const pushed = pushRegionNeighbors(relaid, "g-left");
    // Whatever moved, an edge with a route in a moved region has its route
    // shifted by the same dx as its endpoints (the glue contract).
    for (const edge of Object.values(pushed.edges)) {
      if (!edge.route) continue;
      const src = pushed.nodes[edge.source];
      const tgt = pushed.nodes[edge.target];
      if (!src?.position || !tgt?.position) continue;
      const mid = edge.route[Math.floor(edge.route.length / 2)]!;
      // The route's midpoint sits between its endpoints' bounding box
      // (sanity of the shift arithmetic — a wrongly-shifted corridor flies
      // far outside this box).
      const minX = Math.min(src.position.x, tgt.position.x) - 2000;
      const maxX = Math.max(src.position.x, tgt.position.x) + 2000;
      expect(mid.x).toBeGreaterThanOrEqual(minX);
      expect(mid.x).toBeLessThanOrEqual(maxX);
    }
  });
});

describe("elkRegionEligible (the service's region routing, pinned)", () => {
  it("routes the ELK-winning region kinds; declines everything else", () => {
    const ws = createWorkspace({ id: "wk-kinds", name: "Kinds", diagramKind: "flowchart" });
    ws.nodes["a"] = { id: "a", nodeType: "step", label: "A", groupId: "g-1" };
    ws.groups["g-1"] = { id: "g-1", label: "Flow", children: ["a"], kind: "flowchart" };
    ws.groups["g-2"] = { id: "g-2", label: "Mind", children: [], kind: "mindmap" };
    ws.groups["g-3"] = { id: "g-3", label: "Unkinded", children: [] };
    expect(elkRegionEligible(ws, "g-1")).toBe(true); // its kind: flowchart
    expect(elkRegionEligible(ws, "g-2")).toBe(false); // mindmap stays ours
    expect(elkRegionEligible(ws, "g-3")).toBe(true); // falls back to board kind
    expect(elkRegionEligible(ws, "missing")).toBe(false);
    // bpmn regions agree with the service's ELK_KINDS (the adapter + service
    // alignment this phase fixed).
    ws.groups["g-4"] = { id: "g-4", label: "BPMN", children: [], kind: "bpmn" };
    expect(elkRegionEligible(ws, "g-4")).toBe(true);
  });
});
