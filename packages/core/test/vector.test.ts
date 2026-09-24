import { describe, expect, it } from "vitest";
import {
  applyOperations,
  createWorkspace,
  importSvg,
  inverseOperations,
  normalizePathData,
  parseTransform,
  parseWorkspace,
  recolorVector,
  safeParseProgrammaticOperations,
  scaleVectorStrokes,
  sketchToVector,
  validateOperations,
  vectorDataSchema,
  vectorPalette,
  vectorToSvg,
  withoutBackground,
  type Operation,
  type VectorData,
} from "@lucent/core";

/**
 * docs/26 §6.3 (V2): an editable vector is structured paths, and SVG text only
 * enters through the sanitizing importer. These pin that nothing but path data
 * and literal paint survives an import, that geometry survives it faithfully,
 * and that vectors behave like every other shape in the op contract.
 */

const ok = (svg: string) => {
  const r = importSvg(svg);
  if (!r.ok) throw new Error(r.error);
  return r;
};

describe("path normalization", () => {
  it("resolves relative, shorthand and implicit commands to absolute M/L/C/Q/Z", () => {
    expect(normalizePathData("m10 10 h5 v5 l-5 0 z")).toBe("M10 10L15 10L15 15L10 15Z");
    // implicit lineto after moveto, and exponent notation
    expect(normalizePathData("M0 0 1e1 0 10 10")).toBe("M0 0L10 0L10 10");
    // S reflects the previous control point
    expect(normalizePathData("M0 0C0 10 10 10 10 0S20 -10 20 0")).toBe(
      "M0 0C0 10 10 10 10 0C10 -10 20 -10 20 0",
    );
    // T reflects the previous quadratic control
    expect(normalizePathData("M0 0Q5 10 10 0T20 0")).toBe("M0 0Q5 10 10 0Q15 -10 20 0");
  });

  it("turns arcs into cubics that land exactly on the arc's end", () => {
    const d = normalizePathData("M0 10 A10 10 0 0 1 10 0")!;
    expect(d).toMatch(/^M0 10C/);
    expect(d.endsWith(" 10 0")).toBe(true);
    // Compact flags: "a1 1 0 01.5.5" is flags 0 and 1, then 1.5 and .5.
    expect(normalizePathData("M0 0a1 1 0 01.5.5")).not.toBeNull();
  });

  it("applies transforms, composing left to right", () => {
    expect(normalizePathData("M0 0L10 0", parseTransform("translate(5 5)"))).toBe("M5 5L15 5");
    expect(normalizePathData("M0 0L10 0", parseTransform("scale(2)"))).toBe("M0 0L20 0");
    expect(normalizePathData("M10 0L20 0", parseTransform("rotate(90)"))).toBe("M0 10L0 20");
    expect(normalizePathData("M0 0L1 0", parseTransform("translate(10 0) scale(3)"))).toBe(
      "M10 0L13 0",
    );
  });

  it("refuses malformed data rather than guessing", () => {
    expect(normalizePathData('M0 0" onload="x')).toBeNull();
    expect(normalizePathData("L10 10 garbage")).toBeNull();
    expect(normalizePathData("M5 5")).toBeNull();
  });
});

