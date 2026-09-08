import { describe, it, expect } from "vitest";
import { createWorkspace } from "@lucent/core";
import { applyOperations } from "@lucent/core";
import {
  snapPosition,
  marqueeHits,
  contentBounds,
  buildBoardSvg,
  shapesInFrame,
} from "../src/board/geometry.js";
import type { Shape } from "@lucent/core";

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
