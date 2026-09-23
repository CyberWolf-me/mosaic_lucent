import { describe, it, expect } from "vitest";
import { createWorkspace } from "@lucent/core";
import { applyOperations } from "@lucent/core";
import {
  snapPosition,
  marqueeHits,
  contentBounds,
  buildBoardSvg,
  shapesInFrame,
  projectMomentum,
  rubberband,
  VelocityTracker,
  approach,
  softClampZoom,
} from "../src/board/geometry.js";
import type { Shape } from "@lucent/core";
import { cloneShapeOp } from "../src/shapes.js";

const shape = (over: Partial<Shape> = {}): Shape => ({
  id: over.id ?? "s",
  kind: over.kind ?? "rect",
  position: over.position ?? { x: 0, y: 0 },
  size: over.size ?? { width: 100, height: 60 },
  ...over,
});

describe("board geometry", () => {
  it("snaps to a nearby shape edge within threshold", () => {
    const others = [
      shape({ id: "a", position: { x: 200, y: 100 }, size: { width: 100, height: 60 } }),
    ];
    // x=197 is within 6px of edge 200 -> snaps to 200; y far -> grid snap.
    const p = snapPosition(197, 41, others);
    expect(p.x).toBe(200);
    expect(p.y).toBe(40); // 41 -> nearest grid (8)
  });

  it("falls back to grid when no edge is close", () => {
    const p = snapPosition(53, 29, []);
    expect(p).toEqual({ x: 56, y: 32 });
  });

  it("selects shapes intersecting the marquee", () => {
    const shapes = [
      shape({ id: "a", position: { x: 0, y: 0 } }),
      shape({ id: "b", position: { x: 500, y: 500 } }),
    ];
    const hit = marqueeHits({ x0: -10, y0: -10, x1: 120, y1: 120 }, shapes);
    expect([...hit]).toEqual(["a"]);
  });

  it("computes content bounds over shapes", () => {
    const ws = applyOperations(createWorkspace(), [
      {
        op: "CREATE_SHAPE",
        id: "a",
        kind: "rect",
        position: { x: 10, y: 10 },
        size: { width: 100, height: 50 },
      },
      {
        op: "CREATE_SHAPE",
        id: "b",
        kind: "rect",
        position: { x: 200, y: 100 },
        size: { width: 40, height: 40 },
      },
    ]);
    expect(contentBounds(ws)).toEqual({ x: 10, y: 10, width: 230, height: 130 });
  });

  it("returns null bounds for an empty board", () => {
    expect(contentBounds(createWorkspace())).toBeNull();
  });

  it("builds an SVG that includes shape text and escapes markup", () => {
    const ws = applyOperations(createWorkspace(), [
      {
        op: "CREATE_SHAPE",
        id: "a",
        kind: "sticky",
        position: { x: 0, y: 0 },
        size: { width: 100, height: 60 },
        text: "A & <b>",
      },
    ]);
    const svg = buildBoardSvg(ws);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("A &amp; &lt;b&gt;");
  });

  it("exports connectors between nodes (the export used to drop every edge)", () => {
    const ws = applyOperations(createWorkspace({ diagramKind: "flowchart" }), [
      { op: "CREATE_NODE", id: "a", nodeType: "service", label: "A" },
      { op: "CREATE_NODE", id: "b", nodeType: "service", label: "B" },
      { op: "CONNECT_NODES", source: "a", target: "b", relationship: "calls" },
    ]);
    const svg = buildBoardSvg(ws);
    expect(svg).toContain("<line");
    expect(svg).toContain('marker-end="url(#export-arrow)"');
  });

  it("exports unplaced nodes at the live renderer's defaults instead of dropping them", () => {
    const ws = applyOperations(createWorkspace({ diagramKind: "flowchart" }), [
      // Deliberately no MOVE_NODE: server-adopted boards carry nodes without
      // position/size (the schema keeps them optional); the live canvas draws
      // them at (0,0) 160x64, and the export must match — not skip them.
      { op: "CREATE_NODE", id: "a", nodeType: "service", label: "Unplaced" },
    ]);
    const svg = buildBoardSvg(ws);
    expect(svg).not.toContain("Empty board");
    expect(svg).toContain("Unplaced");
    expect(svg).toContain('width="160"');
  });

  it("exports the owner's live-generated launch-plan board completely (6 nodes, 5 edges, 1 region)", () => {
    // The exact shape the live pass generated through the real AI route
    // (glm-5.3-flash via api.b.ai): 3 goals + 2 blockers + 1 milestone, 5
    // labeled relationships, one kinded group holding all six members. The
    // pre-fix export dropped every edge and every unplaced node — this pins
    // the whole picture at once.
    const ws = applyOperations(createWorkspace({ diagramKind: "flowchart", name: "Launch plan" }), [
      { op: "CREATE_GROUP", id: "g1", label: "Launch Plan", children: [] },
      { op: "SET_GROUP_KIND", id: "g1", kind: "process" },
      {
        op: "CREATE_NODE",
        id: "n1",
        nodeType: "issue",
        label: "Goal: 1k beta signups",
        groupId: "g1",
      },
      {
        op: "CREATE_NODE",
        id: "n2",
        nodeType: "issue",
        label: "Goal: Marketing site live",
        groupId: "g1",
      },
      {
        op: "CREATE_NODE",
        id: "n3",
        nodeType: "issue",
        label: "Goal: Onboarding shipped",
        groupId: "g1",
      },
      {
        op: "CREATE_NODE",
        id: "n4",
        nodeType: "issue",
        label: "Blocker: API rate limits",
        groupId: "g1",
      },
      {
        op: "CREATE_NODE",
        id: "n5",
        nodeType: "issue",
        label: "Blocker: Legal review",
        groupId: "g1",
      },
      {
        op: "CREATE_NODE",
        id: "n6",
        nodeType: "milestone",
        label: "Product Launch",
        groupId: "g1",
      },
      { op: "CONNECT_NODES", source: "n1", target: "n6", relationship: "delivers" },
      { op: "CONNECT_NODES", source: "n2", target: "n6", relationship: "delivers" },
      { op: "CONNECT_NODES", source: "n3", target: "n6", relationship: "delivers" },
      { op: "CONNECT_NODES", source: "n4", target: "n6", relationship: "blocks" },
      { op: "CONNECT_NODES", source: "n5", target: "n6", relationship: "blocks" },
    ]);
    const svg = buildBoardSvg(ws);
    // Every node's label present.
    for (const label of [
      "Goal: 1k beta signups",
      "Goal: Marketing site live",
      "Goal: Onboarding shipped",
      "Blocker: API rate limits",
      "Blocker: Legal review",
      "Product Launch",
    ]) {
      expect(svg).toContain(label);
    }
    // All 5 connectors, with arrowheads, and the region box + its label.
    expect(svg).not.toContain("Empty board");
    expect((svg.match(/<line /g) ?? []).length).toBe(5);
    // "export-arrow" appears once per connector plus once in the marker
    // definition — count the marker-end references, not the raw string.
    expect((svg.match(/marker-end="url\(#export-arrow\)"/g) ?? []).length).toBe(5);
    expect(svg).toContain("Launch Plan · Process map");
  });

  it("projects flick momentum with Apple's exponential-decay form", () => {
    // 1000px/s flick at the default 0.998 rate travels ~499px past release.
    expect(projectMomentum(1000)).toBeCloseTo(499, 0);
    expect(projectMomentum(0)).toBe(0);
    expect(projectMomentum(-500)).toBeCloseTo(-249.5, 0);
  });

  it("rubber-bands past a boundary with progressive resistance", () => {
    expect(rubberband(0, 80)).toBe(0);
    const small = rubberband(20, 80);
    const large = rubberband(400, 80);
    // Small overshoots track closely; huge ones asymptote instead of following.
    expect(small).toBeGreaterThan(9);
    expect(large).toBeLessThan(80);
    expect(rubberband(-20, 80)).toBeCloseTo(-small, 5);
  });

  it("tracks release velocity from recent samples only", () => {
    const v = new VelocityTracker();
    expect(v.velocity()).toEqual({ x: 0, y: 0 });
    v.push(0, 0, 0);
    v.push(100, 0, 100);
    expect(v.velocity().x).toBeCloseTo(1000, 0);
    // Stale samples fall out of the window: a pause reads as stopped.
    v.push(100, 0, 500);
    expect(v.velocity().x).toBe(0);
  });

  it("approaches a re-targeted value without overshoot", () => {
    let cur = 0;
    for (let i = 0; i < 600; i++) {
      // Mid-flight reversal: the target flips halfway through.
      cur = approach(cur, i < 300 ? 100 : 0, 12, 1 / 60);
    }
    expect(cur).toBe(0);
    expect(approach(99.999, 100, 12, 1 / 60)).toBe(100);
  });

  it("soft-clamps zoom with resistance outside the limits", () => {
    expect(softClampZoom(100)).toBe(100);
    expect(softClampZoom(25)).toBe(25);
    // Overshoot resists: 100px past the max reads far smaller, but grows.
    const over = softClampZoom(500);
    expect(over).toBeGreaterThan(400);
    expect(over).toBeLessThan(450);
    expect(softClampZoom(600)).toBeGreaterThan(over);
    expect(softClampZoom(-100)).toBeLessThan(25);
  });

  it("finds shapes contained within a frame", () => {
    const frame = shape({
      id: "f",
      kind: "frame",
      position: { x: 0, y: 0 },
      size: { width: 300, height: 300 },
    });
    const inside = shape({ id: "in", position: { x: 20, y: 20 }, size: { width: 50, height: 50 } });
    const outside = shape({
      id: "out",
      position: { x: 400, y: 400 },
      size: { width: 50, height: 50 },
    });
    expect(shapesInFrame(frame, [frame, inside, outside])).toEqual(["in"]);
  });
});

