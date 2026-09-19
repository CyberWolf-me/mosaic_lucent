import { describe, it, expect } from "vitest";
import { toScene } from "../src/scene.js";
import { makePath } from "../src/ui/atoms.js";
import { applyOperations, createWorkspace, type Operation, type Workspace } from "@lucent/core";
import { buildBoardSvg } from "../src/board/geometry.js";

/**
 * Routing STYLES through the render path (doc 18, Phase 5): toScene stamps
 * the board's routeStyle once; makePath draws ortho as squared corners,
 * spline as Catmull-Rom, polyline as segments; the label rides the same
 * vertex list; and the SVG export draws the same vertices the canvas does.
 * The one-drawn-truth rule: every consumer asks core's routedVertices.
 */

function board(kind: Workspace["diagramKind"], route?: Array<{ x: number; y: number }>): Workspace {
  const ws = createWorkspace({ diagramKind: kind });
  const ops: Operation[] = [
    { op: "CREATE_NODE", id: "a", nodeType: "service", label: "a" },
    { op: "CREATE_NODE", id: "b", nodeType: "service", label: "b" },
    { op: "CONNECT_NODES", source: "a", target: "b", relationship: "calls" },
  ];
  const applied = applyOperations(ws, ops);
  if (!route) return applied;
  const edge = Object.values(applied.edges).find((e) => e.source === "a" && e.target === "b")!;
  return { ...applied, edges: { ...applied.edges, [edge.id]: { ...edge, route } } };
}

describe("toScene stamps the family's routeStyle", () => {
  it("flowchart (a routed family) stamps ortho; mindmap stamps polyline", () => {
    expect(toScene(board("flowchart")).edges[0]!.routeStyle).toBe("ortho");
    expect(toScene(board("mindmap")).edges[0]!.routeStyle).toBe("polyline");
  });

  it("route-less edges are unaffected by the stamp (the style is consulted only when a route exists)", () => {
    const scene = toScene(board("bpmn")); // no route stamped
    expect(scene.edges[0]!.route).toEqual([]);
    // makePath with an empty route ignores the style entirely.
    const d = makePath({ x: 0, y: 0 }, { x: 100, y: 50 }, "h", 0, [], "ortho");
    expect(d).toContain("C"); // the bezier arm, not an ortho L
  });
});

describe("makePath draws the style", () => {
  const a = { x: 0, y: 0 };
  const b = { x: 100, y: 300 };
  const w = [
    { x: 40, y: 120 },
    { x: 60, y: 200 },
  ];

  it("polyline: straight segments through the waypoints", () => {
    const d = makePath(a, b, "h", 0, w, "polyline");
    expect(d).toBe("M 0 0 L 40 120 L 60 200 L 100 300");
  });

  it("ortho: squared corners — axis-aligned segments only", () => {
    const d = makePath(a, b, "h", 0, w, "ortho");
    expect(d.startsWith("M 0 0")).toBe(true);
    // Every L-segment is axis-aligned.
    const nums = d.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
    for (let i = 0; i + 3 < nums.length; i += 2) {
      const [x1, y1] = [nums[i], nums[i + 1]];
      const [x2, y2] = [nums[i + 2], nums[i + 3]];
      expect(x1 === x2 || y1 === y2).toBe(true);
    }
  });

  it("spline: Catmull-Rom cubic segments through the same waypoints", () => {
    const d = makePath(a, b, "h", 0, w, "spline");
    expect(d.startsWith("M 0 0")).toBe(true);
    // Four vertices → three cubic segments; each waypoint appears as a curve
    // endpoint. Control arms at 1/6 tangents (uniform Catmull-Rom).
    expect(d).toContain("C ");
    expect(d).toContain(", 40 120"); // first waypoint as a segment end
  });

  it("explicit vertices are honored when passed (the shared drawn truth)", () => {
    // The passed list is the COMPLETE vertex list (routedVertices output —
    // anchors included), exactly what DiagramLayer computes once and shares
    // with the label midpoint.
    const vertices = [a, { x: 10, y: 10 }, { x: 20, y: 20 }, b];
    const d = makePath(a, b, "h", 0, w, "polyline", vertices);
    expect(d).toBe("M 0 0 L 10 10 L 20 20 L 100 300");
  });

  it("spline curves a 3-vertex corridor too (2 gaps = 2 cubics, not segments)", () => {
    const d = makePath({ x: 0, y: 0 }, { x: 50, y: 50 }, "h", 0, [{ x: 25, y: 25 }], "spline");
    expect(d).toContain("C ");
    expect(d).toContain(", 25 25");
  });
});

describe("the export draws the same style as the canvas", () => {
  it("a bpmn board's routed edge exports squared (axis-aligned) polyline points", () => {
    const ws = board("bpmn", [
      { x: 40, y: 120 },
      { x: 60, y: 200 },
    ]);
    // Geometry: give the nodes positions so export renders them.
    const placed: Workspace = {
      ...ws,
      nodes: {
        a: { ...ws.nodes.a!, position: { x: 0, y: 0 }, size: { width: 80, height: 40 } },
        b: { ...ws.nodes.b!, position: { x: 20, y: 300 }, size: { width: 80, height: 40 } },
      },
    };
    const svg = buildBoardSvg(placed);
    const line = svg.match(/<polyline points="([^"]+)"/);
    expect(line).not.toBeNull();
    const pts = line![1]!.split(" ").map((p) => p.split(",").map(Number));
    for (let i = 0; i + 1 < pts.length; i++) {
      const [x1, y1] = pts[i]!;
      const [x2, y2] = pts[i + 1]!;
      expect(x1 === x2 || y1 === y2).toBe(true);
    }
  });
});
