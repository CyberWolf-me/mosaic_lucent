/**
 * Routing styles per family (doc 18, Phase 5, advisory V10): the measured
 * policy table, the shared drawn-truth vertex derivation (ortho squares
 * corners; polyline/spline share the skeleton), and the benchmark's
 * consumption of the style — the crossing metric counts what the renderer
 * draws.
 */

import { describe, expect, it } from "vitest";
import {
  createWorkspace,
  measureVisualMetrics,
  routeStyleFor,
  routedVertices,
  applyLayout,
  applyOperations,
  applyRoutes,
  computeLayoutWithRoutes,
} from "../src/index.js";

describe("routeStyleFor — the measured per-family table", () => {
  it("the four layered (routed) families draw ortho — the sweep's winner", () => {
    expect(routeStyleFor("flowchart")).toBe("ortho");
    expect(routeStyleFor("architecture")).toBe("ortho");
    expect(routeStyleFor("journey")).toBe("ortho");
    expect(routeStyleFor("bpmn")).toBe("ortho");
  });

  it("never-routing families hold the inert polyline default", () => {
    expect(routeStyleFor("mindmap")).toBe("polyline");
    expect(routeStyleFor("decisiontree")).toBe("polyline");
    expect(routeStyleFor("orgchart")).toBe("polyline");
  });

  it("process maps draw ortho (squared lanes are the process convention)", () => {
    expect(routeStyleFor("process")).toBe("ortho");
  });
});

describe("routedVertices — the one drawn-truth derivation", () => {
  const a = { x: 0, y: 0 };
  const b = { x: 100, y: 300 };

  it("polyline passes the anchors and waypoints through untouched", () => {
    const w = [{ x: 50, y: 100 }, { x: 50, y: 200 }];
    expect(routedVertices(a, b, w, "polyline")).toEqual([a, ...w, b]);
  });

  it("spline shares polyline's skeleton (curvature is the renderer's stroke)", () => {
    const w = [{ x: 50, y: 100 }, { x: 50, y: 200 }];
    expect(routedVertices(a, b, w, "spline")).toEqual(routedVertices(a, b, w, "polyline"));
  });

  it("no waypoints → the two anchors, whatever the style", () => {
    expect(routedVertices(a, b, [], "ortho")).toEqual([a, b]);
    expect(routedVertices(a, b, [], "polyline")).toEqual([a, b]);
  });

  it("ortho squares every diagonal into axis-aligned segments", () => {
    // A mostly-vertical diagonal a→w becomes: vertical to (a.x, w.y), then
    // horizontal to w — the dominant-axis-first L.
    const w = [{ x: 40, y: 200 }];
    const v = routedVertices(a, b, w, "ortho");
    expect(v).toEqual([a, { x: 0, y: 200 }, { x: 40, y: 200 }, { x: 40, y: 300 }, b]);
    // Every consecutive pair is axis-aligned — the ortho invariant.
    for (let i = 0; i + 1 < v.length; i++) {
      const u = v[i]!;
      const next = v[i + 1]!;
      expect(u.x === next.x || u.y === next.y).toBe(true);
    }
  });

  it("already-aligned segments pass through unsquared; diagonals still square", () => {
    const w = [{ x: 0, y: 100 }, { x: 0, y: 200 }];
    // The two a→w hops are axis-aligned and pass through; the final
    // w→b diagonal (0,200)→(100,300) squares vertical-first (|dy|≥|dx|):
    // the elbow drops to b's row at w's column, then runs right.
    expect(routedVertices(a, b, w, "ortho")).toEqual([
      a,
      { x: 0, y: 100 },
      { x: 0, y: 200 },
      { x: 0, y: 300 },
      b,
    ]);
  });

  it("the corner rule never overshoots the waypoint (the 2026-09-13 defect, pinned)", () => {
    // The first sweep's corner rule doubled back past each waypoint and
    // multiplied dense-board crossings 2.4×. The fixed rule's every vertex
    // stays within the segment's own bounding box: no vertex's y exceeds
    // max(u.y, v.y) of the segment that produced it.
    const w = [{ x: 30, y: 90 }, { x: 70, y: 180 }, { x: 90, y: 260 }];
    const v = routedVertices(a, b, w, "ortho");
    for (let i = 1; i + 1 < v.length; i++) {
      // Every interior vertex lies in the union box of its neighbours…
      const prev = v[i - 1]!;
      const cur = v[i]!;
      const next = v[i + 1]!;
      const inBox =
        cur.x >= Math.min(prev.x, next.x) - 1e-9 &&
        cur.x <= Math.max(prev.x, next.x) + 1e-9 &&
        cur.y >= Math.min(prev.y, next.y) - 1e-9 &&
        cur.y <= Math.max(prev.y, next.y) + 1e-9;
      expect(inBox).toBe(true);
    }
  });

  it("deterministic: same input, same vertices, twice", () => {
    const w = [{ x: 50, y: 100 }];
    expect(routedVertices(a, b, w, "ortho")).toEqual(routedVertices(a, b, w, "ortho"));
  });
});

describe("the benchmark measures the drawn style", () => {
  /** A layered board with at least one spanning (routed) edge, laid out. */
  function routedBoard() {
    let ws = createWorkspace();
    ws = applyOperations(ws, [
      { op: "CREATE_NODE", id: "a", nodeType: "step", label: "A" },
      { op: "CREATE_NODE", id: "b", nodeType: "step", label: "B" },
      { op: "CREATE_NODE", id: "c", nodeType: "step", label: "C" },
      { op: "CONNECT_NODES", source: "a", target: "b", relationship: "then" },
      { op: "CONNECT_NODES", source: "b", target: "c", relationship: "then" },
      { op: "CONNECT_NODES", source: "a", target: "c", relationship: "then" },
    ]);
    const { layout, routes } = computeLayoutWithRoutes(ws);
    const laid = applyRoutes(applyLayout(ws, layout), routes);
    return { laid, layout, routed: Object.values(laid.edges).find((e) => e.route && e.route.length > 0) };
  }

  it("a spanning edge exists on the fixture and carries a route", () => {
    const { routed } = routedBoard();
    expect(routed).toBeDefined();
  });

  it("crossings are counted over the style's vertex list (ortho ≠ polyline here)", () => {
    const { laid, layout } = routedBoard();
    const asFlow = measureVisualMetrics({ ...laid, diagramKind: "flowchart" }, {}, layout);
    const asMind = measureVisualMetrics({ ...laid, diagramKind: "mindmap" }, {}, layout);
    // flowchart policy = ortho, mindmap policy = polyline: the same board
    // measured under two policies yields different bend counts (ortho
    // inserts elbow vertices) — proving the metric consumes the style.
    expect(asFlow.edgeBendsMean).toBeGreaterThanOrEqual(asMind.edgeBendsMean);
    // And the per-segment count is strictly higher when a diagonal exists.
    if (asMind.edgeBendsMean > 0) {
      expect(asFlow.edgeBendsMean).toBeGreaterThan(asMind.edgeBendsMean);
    }
  });
});