describe("importSvg: what comes out", () => {
  it("an Iconoir outline icon keeps its strokes and takes the shape's ink", () => {
    const r = ok(
      '<svg width="24" height="24" stroke-width="1.5" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5 12V18C5 18 5 21 12 21" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    );
    expect(r.vector.viewBox).toEqual([0, 0, 24, 24]);
    expect(r.vector.paths).toEqual([
      {
        d: "M5 12L5 18C5 18 5 21 12 21",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 1.5,
        cap: "round",
      },
    ]);
    expect([r.width, r.height]).toEqual([24, 24]);
  });

  it("a brand mark with no fill stays theme ink (fill unset)", () => {
    const r = ok(
      '<svg role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><title>X</title><path d="M0 0h24v24H0z"/></svg>',
    );
    expect(r.vector.paths).toEqual([{ d: "M0 0L24 0L24 24L0 24Z" }]);
  });

  it("resolves styles: stylesheet classes, inline style, inheritance, named colours, gradients", () => {
    const r = ok(`<svg viewBox="0 0 100 100">
      <defs>
        <style>.st0{fill:#FF0000}.st1{fill:none;stroke:navy;stroke-width:4}</style>
        <linearGradient id="g"><stop offset="0" stop-color="#00ff00"/><stop offset="1" stop-color="#0000ff"/></linearGradient>
      </defs>
      <g fill="orange" opacity="0.5">
        <rect class="st0" x="0" y="0" width="10" height="10"/>
        <rect x="20" y="0" width="10" height="10"/>
        <rect x="40" y="0" width="10" height="10" style="fill: rgba(1,2,3,0.5)"/>
      </g>
      <circle class="st1" cx="50" cy="50" r="10"/>
      <rect x="60" y="60" width="10" height="10" fill="url(#g)"/>
      <rect x="80" y="80" width="10" height="10" style="display:none"/>
    </svg>`);
    const fills = r.vector.paths.map((p) => p.fill);
    expect(fills).toEqual(["#ff0000", "#ffa500", "rgba(1,2,3,0.5)", "none", "#00ff00"]);
    expect(r.vector.paths[0]!.opacity).toBe(0.5);
    expect(r.vector.paths[3]).toMatchObject({ stroke: "#000080", strokeWidth: 4 });
    expect(r.vector.paths[3]!.d).toMatch(/C/); // the circle became curves
  });

  it("flattens nested group transforms, and <use>/<symbol> with x/y", () => {
    const r = ok(`<svg viewBox="0 0 100 100">
      <defs><symbol id="dot"><rect width="2" height="2"/></symbol></defs>
      <g transform="translate(10 10)"><g transform="scale(2)"><rect width="5" height="5"/></g></g>
      <use href="#dot" x="50" y="60"/>
    </svg>`);
    expect(r.vector.paths.map((p) => p.d)).toEqual([
      "M10 10L20 10L20 20L10 20Z",
      "M50 60L52 60L52 62L50 62Z",
    ]);
  });

  it("scales stroke width with the transform", () => {
    const r = ok(
      '<svg viewBox="0 0 10 10"><g transform="scale(3)"><line x1="0" y1="0" x2="1" y2="1" stroke="#123456" stroke-width="2"/></g></svg>',
    );
    expect(r.vector.paths[0]).toMatchObject({ fill: "none", stroke: "#123456", strokeWidth: 6 });
  });

  it("falls back to width/height, then to the drawing's bounds, for the viewBox", () => {
    expect(
      ok('<svg width="40px" height="20"><rect width="4" height="4"/></svg>').vector.viewBox,
    ).toEqual([0, 0, 40, 20]);
    expect(ok('<svg><rect x="5" y="5" width="10" height="20"/></svg>').vector.viewBox).toEqual([
      5, 5, 10, 20,
    ]);
  });
});

describe("importSvg: what never comes out", () => {
  const hostile = `<?xml version="1.0"?>
  <!DOCTYPE svg [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]>
  <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10" onload="alert(1)">
    <script>alert(document.cookie)</script>
    <foreignObject width="10" height="10"><iframe src="https://evil.example"></iframe><rect width="9" height="9"/></foreignObject>
    <image href="javascript:alert(1)" width="10" height="10"/>
    <use xlink:href="https://evil.example/sprite.svg#icon"/>
    <use href="javascript:alert(1)"/>
    <text x="0" y="5">&b;</text>
    <a href="javascript:alert(1)"><rect width="3" height="3" fill="red" onclick="alert(1)"/></a>
    <path d="M0 0L5 5" stroke="url(javascript:alert(1))" fill="expression(alert(1))"/>
  </svg>`;

  it("keeps only drawable geometry and literal paint", () => {
    const r = ok(hostile);
    const text = JSON.stringify(r.vector);
    for (const bad of [
      "script",
      "alert",
      "javascript",
      "evil",
      "iframe",
      "onload",
      "onclick",
      "expression",
      "&",
    ]) {
      expect(text).not.toContain(bad);
    }
    // The link's rect survives as geometry; the path with junk paint is dropped
    // to "unset fill" (theme ink) rather than carrying the junk.
    expect(r.vector.paths[0]).toEqual({ d: "M0 0L3 0L3 3L0 3Z", fill: "#ff0000" });
    expect(r.dropped).toEqual(expect.arrayContaining(["script", "foreignObject", "image", "text"]));
  });

  it("a self-referencing <use> can't loop", () => {
    const r = importSvg(
      '<svg viewBox="0 0 10 10"><g id="a"><use href="#a"/><rect width="1" height="1"/></g></svg>',
    );
    expect(r.ok).toBe(true);
  });

  it("refuses what it can't honestly import", () => {
    expect(importSvg("not svg at all").ok).toBe(false);
    expect(importSvg('<svg viewBox="0 0 1 1"><text>hi</text></svg>').ok).toBe(false);
    const many = `<svg viewBox="0 0 10 10">${'<rect width="1" height="1"/>'.repeat(2_100)}</svg>`;
    const r = importSvg(many);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/too detailed/);
  });

  it("the schema refuses markup and junk paint in a vector, whatever produced it", () => {
    const base: VectorData = { viewBox: [0, 0, 10, 10], paths: [{ d: "M0 0L1 1" }] };
    expect(vectorDataSchema.safeParse(base).success).toBe(true);
    expect(vectorDataSchema.safeParse({ ...base, paths: [{ d: "<script>" }] }).success).toBe(false);
    expect(
      vectorDataSchema.safeParse({ ...base, paths: [{ d: "M0 0L1 1", fill: "url(#x)" }] }).success,
    ).toBe(false);
    expect(vectorDataSchema.safeParse({ ...base, viewBox: [0, 0, 0, 10] }).success).toBe(false);
  });
});

