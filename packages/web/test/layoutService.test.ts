/**
 * The layout service, pinned (doc 18 Phase 4, ADR 0039): kind-based routing,
 * failure fallback with retained geometry, and the spatial-additivity
 * invariant through the ELK region path — the "add one node, the rest of the
 * board holds still" acceptance, expressed the way Lucent actually commits
 * (scoped to a region).
 */

import { describe, expect, it } from "vitest";
import {
  applyLayout,
  applyRoutes,
  createWorkspace,
  layeredBoard,
  mixedRegionBoard,
  swimlaneBoard,
  type DiagramLayoutEngine,
  type Workspace,
} from "@lucent/core";
import { ELK_LAYOUT_ENGINE } from "../src/diagram/elk/index.js";
import { elkEligible, layoutBoard, relayoutRegionScoped } from "../src/diagram/layoutService.js";

/** A flowchart region of `n` members plus `k` ungrouped flow nodes. */
function regionBoard(n: number, k: number): Workspace {
  const ws = createWorkspace({ id: "svc-region", name: "Region", diagramKind: "flowchart" });
  const children: string[] = [];
  for (let i = 0; i < n; i++) {
    const node = { id: `r-${String(i).padStart(3, "0")}`, nodeType: "service", label: `Step ${i}` };
    ws.nodes[node.id] = { ...node, groupId: "region-main" };
    children.push(node.id);
    if (i > 0) {
      ws.edges[`e-r-${i}`] = {
        id: `e-r-${i}`,
        source: `r-${String(i - 1).padStart(3, "0")}`,
        target: node.id,
        relationship: "calls",
      };
    }
  }
  ws.groups["region-main"] = { id: "region-main", label: "Main", children, kind: "flowchart" };
  let prev: string | null = null;
  for (let i = 0; i < k; i++) {
    const node = { id: `f-${i}`, nodeType: "step", label: `Flow ${i}` };
    ws.nodes[node.id] = node;
    if (prev) ws.edges[`e-f-${i}`] = { id: `e-f-${i}`, source: prev, target: node.id, relationship: "then" };
    prev = node.id;
  }
  return ws;
}

const throwing: DiagramLayoutEngine = {
  id: "test-throwing",
  supports: () => true,
  layout: () => {
    throw new Error("engine exploded");
  },
};

describe("layout service routing (ADR 0039)", () => {
  it("routes flat flowchart boards to ELK", async () => {
    const outcome = await layoutBoard(layeredBoard(40));
    expect(outcome.engineId).toBe("elk-0.12");
    expect(outcome.degraded).toBe(false);
  });

  it("routes mixed-region and process boards to the built-in engines", async () => {
    expect(elkEligible(mixedRegionBoard(40))).toBe(false);
    expect(elkEligible(swimlaneBoard(40))).toBe(false);
    const mixed = await layoutBoard(mixedRegionBoard(40));
    expect(mixed.engineId).toBe("lucent-current");
  });

  it("a foreign-kind region makes an otherwise-ELK board ineligible", () => {
    const ws = layeredBoard(40);
    ws.groups["g-mind"] = {
      id: "g-mind",
      label: "Mind",
      children: [],
      kind: "mindmap",
    };
    expect(elkEligible(ws)).toBe(false);
  });

  it("falls back to the built-in engine when the primary throws", async () => {
    const outcome = await layoutBoard(layeredBoard(40), {}, { primary: throwing });
    expect(outcome.engineId).toBe("lucent-current");
    expect(outcome.degraded).toBe(false);
  });

  it("retains the previous geometry, degraded, when every engine fails", async () => {
    const ws = layeredBoard(40);
    const outcome = await layoutBoard(ws, {}, { primary: throwing, fallback: throwing });
    expect(outcome.engineId).toBeNull();
    expect(outcome.degraded).toBe(true);
    expect(outcome.workspace).toBe(ws); // geometry retained, not blanked
  });
});

describe("the spatial-additivity invariant through ELK (Phase 4)", () => {
  it("the advisory's 100+1 test, scoped: outside nodes are pixel-identical", async () => {
    // 100-node flowchart region + 3 ungrouped nodes. Stamp geometry with the
    // ELK engine first (the committed board), then add ONE node inside the
    // region and re-run the scoped path. Everything outside the region must
    // be pixel-identical — by contract, and now by test.
    const ws = regionBoard(100, 3);
    const first = await ELK_LAYOUT_ENGINE.layout({ workspace: ws, options: {} });
    const committed = applyRoutes(applyLayout(ws, first.layout), first.routes);

    const probe = {
      id: "probe-added-node",
      nodeType: "service",
      label: "Added step",
      groupId: "region-main",
    };
    const edited: Workspace = {
      ...committed,
      nodes: { ...committed.nodes, [probe.id]: probe },
      edges: {
        ...committed.edges,
        "e-probe": {
          id: "e-probe",
          source: "r-099",
          target: probe.id,
          relationship: "calls",
        },
      },
    };

    const outcome = await relayoutRegionScoped(edited, "region-main");
    expect(outcome.degraded).toBe(false);
    expect(outcome.engineId).toBe("elk-0.12");

    const before = committed.nodes;
    const after = outcome.workspace.nodes;
    for (const id of ["f-0", "f-1", "f-2"]) {
      expect(after[id]!.position).toEqual(before[id]!.position);
    }
    // The region itself re-laid out and the probe landed inside it.
    expect(after["probe-added-node"]!.position).toBeTruthy();
  });

  it("a non-ELK region routes to the built-in engine, outside nodes held", async () => {
    const ws = mixedRegionBoard(80);
    const stamped = applyRoutes(
      applyLayout(ws, (await import("@lucent/core")).computeLayout(ws)),
      (await import("@lucent/core")).computeLayoutWithRoutes(ws).routes,
    );
    const outcome = await relayoutRegionScoped(stamped, "region-mind");
    expect(outcome.engineId).toBe("lucent-current");
    const before = stamped.nodes;
    const after = outcome.workspace.nodes;
    for (const [id, node] of Object.entries(before)) {
      if (node.groupId === "region-mind") continue;
      expect(after[id]!.position).toEqual(node.position!);
    }
  });

  it("falls back to the built-in region pass when the ELK region throws", async () => {
    const ws = regionBoard(20, 2);
    const stamped = applyRoutes(
      applyLayout(ws, (await import("@lucent/core")).computeLayout(ws)),
      (await import("@lucent/core")).computeLayoutWithRoutes(ws).routes,
    );
    const outcome = await relayoutRegionScoped(stamped, "region-main", {}, { primary: throwing });
    expect(outcome.engineId).toBe("lucent-current");
    expect(outcome.degraded).toBe(false);
  });
});
