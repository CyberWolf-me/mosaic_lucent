import { describe, expect, it } from "vitest";
import {
  applyOperations,
  createWorkspace,
  inverseOperations,
  safeParseProgrammaticOperations,
  validateOperations,
  type Operation,
  type Shape,
  type VectorData,
} from "@lucent/core";
import { buildBoardSvg } from "../src/board/geometry.js";
import { combineVectorOps, splitVectorOps } from "../src/vector/ops.js";

/**
 * docs/26 §6.3 editing on the board: split a vector into a shape per part and
 * combine parts back, each as one batch the validator accepts and one undo
 * reverses; and gradients reach the export with ids no two shapes share.
 */

const art: VectorData = {
  viewBox: [0, 0, 100, 50],
  paths: [
    { d: "M0 0L40 0L40 50L0 50Z", fill: "#ff0000" },
    { d: "M60 0L100 0L100 50L60 50Z", fillGradient: 0 },
  ],
  gradients: [
    {
      kind: "linear",
      units: "box",
      x1: 0,
      y1: 0,
      x2: 1,
      y2: 0,
      stops: [
        { offset: 0, color: "#ffffff" },
        { offset: 1, color: "#000000" },
      ],
    },
  ],
};

function boardWith(extra: Partial<Shape> = {}) {
  const create: Operation = {
    op: "CREATE_SHAPE",
    id: "v1",
    kind: "vector",
    position: { x: 100, y: 100 },
    size: { width: 200, height: 100 },
    vector: art,
    style: { color: "#123456" },
    z: 3,
    ...extra,
  } as Operation;
  return applyOperations(createWorkspace(), [create]);
}

describe("split into parts", () => {
  it("replaces the vector with one shape per part, each where it was drawn", () => {
    const ws = boardWith();
    const r = splitVectorOps(ws.shapes.v1!, 7)!;
    expect(safeParseProgrammaticOperations(r.ops).success).toBe(true);
    expect(validateOperations(ws, r.ops)).toEqual([]);
    const after = applyOperations(ws, r.ops);
    expect(after.shapes.v1).toBeUndefined();
    const parts = r.ids.map((id) => after.shapes[id]!);
    expect(parts.map((p) => ({ ...p.position, ...p.size }))).toEqual([
      { x: 100, y: 100, width: 80, height: 100 },
      { x: 220, y: 100, width: 80, height: 100 },
    ]);
    // Ink carries over; paint order stacks from the given z.
    expect(parts.map((p) => p.style?.color)).toEqual(["#123456", "#123456"]);
    expect(parts.map((p) => p.z)).toEqual([7, 8]);
    expect(parts[1]!.vector!.gradients).toHaveLength(1);
    // One undo brings the whole back.
    const undone = applyOperations(after, inverseOperations(r.ops, ws));
    expect(undone.shapes.v1?.vector).toEqual(art);
    expect(r.ids.some((id) => undone.shapes[id])).toBe(false);
  });

  it("turns each part about the whole's centre when the vector is rotated", () => {
    const ws = boardWith({ rotation: 90 });
    const r = splitVectorOps(ws.shapes.v1!, 1)!;
    const after = applyOperations(ws, r.ops);
    const [a, b] = r.ids.map((id) => after.shapes[id]!);
    // Centre (200,150). The left part's centre (-60,0) turns to (0,-60).
    expect(a!.rotation).toBe(90);
    expect(a!.position.x + a!.size.width / 2).toBeCloseTo(200);
    expect(a!.position.y + a!.size.height / 2).toBeCloseTo(90);
    expect(b!.position.y + b!.size.height / 2).toBeCloseTo(210);
  });

  it("combine puts the parts back as one vector with the same drawing", () => {
    const ws = boardWith();
    const split = splitVectorOps(ws.shapes.v1!, 4)!;
    const parts = applyOperations(ws, split.ops);
    const r = combineVectorOps(split.ids.map((id) => parts.shapes[id]!));
    if (!r || "error" in r) throw new Error("combine refused");
    expect(validateOperations(parts, r.ops)).toEqual([]);
    const back = applyOperations(parts, r.ops).shapes[r.id]!;
    expect({ ...back.position, ...back.size }).toEqual({ x: 100, y: 100, width: 200, height: 100 });
    expect(back.vector!.paths.map((p) => p.d)).toEqual([
      "M0 0L80 0L80 100L0 100Z",
      "M120 0L200 0L200 100L120 100Z",
    ]);
    expect(back.vector!.paths[1]!.fillGradient).toBe(0);
    expect(back.style?.color).toBe("#123456");
  });

  it("combine refuses turned parts rather than drawing them wrong", () => {
    const ws = boardWith({ rotation: 15 });
    const split = splitVectorOps(ws.shapes.v1!, 4)!;
    const parts = applyOperations(ws, split.ops);
    const r = combineVectorOps(split.ids.map((id) => parts.shapes[id]!));
    expect(r).toEqual({ error: expect.stringMatching(/Straighten/) });
  });

  it("the export draws gradients with ids scoped to each shape", () => {
    const ws = applyOperations(boardWith(), [
      {
        op: "CREATE_SHAPE",
        id: "v2",
        kind: "vector",
        position: { x: 400, y: 100 },
        size: { width: 100, height: 50 },
        vector: art,
      },
    ]);
    const svg = buildBoardSvg(ws);
    expect(svg).toContain('<linearGradient id="v1-0"');
    expect(svg).toContain('<linearGradient id="v2-0"');
    expect(svg).toContain('fill="url(#v1-0)"');
    expect(svg).toContain('fill="url(#v2-0)"');
  });
});
