/**
 * Layout intent's DETERMINISTIC consumption (doc 18, Phase 5): direction
 * re-flows the board, the primaryFlow spine changes layered ordering, and
 * emphasis promotes edges out of the secondary tier. Every test pins that
 * the same intent yields the same geometry — "intent hints change layout
 * deterministically" is the phase's acceptance line.
 */

import { describe, expect, it } from "vitest";
import {
  applyLayout,
  applyOperations,
  applyRoutes,
  computeLayoutWithRoutes,
  createWorkspace,
  edgeTier,
  edgeTiers,
  type Operation,
  type Workspace,
} from "../src/index.js";

function diamond(): Workspace {
  const ws = createWorkspace();
  const ops: Operation[] = [];
  for (const id of ["a", "b", "c", "d", "e"]) {
    ops.push({ op: "CREATE_NODE", id, nodeType: "step", label: id.toUpperCase() });
  }
  for (const [s, t] of [
    ["a", "b"],
    ["a", "c"],
    ["b", "d"],
    ["c", "d"],
    ["b", "c"],
  ] as const) {
    ops.push({ op: "CONNECT_NODES", source: s, target: t, relationship: "then" });
  }
  return applyOperations(ws, ops);
}

describe("intent direction — the engine's default flow axis", () => {
  it("horizontal intent flows left→right; absent intent stays vertical", () => {
    const base = diamond();
    const vOut = computeLayoutWithRoutes(base);
    const v = applyLayout(base, vOut.layout);
    // Vertical: layers advance downward, so b/c sit BELOW a.
    expect(v.nodes.b!.position!.y).toBeGreaterThan(v.nodes.a!.position!.y);

    const h = applyOperations(base, [{ op: "SET_LAYOUT_INTENT", direction: "horizontal" }]);
    const hOut = computeLayoutWithRoutes(h);
    const hp = applyLayout(h, hOut.layout);
    // Horizontal: layers advance rightward; cross positions center on 0
    // exactly like the vertical run's x (a.x = -184 there), so only the
    // relative assertion below is meaningful.
    expect(hp.nodes.b!.position!.x).toBeGreaterThan(hp.nodes.a!.position!.x);
  });

  it("an explicit option still outranks the stored intent", () => {
    const h = applyOperations(diamond(), [{ op: "SET_LAYOUT_INTENT", direction: "horizontal" }]);
    const forced = applyLayout(h, computeLayoutWithRoutes(h, { direction: "vertical" }).layout);
    expect(forced.nodes.b!.position!.y).toBeGreaterThan(forced.nodes.a!.position!.y);
  });

  it("deterministic: the same intent yields byte-identical geometry twice", () => {
    const ws = applyOperations(diamond(), [
      { op: "SET_LAYOUT_INTENT", direction: "horizontal", primaryFlow: ["a", "b", "d"] },
    ]);
    const r1 = computeLayoutWithRoutes(ws);
    const r2 = computeLayoutWithRoutes(ws);
    expect(r1).toEqual(r2);
  });
});

