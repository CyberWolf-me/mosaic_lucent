/**
 * Edge ROUTES (V5, 2026-09-11): the layered engine's long edges carry
 * derived bend points — the Sugiyama chain corridor made real geometry.
 * Pinned here: derivation shape, correctness of the corridor, determinism,
 * the stamp round-trip, and the invariant the whole feature rests on.
 */

import { describe, expect, it } from "vitest";
import {
  applyLayout,
  applyOperations,
  applyRoutes,
  computeLayout,
  computeLayoutWithRoutes,
  parseWorkspace,
  type Operation,
} from "../src/index.js";
import { createWorkspace } from "../src/model.js";

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

describe("route derivation", () => {
  it("a skip edge spanning layers gets exactly span-1 waypoints; adjacent edges get none", () => {
    // a → b → c → d chain, plus the a→d skip: a,b,c,d in layers 0..3.
    const ws = board(["a", "b", "c", "d"], [
      ["a", "b"],
      ["b", "c"],
      ["c", "d"],
      ["a", "d"],
    ]);
    const { layout, routes } = computeLayoutWithRoutes(ws);
    const skip = Object.values(ws.edges).find((e) => e.source === "a" && e.target === "d")!;
    expect(skip, "the skip edge exists").toBeTruthy();
    const skipRoute = routes[skip.id];
    expect(skipRoute, "the a→d skip spans 3 layers → 2 waypoints").toHaveLength(2);
    // Adjacent edges carry no route at all.
    for (const id of Object.keys(ws.edges)) {
      if (id === skip.id) continue;
      expect(routes[id], `edge ${id} is adjacent — no route`).toBeUndefined();
    }
    // The layout itself is unchanged: node-only, every node placed.
    expect(Object.keys(layout).sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("waypoints thread BETWEEN the rows: each sits between its neighbours' bands", () => {
    // Two parallel two-step paths so layer 1 has two nodes the skip must
    // thread between: a → m → z with skip a→z, plus a → n → z.
    const ws = board(["a", "m", "n", "z"], [
      ["a", "m"],
      ["m", "z"],
      ["a", "n"],
      ["n", "z"],
      ["a", "z"],
    ]);
    const { layout, routes } = computeLayoutWithRoutes(ws);
    const skip = Object.values(ws.edges).find((e) => e.source === "a" && e.target === "z")!;
    const route = routes[skip.id];
    expect(route).toBeDefined();
    // The waypoint's y is strictly between a's and z's centers (the
    // corridor between the bands — the core routing guarantee).
    const a = layout["a"]!;
    const z = layout["z"]!;
    const wp = route![0]!;
    const aCy = a.position.y + a.size.height / 2;
    const zCy = z.position.y + z.size.height / 2;
    expect(wp.y).toBeGreaterThan(Math.min(aCy, zCy));
    expect(wp.y).toBeLessThan(Math.max(aCy, zCy));
    // Horizontally the corridor lands within the middle band's overall span
    // (± one node's width for the edge-of-row fallback), never across the
    // whole canvas.
    const m = layout["m"]!;
    const n = layout["n"]!;
    const lo = Math.min(m.position.x, n.position.x) - 200;
    const hi = Math.max(m.position.x + m.size.width, n.position.x + n.size.width) + 200;
    expect(wp.x).toBeGreaterThanOrEqual(lo);
    expect(wp.x).toBeLessThanOrEqual(hi);
  });

  it("a cyclic board (return edge) still layers every node — no layer-0 pileup", () => {
    // The n=300 benchmark defect: the return edge starved Kahn and 148/300
    // nodes collapsed to layer 0. Small version: a chain plus a back edge.
    const ws = board(["a", "b", "c", "d", "e"], [
      ["a", "b"],
      ["b", "c"],
      ["c", "d"],
      ["d", "e"],
      ["e", "a"], // the return edge — a cycle
    ]);
    const { layout } = computeLayoutWithRoutes(ws);
    // The flow axis: distinct y positions, not one row. Five nodes must not
    // share a single y.
    const ys = new Set(Object.values(layout).map((p) => p.position.y));
    expect(ys.size).toBeGreaterThan(1);
    // Every node placed.
    expect(Object.keys(layout)).toHaveLength(5);
  });

  it("derivation is deterministic", () => {
    const ws = board(["a", "b", "c", "d"], [
      ["a", "b"],
      ["b", "c"],
      ["c", "d"],
      ["a", "d"],
      ["a", "c"],
    ]);
    const first = computeLayoutWithRoutes(ws);
    const second = computeLayoutWithRoutes(ws);
    expect(second.layout).toEqual(first.layout);
    expect(second.routes).toEqual(first.routes);
  });

  it("computeLayout output is identical with and without route derivation", () => {
    const ws = board(["a", "b", "c", "d", "x", "y"], [
      ["a", "b"],
      ["b", "c"],
      ["c", "d"],
      ["a", "d"],
      ["x", "y"],
      ["a", "y"],
    ]);
    expect(computeLayout(ws)).toEqual(computeLayoutWithRoutes(ws).layout);
  });
});

describe("applyRoutes", () => {
  it("stamps routes onto exactly the named edges, clone-and-stamp", () => {
    const ws = board(["a", "b", "c", "d"], [
      ["a", "b"],
      ["b", "c"],
      ["c", "d"],
      ["a", "d"],
    ]);
    const { routes } = computeLayoutWithRoutes(ws);
    const stamped = applyRoutes(ws, routes);
    for (const [id, route] of Object.entries(routes)) {
      expect(stamped.edges[id]!.route).toEqual(route);
    }
    // The original is untouched (clone), and unstamped edges have no route.
    for (const id of Object.keys(ws.edges)) {
      expect(ws.edges[id]!.route, `original edge ${id} untouched`).toBeUndefined();
      if (!routes[id]) expect(stamped.edges[id]!.route).toBeUndefined();
    }
  });

  it("a stamped workspace round-trips through the zod schema", () => {
    const ws = board(["a", "b", "c", "d"], [
      ["a", "b"],
      ["b", "c"],
      ["c", "d"],
      ["a", "d"],
    ]);
    const { layout, routes } = computeLayoutWithRoutes(ws);
    const stamped = applyRoutes(applyLayout(ws, layout), routes);
    const json = JSON.parse(JSON.stringify(stamped));
    const parsed = parseWorkspace(json);
    const skip = Object.values(stamped.edges).find((e) => e.route && e.route.length > 0);
    expect(skip, "at least one edge carries a route").toBeTruthy();
    if (parsed.ok && parsed.workspace) {
      const reparsed = parsed.workspace.edges[skip!.id];
      expect(reparsed?.route).toEqual(skip!.route);
    } else {
      throw new Error(`schema rejected a routed board: ${parsed.detail}`);
    }
  });
});
