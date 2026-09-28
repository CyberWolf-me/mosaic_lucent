import { describe, expect, it } from "vitest";
import {
  combineVectors,
  flattenGradients,
  importSvg,
  parsePathData,
  pathExtent,
  recolorVector,
  simplifyVector,
  splitVector,
  vectorDataSchema,
  vectorPalette,
  vectorPathsMarkup,
  type VectorData,
} from "@lucent/core";

/**
 * docs/26 §6.3 editing, the parts V2 left: gradients kept whole (not
 * collapsed to one colour), split into parts, combine, and simplify. Each is a
 * pure VectorData → VectorData step the inspector turns into UPDATE_SHAPE or
 * DELETE/CREATE_SHAPE ops — so each must stay inside the schema.
 */

const ok = (svg: string) => {
  const r = importSvg(svg);
  if (!r.ok) throw new Error(r.error);
  return r.vector;
};

const anchors = (v: VectorData) =>
  v.paths.reduce((n, p) => n + (parsePathData(p.d) ?? []).filter((s) => s.t !== "Z").length, 0);

describe("gradients", () => {
  it("keeps a linear gradient whole, with the midpoint stop as the solid fallback", () => {
    const v = ok(`<svg viewBox="0 0 100 100">
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#ff0000"/>
        <stop offset="50%" stop-color="#00ff00" stop-opacity=".5"/>
        <stop offset="1" stop-color="#0000ff"/>
      </linearGradient>
      <rect width="100" height="100" fill="url(#g)"/>
    </svg>`);
    expect(v.paths[0]).toMatchObject({ fill: "#00ff00", fillGradient: 0 });
    expect(v.gradients).toEqual([
      {
        kind: "linear",
        units: "box",
        x1: 0,
        y1: 0,
        x2: 1,
        y2: 1,
        stops: [
          { offset: 0, color: "#ff0000" },
          { offset: 0.5, color: "#00ff00", opacity: 0.5 },
          { offset: 1, color: "#0000ff" },
        ],
      },
    ]);
    expect(vectorDataSchema.safeParse(v).success).toBe(true);
  });

  it("flattens user-space gradients through the element's transform, and follows href", () => {
    const v = ok(`<svg viewBox="0 0 100 100">
      <defs>
        <radialGradient id="base"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/></radialGradient>
        <radialGradient id="r" href="#base" gradientUnits="userSpaceOnUse" cx="10" cy="10" r="5"/>
      </defs>
      <g transform="translate(20 30) scale(2)">
        <circle cx="10" cy="10" r="5" fill="url(#r)"/>
      </g>
    </svg>`);
    expect(v.gradients?.[0]).toMatchObject({
      kind: "radial",
      units: "user",
      cx: 40,
      cy: 50,
      r: 10,
    });
    expect(v.gradients?.[0]!.stops.map((s) => s.color)).toEqual(["#fff", "#000"]);
  });

  it("shares one stored gradient between parts that use it, and one stop stays a colour", () => {
    const v = ok(`<svg viewBox="0 0 10 10">
      <linearGradient id="g"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient>
      <linearGradient id="one"><stop offset="0" stop-color="green"/></linearGradient>
      <rect width="4" height="4" fill="url(#g)"/>
      <rect x="5" width="4" height="4" fill="url(#g)"/>
      <rect y="5" width="4" height="4" fill="url(#one)"/>
    </svg>`);
    expect(v.gradients).toHaveLength(1);
    expect(v.paths.map((p) => p.fillGradient)).toEqual([0, 0, undefined]);
    expect(v.paths[2]!.fill).toBe("#008000");
  });

  it("draws as <defs> and url() references, ids kept apart per vector", () => {
    const v = ok(`<svg viewBox="0 0 10 10">
      <linearGradient id="g"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient>
      <rect width="10" height="10" fill="url(#g)" stroke="url(#g)"/>
    </svg>`);
    const markup = vectorPathsMarkup(v, "shp_1<x>");
    expect(markup).toContain('<linearGradient id="shp_1x-0" gradientUnits="objectBoundingBox"');
    expect(markup).toContain('fill="url(#shp_1x-0)"');
    expect(markup).toContain('stroke="url(#shp_1x-0)"');
    expect(markup).not.toContain("<x>");
  });

  it("recolours stops, lists them in the palette, and flattens to the fallback", () => {
    const v = ok(`<svg viewBox="0 0 10 10">
      <linearGradient id="g"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient>
      <rect width="10" height="10" fill="url(#g)"/>
    </svg>`);
    expect(vectorPalette(v)).toEqual(expect.arrayContaining(["#ff0000", "#0000ff"]));
    const blue = recolorVector(v, "#0000ff", "#00ff00");
    expect(blue.gradients![0]!.stops.map((s) => s.color)).toEqual(["#ff0000", "#00ff00"]);
    const flat = flattenGradients(v);
    expect(flat.gradients).toBeUndefined();
    expect(flat.paths[0]).not.toHaveProperty("fillGradient");
    expect(flat.paths[0]!.fill).toBe("#ff0000");
  });

  it("the schema refuses a reference to a gradient that isn't there", () => {
    const bad = { viewBox: [0, 0, 10, 10], paths: [{ d: "M0 0L1 1", fillGradient: 0 }] };
    expect(vectorDataSchema.safeParse(bad).success).toBe(false);
    const oneStop = {
      viewBox: [0, 0, 10, 10],
      paths: [{ d: "M0 0L1 1", fillGradient: 0 }],
      gradients: [
        {
          kind: "linear",
          units: "box",
          x1: 0,
          y1: 0,
          x2: 1,
          y2: 0,
          stops: [{ offset: 0, color: "#fff" }],
        },
      ],
    };
    expect(vectorDataSchema.safeParse(oneStop).success).toBe(false);
  });
});