describe("vector shapes in the op contract", () => {
  const vector: VectorData = {
    viewBox: [0, 0, 24, 24],
    paths: [{ d: "M0 0L24 24", stroke: "#123456", strokeWidth: 2, fill: "none" }],
  };
  const create: Operation = {
    op: "CREATE_SHAPE",
    id: "v1",
    kind: "vector",
    position: { x: 10, y: 10 },
    size: { width: 48, height: 48 },
    vector,
  };

  it("creates, parses strictly, and survives a stored-board round trip", () => {
    expect(safeParseProgrammaticOperations([create]).success).toBe(true);
    const ws = applyOperations(createWorkspace(), [create]);
    expect(ws.shapes.v1?.vector).toEqual(vector);
    const back = parseWorkspace(JSON.parse(JSON.stringify(ws)));
    expect(back.ok && back.workspace.shapes.v1?.vector).toEqual(vector);
  });

  it("only a vector shape carries paths, and a vector shape must", () => {
    const ws = createWorkspace();
    expect(
      validateOperations(ws, [{ ...create, vector: undefined } as Operation]),
    ).not.toHaveLength(0);
    expect(validateOperations(ws, [{ ...create, kind: "rect" } as Operation])).not.toHaveLength(0);
  });

  it("an edit and a delete both undo exactly", () => {
    const before = applyOperations(createWorkspace(), [create]);
    const recolor: Operation[] = [
      { op: "UPDATE_SHAPE", id: "v1", vector: recolorVector(vector, "#123456", "#ff0000") },
    ];
    const after = applyOperations(before, recolor);
    expect(after.shapes.v1?.vector?.paths[0]?.stroke).toBe("#ff0000");
    expect(applyOperations(after, inverseOperations(recolor, before)).shapes.v1?.vector).toEqual(
      vector,
    );

    const del: Operation[] = [{ op: "DELETE_SHAPE", id: "v1" }];
    const gone = applyOperations(before, del);
    expect(applyOperations(gone, inverseOperations(del, before)).shapes.v1?.vector).toEqual(vector);
  });

  it("a stored vector that no longer parses drops, and the board still loads", () => {
    const ws = JSON.parse(JSON.stringify(applyOperations(createWorkspace(), [create])));
    ws.shapes.v1.vector.paths[0].d = '"><script>';
    const r = parseWorkspace(ws);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.workspace.shapes.v1?.vector).toBeUndefined();
  });
});