describe("primaryFlow spine — ordering bias, deterministically", () => {
  /**
   * A two-branch board where the cross-axis ordering is otherwise arbitrary:
   * layers 0→1→2 with two nodes per middle layer. Stating a spine through
   * one branch pulls that branch's nodes to one shared side across both
   * sweeps. Pinned by ordering, not exact pixels (the invariant is the
   * SPINE's relative positions, which stays true under gap changes).
   */
  function branches(): Workspace {
    const ws = createWorkspace();
    const ops: Operation[] = [];
    for (const id of ["start", "l1", "l2", "r1", "r2", "end"]) {
      ops.push({ op: "CREATE_NODE", id, nodeType: "step", label: id });
    }
    for (const [s, t] of [
      ["start", "l1"],
      ["start", "r1"],
      ["l1", "l2"],
      ["r1", "r2"],
      ["l2", "end"],
      ["r2", "end"],
      // Cross edges give the middle layers real ordering pressure.
      ["start", "r2"],
      ["l1", "r2"],
    ] as const) {
      ops.push({ op: "CONNECT_NODES", source: s, target: t, relationship: "then" });
    }
    return applyOperations(ws, ops);
  }

  it("the spine's nodes share one cross-axis side across layers", () => {
    const ws = applyOperations(branches(), [
      { op: "SET_LAYOUT_INTENT", primaryFlow: ["start", "r1", "r2", "end"] },
    ]);
    const placed = applyLayout(ws, computeLayoutWithRoutes(ws).layout);
    const rs = placed.nodes.r1!.position!.x;
    const rr = placed.nodes.r2!.position!.x;
    // Both spine middle nodes sit on the SAME side (both right of the
    // left-branch sibling in their layer): the virtual hops pulled the
    // corridor straight.
    expect(rs).toBeGreaterThan(placed.nodes.l1!.position!.x);
    expect(rr).toBeGreaterThan(placed.nodes.l2!.position!.x);
  });

  it("same board + same spine twice → identical positions (sweeps are deterministic)", () => {
    const ws = applyOperations(branches(), [
      { op: "SET_LAYOUT_INTENT", primaryFlow: ["start", "r1", "r2", "end"] },
    ]);
    const a = applyLayout(ws, computeLayoutWithRoutes(ws).layout);
    const b = applyLayout(ws, computeLayoutWithRoutes(ws).layout);
    expect(a.nodes).toEqual(b.nodes);
  });

  it("an unknown-id-free empty spine is a no-op vs no intent (backward compat)", () => {
    const plain = branches();
    const stated = applyOperations(plain, [{ op: "SET_LAYOUT_INTENT" }]);
    // {} clears the intent — the layout equals the plain board's.
    const a = applyLayout(plain, computeLayoutWithRoutes(plain).layout);
    const b = applyLayout(stated, computeLayoutWithRoutes(stated).layout);
    expect(a.nodes).toEqual(b.nodes);
  });
});

describe("emphasis — tier promotion, geometry untouched", () => {
  /** The diamond with a spanning a→d edge, laid out and routed. */
  function routedDiamond(): Workspace {
    const ws = applyOperations(diamond(), [
      { op: "CONNECT_NODES", source: "a", target: "d", relationship: "then" },
    ]);
    const { layout, routes } = computeLayoutWithRoutes(ws);
    return applyRoutes(applyLayout(ws, layout), routes);
  }

  const spanningEdge = (ws: Workspace) =>
    Object.values(ws.edges).find((e) => e.source === "a" && e.target === "d")!;

  it("an emphasized node's secondary edge becomes primary", () => {
    const ws = routedDiamond();
    const edge = spanningEdge(ws);
    // Unemphasized: the spanning edge is secondary (it carries a route).
    expect(edge.route && edge.route.length > 0).toBe(true);
    expect(edgeTier(ws, edge)).toBe("secondary");

    const emphasized = applyOperations(ws, [{ op: "SET_LAYOUT_INTENT", emphasis: ["d"] }]);
    expect(edgeTier(emphasized, spanningEdge(emphasized))).toBe("primary");
  });

  it("quiet edges stay quiet even when emphasized (execution metadata never becomes flow)", () => {
    const ws = applyOperations(diamond(), [
      { op: "CONNECT_NODES", source: "b", target: "d", relationship: "depends_on" },
      { op: "SET_LAYOUT_INTENT", emphasis: ["b", "d"] },
    ]);
    const dep = Object.values(ws.edges).find((e) => e.relationship === "depends_on")!;
    expect(edgeTier(ws, dep)).toBe("quiet");
  });

  it("emphasis never moves a node (geometry untouched)", () => {
    const before = diamond();
    const stated = applyOperations(before, [{ op: "SET_LAYOUT_INTENT", emphasis: ["a"] }]);
    // Same options, same engine: emphasis is not an input to the layout,
    // so the geometry is identical.
    expect(computeLayoutWithRoutes(stated).layout).toEqual(computeLayoutWithRoutes(before).layout);
  });

  it("edgeTiers (the render loop's one pass) sees the promotion too", () => {
    const ws = routedDiamond();
    const edge = spanningEdge(ws);
    expect(edgeTiers(ws)[edge.id]).not.toBe("primary");
    const emphasized = applyOperations(ws, [{ op: "SET_LAYOUT_INTENT", emphasis: ["a"] }]);
    expect(edgeTiers(emphasized)[spanningEdge(emphasized).id]).toBe("primary");
  });
});