describe("split into parts", () => {
  const v: VectorData = {
    viewBox: [0, 0, 100, 100],
    paths: [
      { d: "M10 10L30 10L30 30L10 30Z", fill: "#ff0000" },
      {
        d: "M50 50L90 90",
        fill: "none",
        stroke: "#000000",
        strokeWidth: 4,
        fillGradient: undefined,
      },
      { d: "M60 10L80 10L80 20L60 20Z", fillGradient: 0 },
    ].map((p) => {
      const q = { ...p };
      if (q.fillGradient === undefined) delete q.fillGradient;
      return q;
    }),
    gradients: [
      {
        kind: "linear",
        units: "user",
        x1: 60,
        y1: 0,
        x2: 80,
        y2: 0,
        stops: [
          { offset: 0, color: "#ffffff" },
          { offset: 1, color: "#000000" },
        ],
      },
    ],
    source: { generator: "import" },
  };

  it("makes one vector per path, each boxed at its drawn extent (strokes padded)", () => {
    const parts = splitVector(v);
    expect(parts).toHaveLength(3);
    expect(parts[0]!.box).toEqual({ x: 10, y: 10, width: 20, height: 20 });
    expect(parts[1]!.box).toEqual({ x: 48, y: 48, width: 44, height: 44 });
    // Path data is untouched; the viewBox moves to it.
    expect(parts[0]!.vector.paths[0]!.d).toBe(v.paths[0]!.d);
    expect(parts[0]!.vector.viewBox).toEqual([10, 10, 20, 20]);
    // Only the part that uses the gradient carries it, re-indexed.
    expect(parts[0]!.vector.gradients).toBeUndefined();
    expect(parts[2]!.vector.gradients).toHaveLength(1);
    expect(parts[2]!.vector.paths[0]!.fillGradient).toBe(0);
    for (const p of parts) expect(vectorDataSchema.safeParse(p.vector).success).toBe(true);
  });

  it("boxes a curve by what it draws, not by its control points", () => {
    const e = pathExtent("M0 0C0 100 100 100 100 0")!;
    expect(e.maxY).toBeGreaterThan(74);
    expect(e.maxY).toBeLessThan(76); // the control points reach 100; the curve 75
  });
});