describe("editing helpers", () => {
  const v: VectorData = {
    viewBox: [0, 0, 10, 10],
    paths: [
      { d: "M0 0L1 1", fill: "#ff0000" },
      { d: "M0 0L2 2", fill: "#ff0000", stroke: "#00ff00", strokeWidth: 2 },
      { d: "M0 0L3 3" },
    ],
  };

  it("lists the palette by use and recolours one paint everywhere", () => {
    expect(vectorPalette(v)).toEqual(["#ff0000", "#00ff00", "currentColor"]);
    const r = recolorVector(v, "#ff0000", "#0000ff");
    expect(r.paths.map((p) => p.fill)).toEqual(["#0000ff", "#0000ff", undefined]);
    expect(recolorVector(v, "currentColor", "#111111").paths[2]!.fill).toBe("#111111");
    expect(recolorVector(v, "#ff0000", "currentColor").paths[0]).not.toHaveProperty("fill");
  });

  it("scales strokes and writes an escaped standalone SVG", () => {
    expect(scaleVectorStrokes(v, 1.5).paths[1]!.strokeWidth).toBe(3);
    const svg = vectorToSvg(v, 40, 40, '"><x');
    expect(svg).toMatch(
      /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="40" height="40" viewBox="0 0 10 10"/,
    );
    expect(svg).not.toContain('"><x');
  });

  it("turns pen strokes into one smooth vector at the strokes' bounds", () => {
    const r = sketchToVector([
      { d: "M0 0L10 1L20 0L30 1L40 0", x: 100, y: 200, stroke: "#123456", strokeWidth: 3 },
      { d: "M0 0L0 20", x: 150, y: 200 },
    ])!;
    expect(r.x).toBe(97);
    expect(r.y).toBe(197);
    expect(r.vector.paths).toHaveLength(2);
    expect(r.vector.paths[0]).toMatchObject({
      stroke: "#123456",
      strokeWidth: 3,
      fill: "none",
      cap: "round",
    });
    // RDP drops the near-colinear wobble: fewer curve segments than input points.
    expect((r.vector.paths[0]!.d.match(/C/g) ?? []).length).toBeLessThan(4);
    expect(vectorDataSchema.safeParse(r.vector).success).toBe(true);
    expect(sketchToVector([{ d: "garbage", x: 0, y: 0 }])).toBeNull();
  });
});

describe("withoutBackground", () => {
  const art = (first: string, rest = ["M4 4L6 6"]) =>
    ({
      viewBox: [0, 0, 100, 100],
      paths: [{ d: first, fill: "#ffffff" }, ...rest.map((d) => ({ d, fill: "#ff0000" }))],
    }) as VectorData;

  it("drops a full-canvas backdrop rectangle, keeps everything else", () => {
    expect(withoutBackground(art("M0 0L100 0L100 100L0 100Z")).paths).toHaveLength(1);
    // A shape that merely sits in the middle is art, not a backdrop.
    expect(withoutBackground(art("M10 10L90 10L90 90L10 90Z")).paths).toHaveLength(2);
    // A curved full-bleed shape is art too.
    expect(withoutBackground(art("M0 0C50 -10 100 0 100 100L0 100Z")).paths).toHaveLength(2);
    // Never strip the only path.
    expect(withoutBackground(art("M0 0L100 0L100 100L0 100Z", [])).paths).toHaveLength(1);
  });
});