/**
 * docs/26 F10: the export is the board on paper. It used to include shapes the
 * canvas hides, drop rotation, stack shapes in insertion order, and leave out
 * every manual connector; and duplicating an image dropped its picture.
 */
describe("export fidelity (F10)", () => {
  const base = (extra: import("@lucent/core").Operation[] = []) =>
    applyOperations(createWorkspace(), [
      {
        op: "CREATE_SHAPE",
        id: "a",
        kind: "rect",
        position: { x: 0, y: 0 },
        size: { width: 100, height: 60 },
        text: "Alpha",
        z: 2,
      },
      {
        op: "CREATE_SHAPE",
        id: "b",
        kind: "rect",
        position: { x: 300, y: 0 },
        size: { width: 100, height: 60 },
        text: "Beta",
        z: 1,
      },
      ...extra,
    ]);

  it("leaves hidden shapes out of the drawing and the bounds", () => {
    const ws = base([
      {
        op: "CREATE_SHAPE",
        id: "h",
        kind: "rect",
        position: { x: 2000, y: 2000 },
        size: { width: 50, height: 50 },
        text: "Secret",
        hidden: true,
      },
    ]);
    const svg = buildBoardSvg(ws);
    expect(svg).not.toContain("Secret");
    expect(contentBounds(ws)).toEqual({ x: 0, y: 0, width: 400, height: 60 });
  });

  it("stacks shapes by z, like the canvas", () => {
    const svg = buildBoardSvg(base());
    expect(svg.indexOf("Beta")).toBeLessThan(svg.indexOf("Alpha"));
  });

  it("turns a rotated shape about its centre", () => {
    const svg = buildBoardSvg(base([{ op: "UPDATE_SHAPE", id: "a", rotation: 12 }]));
    expect(svg).toContain('<g transform="rotate(12 50 30)">');
  });

  it("draws manual connectors, their label and a double arrow — but not to a hidden shape", () => {
    const ws = base([
      {
        op: "CONNECT_SHAPES",
        id: "l1",
        source: "a",
        target: "b",
        label: "feeds",
        variant: "straight",
        doubleArrow: true,
      },
    ]);
    const svg = buildBoardSvg(ws);
    expect(svg).toContain('<path d="M 100 30 L 300 30"');
    expect(svg).toContain('marker-start="url(#export-arrow)"');
    expect(svg).toContain(">feeds</text>");
    const hidden = applyOperations(ws, [{ op: "UPDATE_SHAPE", id: "b", hidden: true }]);
    expect(buildBoardSvg(hidden)).not.toContain("feeds");
  });

  it("a duplicate carries the image, text and style, but not lock or visibility", () => {
    const img: Shape = shape({
      id: "img",
      kind: "image",
      src: "https://example.com/logo.png",
      text: "Logo",
      style: { stroke: "#123456" },
      locked: true,
      rotation: 5,
    });
    const op = cloneShapeOp(img, "copy", 24, 3);
    expect(op).toMatchObject({
      id: "copy",
      kind: "image",
      src: "https://example.com/logo.png",
      text: "Logo",
      style: { stroke: "#123456" },
      rotation: 5,
      position: { x: img.position.x + 24, y: img.position.y + 24 },
      z: 3,
    });
    expect(op).not.toHaveProperty("locked");
    expect(op).not.toHaveProperty("hidden");
  });
});