describe("combine", () => {
  it("puts placed vectors back into one, at their union, sizes and strokes scaled", () => {
    const r = combineVectors([
      {
        vector: {
          viewBox: [0, 0, 10, 10],
          paths: [{ d: "M0 0L10 10", stroke: "#000000", strokeWidth: 1 }],
        },
        x: 100,
        y: 100,
        width: 20,
        height: 20,
      },
      {
        vector: { viewBox: [0, 0, 10, 10], paths: [{ d: "M0 0L10 0L10 10Z" }] },
        x: 140,
        y: 100,
        width: 20,
        height: 20,
        ink: "#ff0000",
      },
    ])!;
    expect(r).toMatchObject({ x: 100, y: 100, width: 60, height: 20 });
    expect(r.vector.viewBox).toEqual([0, 0, 60, 20]);
    expect(r.vector.paths[0]).toMatchObject({ d: "M0 0L20 20", strokeWidth: 2 });
    expect(r.vector.paths[1]!.d).toBe("M40 0L60 0L60 20Z");
    // The second part's ink differed from the combined shape's: it's kept as a colour.
    expect(r.vector.paths[1]!.fill).toBe("#ff0000");
  });

  it("split then combine lands every path where it was", () => {
    const v: VectorData = {
      viewBox: [0, 0, 100, 50],
      paths: [
        { d: "M10 10L30 10L30 30Z", fill: "#ff0000" },
        { d: "M60 20L90 20L90 40Z", fill: "#0000ff" },
      ],
    };
    // The shape is drawn 200×100: twice the viewBox.
    const placed = splitVector(v).map((p) => ({
      vector: p.vector,
      x: p.box.x * 2,
      y: p.box.y * 2,
      width: p.box.width * 2,
      height: p.box.height * 2,
    }));
    const r = combineVectors(placed)!;
    expect(r.vector.paths.map((p) => p.d)).toEqual(["M0 0L40 0L40 40Z", "M100 20L160 20L160 60Z"]);
    expect({ x: r.x, y: r.y }).toEqual({ x: 20, y: 20 });
  });
});

describe("simplify", () => {
  it("thins a dense polyline to its shape, and never adds points", () => {
    const pts = Array.from({ length: 200 }, (_, i) => `L${i / 2} ${i % 2 ? 0.01 : 0}`).join("");
    const v: VectorData = {
      viewBox: [0, 0, 100, 100],
      paths: [{ d: `M0 0${pts}L100 50L0 50Z`, fill: "#000000" }],
    };
    const r = simplifyVector(v);
    expect(r.before).toBe(203);
    expect(r.after).toBeLessThan(10);
    expect(anchors(r.vector)).toBe(r.after);
    expect(vectorDataSchema.safeParse(r.vector).success).toBe(true);
    // Running it again finds nothing more to take.
    expect(simplifyVector(r.vector).after).toBe(r.after);
  });

  it("keeps a curve a curve (and round), and drops filled specks", () => {
    const circle = ok(
      `<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40"/><rect x="5" y="5" width=".1" height=".1"/></svg>`,
    );
    // A dense traced-style outline of the same circle.
    const n = 180;
    const ring = Array.from({ length: n }, (_, i) => {
      const a = (i / n) * Math.PI * 2;
      return `${i ? "L" : "M"}${(50 + 40 * Math.cos(a)).toFixed(2)} ${(50 + 40 * Math.sin(a)).toFixed(2)}`;
    }).join("");
    const dense: VectorData = {
      viewBox: [0, 0, 100, 100],
      paths: [{ d: `${ring}Z` }, ...circle.paths.slice(1)],
    };
    const r = simplifyVector(dense);
    expect(r.vector.paths).toHaveLength(1); // the speck went
    expect(r.after).toBeLessThan(r.before / 3);
    // Every kept point is still on the circle.
    for (const s of parsePathData(r.vector.paths[0]!.d)!) {
      if (s.t === "Z") continue;
      expect(Math.abs(Math.hypot(s.x - 50, s.y - 50) - 40)).toBeLessThan(0.5);
    }
    // A real curve stays cubic, sampled and refitted, and shorter or untouched.
    const c = simplifyVector(circle);
    expect(c.vector.paths[0]!.d.length).toBeLessThanOrEqual(circle.paths[0]!.d.length);
    expect(c.vector.paths[0]!.d).toMatch(/C/);
  });

  it("keeps sharp corners sharp in a curved outline", () => {
    // A rounded top on a square bottom: the bottom corners must stay corners.
    const v: VectorData = {
      viewBox: [0, 0, 100, 100],
      paths: [{ d: "M10 50C10 0 90 0 90 50L90 90L10 90Z", fill: "#000000" }],
    };
    const r = simplifyVector(v, 0.5);
    const d = r.vector.paths[0]!.d;
    expect(d).toMatch(/L90 90/);
    expect(d).toMatch(/L10 90/);
  });

  it("never strips a vector to nothing", () => {
    const v: VectorData = { viewBox: [0, 0, 100, 100], paths: [{ d: "M1 1L1.1 1L1.1 1.1Z" }] };
    expect(simplifyVector(v).vector.paths).toHaveLength(1);
  });
});
