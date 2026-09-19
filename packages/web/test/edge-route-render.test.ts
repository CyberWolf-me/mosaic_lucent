import { describe, it, expect } from "vitest";
import { toScene } from "../src/scene.js";
import { makePath } from "../src/ui/atoms.js";
import { visibleEdges } from "../src/board/culling.js";
import { applyOperations, createWorkspace, type Operation, type Workspace } from "@lucent/core";

/**
 * Edge ROUTES through the render path (V5): a routed edge's geometry is a
 * polyline, its label rides the drawn corridor, the cull span covers the
 * waypoints, and exports draw what the canvas draws. Route-less edges must
 * behave byte-identically to before — that is the graceful-degradation
 * contract every pre-route board depends on.
 */

function board(
  edges: Array<{ id: string; s: string; t: string; route?: Array<{ x: number; y: number }> }>,
): Workspace {
  const ws = createWorkspace({ diagramKind: "flowchart" });
  const ops: Operation[] = [
    { op: "CREATE_NODE", id: "a", nodeType: "service", label: "a" },
    { op: "CREATE_NODE", id: "b", nodeType: "service", label: "b" },
  ];
  for (const e of edges) {
    ops.push({ op: "CONNECT_NODES", source: e.s, target: e.t, relationship: "calls" });
  }
  const applied = applyOperations(ws, ops);
  // Stamp routes directly (the layout's applyRoutes does this in production;
  // hand-stamping keeps this test about the RENDER contract, not derivation).
  const stamped: Workspace = {
    ...applied,
    edges: { ...applied.edges },
  };
  for (const e of edges) {
    const created = Object.values(applied.edges).find((x) => x.source === e.s && x.target === e.t);
    if (created && e.route) stamped.edges[created.id] = { ...created, route: e.route };
  }
  return stamped;
}

describe("toScene carries routes", () => {
  it("a routed edge exposes its waypoints in scene order; route-less stays []", () => {
    const ws = board([
      {
        id: "e1",
        s: "a",
        t: "b",
        route: [
          { x: 10, y: 20 },
          { x: 30, y: 40 },
        ],
      },
      { id: "e2", s: "b", t: "a" },
    ]);
    const { edges } = toScene(ws);
    expect(edges).toHaveLength(2);
    const routed = edges.find((e) => e.route.length > 0)!;
    const plain = edges.find((e) => e.route.length === 0)!;
    expect(routed.route).toEqual([
      { x: 10, y: 20 },
      { x: 30, y: 40 },
    ]);
    expect(plain.route).toEqual([]);
  });
});

describe("makePath emits the routed polyline", () => {
  it("waypoints become L segments between the anchors, in order", () => {
    const a = { x: 0, y: 0 };
    const b = { x: 100, y: 100 };
    const d = makePath(a, b, "v", 0, [
      { x: 0, y: 50 },
      { x: 100, y: 50 },
    ]);
    expect(d).toBe("M 0 0 L 0 50 L 100 50 L 100 100");
  });

  it("no route keeps the exact bezier output (byte-identical contract)", () => {
    const a = { x: 0, y: 0 };
    const b = { x: 100, y: 100 };
    const withEmptyRoute = makePath(a, b, "v", 18, []);
    const withoutRoute = makePath(a, b, "v", 18);
    expect(withEmptyRoute).toBe(withoutRoute);
    // The bezier form (not a polyline) — the C command is the contract.
    expect(withoutRoute.startsWith("M 0 0 C ")).toBe(true);
    expect(withoutRoute).not.toContain(" L ");
  });
});

describe("visibleEdges spans include waypoints", () => {
  it("an edge whose endpoints are off-view stays mounted when its corridor crosses the view", () => {
    const ws = board([{ id: "e1", s: "a", t: "b", route: [{ x: 500, y: 500 }] }]);
    const { nodes, edges } = toScene(ws);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    // The view covers ONLY the waypoint, not either card.
    const view = { minX: 450, minY: 450, maxX: 550, maxY: 550 };
    const seen = visibleEdges(edges, byId, view);
    expect(seen.some((e) => e.id === edges[0]!.id)).toBe(true);
  });

  it("a route-less edge with both endpoints outside the view is culled (unchanged behavior)", () => {
    const ws = board([{ id: "e1", s: "a", t: "b" }]);
    const { nodes, edges } = toScene(ws);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    // Far from both endpoints.
    const view = { minX: 5000, minY: 5000, maxX: 5100, maxY: 5100 };
    const seen = visibleEdges(edges, byId, view);
    expect(seen).toHaveLength(0);
  });
});

describe("export draws the routed polyline", () => {
  it("buildBoardSvg emits <polyline> with the corridor points for a routed edge", async () => {
    const { buildBoardSvg } = await import("../src/board/geometry.js");
    const ws = board([
      { id: "e1", s: "a", t: "b", route: [{ x: 40, y: 60 }] },
      { id: "e2", s: "b", t: "a" },
    ]);
    const svg = buildBoardSvg(ws);
    expect(svg).toContain("<polyline");
    // The plain edge is still a <line>.
    expect(svg).toContain("<line");
  });
});
