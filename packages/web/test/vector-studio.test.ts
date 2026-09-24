import { describe, expect, it } from "vitest";
import {
  applyOperations,
  createWorkspace,
  importSvg,
  safeParseProgrammaticOperations,
  validateOperations,
  type Operation,
  type Shape,
} from "@lucent/core";
import { buildBoardSvg } from "../src/board/geometry.js";
import { loadIcon } from "../src/icons/registry.js";
import {
  fitSize,
  replaceWithVectorOps,
  sketchToVectorOps,
  svgToVectorOp,
  vectorFromGlyph,
} from "../src/vector/ops.js";
import { traceToSvg } from "../src/vector/traceCore.js";

/**
 * docs/26 §6.3 (V2, Vector Studio local): every way a vector reaches the board
 * — an SVG file, a registry icon, a traced image, pen strokes — yields one
 * `vector` shape that passes the strict op schema, and the export draws it.
 */

const strict = (ops: Operation[]) => safeParseProgrammaticOperations(ops).success;

describe("vectors onto the board", () => {
  it("an SVG file becomes one vector op, sized to fit", () => {
    const r = svgToVectorOp(
      '<svg viewBox="0 0 800 400"><rect width="800" height="400" fill="#abcdef"/></svg>',
      { x: 500, y: 300 },
      3,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.op).toMatchObject({
      kind: "vector",
      size: { width: 320, height: 160 },
      position: { x: 340, y: 220 },
      z: 3,
    });
    expect(strict([r.op])).toBe(true);
    expect(fitSize(10, 10)).toEqual({ width: 16, height: 16 });
  });

  it("an Iconoir icon keeps its outline in the shape's ink; a brand mark keeps its colour", async () => {
    const outline = vectorFromGlyph((await loadIcon("iconoir:database"))!)!;
    expect(outline.viewBox).toEqual([0, 0, 24, 24]);
    expect(outline.paths.every((p) => p.fill === "none" && p.stroke === "currentColor")).toBe(true);
    expect(outline.source).toEqual({ generator: "icon", ref: "iconoir:database" });

    const brand = vectorFromGlyph((await loadIcon("simple:postgresql"))!)!;
    expect(brand.paths[0]!.fill).toBe("#4169e1");
  });

  it("pen strokes become one smooth vector in their place, in one batch", () => {
    const strokes: Shape[] = [
      {
        id: "d1",
        kind: "draw",
        position: { x: 50, y: 50 },
        size: { width: 40, height: 10 },
        path: "M0 0L10 2L20 0L30 2L40 0",
        style: { stroke: "oklch(0.62 0.18 250)", strokeWidth: 2.5 },
      },
      {
        id: "d2",
        kind: "draw",
        position: { x: 60, y: 70 },
        size: { width: 2, height: 20 },
        path: "M0 0L0 20",
      },
    ];
    const ws = applyOperations(
      createWorkspace(),
      strokes.map((s) => ({ op: "CREATE_SHAPE" as const, ...s })),
    );
    const ops = sketchToVectorOps(strokes, 5)!;
    expect(ops.slice(0, 2)).toEqual([
      { op: "DELETE_SHAPE", id: "d1" },
      { op: "DELETE_SHAPE", id: "d2" },
    ]);
    expect(strict(ops)).toBe(true);
    expect(validateOperations(ws, ops)).toEqual([]);
    const after = applyOperations(ws, ops);
    const v = Object.values(after.shapes);
    expect(v).toHaveLength(1);
    expect(v[0]!.vector!.paths[0]).toMatchObject({
      stroke: "oklch(0.62 0.18 250)",
      strokeWidth: 2.5,
    });
    expect(v[0]!.vector!.paths[1]).toMatchObject({ stroke: "currentColor" });
  });

  it("a traced image replaces the picture in place, keeping its box and rotation", () => {
    const image: Shape = {
      id: "img",
      kind: "image",
      position: { x: 10, y: 20 },
      size: { width: 200, height: 100 },
      rotation: 7,
      src: "https://example.com/a.png",
      z: 4,
    };
    const vector = importSvg('<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>');
    if (!vector.ok) throw new Error(vector.error);
    const ops = replaceWithVectorOps(image, vector.vector);
    expect(ops[0]).toEqual({ op: "DELETE_SHAPE", id: "img" });
    expect(ops[1]).toMatchObject({
      kind: "vector",
      position: { x: 10, y: 20 },
      size: { width: 200, height: 100 },
      rotation: 7,
      z: 4,
    });
    expect(strict(ops)).toBe(true);
  });
});

describe("raster → vector (local tracing)", () => {
  it("traces a two-colour image into paths the importer accepts", () => {
    // 24×24: left half red, right half blue.
    const w = 24;
    const h = 24;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const red = x < w / 2;
        data[i] = red ? 230 : 20;
        data[i + 1] = 20;
        data[i + 2] = red ? 20 : 230;
        data[i + 3] = 255;
      }
    }
    const svg = traceToSvg({ width: w, height: h, data }, "logo");
    const r = importSvg(svg, { generator: "trace" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.vector.viewBox).toEqual([0, 0, 24, 24]);
    const fills = r.vector.paths.map((p) => p.fill);
    expect(fills.some((f) => f && /rgb\(2[0-9]{2},\s?2?\d,\s?2?\d\)|#e6/.test(f))).toBe(true);
    expect(r.vector.source).toEqual({ generator: "trace" });
  });
});

describe("export", () => {
  it("draws a vector shape as its own paths in a nested svg, rotated with the shape", () => {
    const ok = svgToVectorOp(
      '<svg viewBox="0 0 24 24"><path d="M0 0L24 24" stroke="#123456"/></svg>',
      { x: 100, y: 100 },
      1,
    );
    if (!ok.ok) throw new Error(ok.error);
    const ws = applyOperations(createWorkspace(), [{ ...ok.op, rotation: 30 }]);
    const svg = buildBoardSvg(ws);
    expect(svg).toContain('viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet"');
    expect(svg).toContain('<path d="M0 0L24 24" fill="currentColor" stroke="#123456"');
    expect(svg).toMatch(/<g transform="rotate\(30 /);
  });
});
