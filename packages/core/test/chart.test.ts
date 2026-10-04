import { describe, it, expect } from "vitest";
import {
  applyOperations,
  chartDataSchema,
  chartFromTable,
  chartGeometry,
  chartScene,
  chartTicks,
  chartToMarkdown,
  createTable,
  LEGEND_NAME_CHARS,
  createWorkspace,
  inverseOperations,
  parseNumericCell,
  validateOperations,
  workspaceSchema,
  type ChartData,
  type Operation,
} from "../src/index.js";

/**
 * Data charts (docs/26 §6.1 V4): a `chart` object kind bound to tabular data,
 * drawn from one geometry the canvas and export share.
 */

describe("parseNumericCell", () => {
  it("reads numbers, strips currency/percent/thousands, rejects text", () => {
    expect(parseNumericCell("1,234")).toBe(1234);
    expect(parseNumericCell("$42")).toBe(42);
    expect(parseNumericCell("87%")).toBe(87);
    expect(parseNumericCell("-3.5")).toBe(-3.5);
    expect(parseNumericCell("n/a")).toBeNull();
    expect(parseNumericCell("")).toBeNull();
    expect(parseNumericCell(undefined)).toBeNull();
  });
});

describe("chartFromTable", () => {
  it("uses the first column as labels and numeric columns as series", () => {
    const table = createTable(
      ["Quarter", "Revenue", "Region"],
      [
        ["Q1", "100", "EU"],
        ["Q2", "140", "US"],
        ["Q3", "120", "EU"],
      ],
    );
    const chart = chartFromTable(table, { type: "bar", title: "Sales" });
    expect(chart).not.toBeNull();
    expect(chart!.type).toBe("bar");
    expect(chart!.title).toBe("Sales");
    expect(chart!.labels).toEqual(["Q1", "Q2", "Q3"]);
    // Only the numeric "Revenue" column becomes a series; text "Region" is skipped.
    expect(chart!.series.map((s) => s.name)).toEqual(["Revenue"]);
    expect(chart!.series[0]!.values).toEqual([100, 140, 120]);
  });

  it("returns null when no column is numeric", () => {
    const table = createTable(["Name", "City"], [["Ada", "London"]]);
    expect(chartFromTable(table)).toBeNull();
  });
});

describe("chartDataSchema", () => {
  it("accepts a valid chart and requires at least one series", () => {
    const ok: ChartData = {
      type: "pie",
      labels: ["A", "B"],
      series: [{ name: "n", values: [1, 2] }],
    };
    expect(chartDataSchema.safeParse(ok).success).toBe(true);
    expect(chartDataSchema.safeParse({ type: "bar", labels: [], series: [] }).success).toBe(false);
  });
});

describe("chartGeometry", () => {
  const bar: ChartData = {
    type: "bar",
    title: "T",
    labels: ["A", "B"],
    series: [{ name: "s", values: [4, 8] }],
  };

  it("produces finite primitives for each chart type", () => {
    for (const type of ["bar", "line", "pie"] as const) {
      const prims = chartGeometry({ ...bar, type }, 320, 220);
      expect(prims.length).toBeGreaterThan(0);
      for (const p of prims) {
        if (p.kind === "rect") expect(Number.isFinite(p.x) && Number.isFinite(p.h)).toBe(true);
        if (p.kind === "path") expect(p.d.length).toBeGreaterThan(0);
      }
    }
  });

  it("draws one bar per value for a single series", () => {
    const rects = chartGeometry(bar, 320, 220).filter((p) => p.kind === "rect");
    // Two bars; no legend rect for a single series.
    expect(rects.length).toBe(2);
  });
});

type Prim = ReturnType<typeof chartGeometry>[number];
const isRect = (p: Prim): p is Extract<Prim, { kind: "rect" }> => p.kind === "rect";
const isText = (p: Prim): p is Extract<Prim, { kind: "text" }> => p.kind === "text";

/** The vertical extent a primitive occupies (text: its cap height above the baseline). */
function yRange(p: Prim): [number, number] {
  if (p.kind === "rect") return [p.y, p.y + p.h];
  if (p.kind === "text") return [p.y - p.size, p.y];
  if (p.kind === "line") return [Math.min(p.y1, p.y2), Math.max(p.y1, p.y2)];
  if (p.kind === "polyline")
    return [Math.min(...p.points.map((q) => q[1])), Math.max(...p.points.map((q) => q[1]))];
  return [0, 0];
}

describe("chartGeometry: negative values", () => {
  const data: ChartData = {
    type: "bar",
    labels: ["Q1", "Q2", "Q3"],
    series: [{ name: "Profit", values: [40, -25, 10] }],
  };

  it("sits the category axis at zero and draws a negative bar down from it", () => {
    const scene = chartScene(data, 320, 220);
    const axes = scene.prims.filter((p) => p.kind === "line" && p.role === "axis");
    const zero = axes.find((p) => p.kind === "line" && p.y1 === p.y2)!;
    expect(zero).toBeDefined();
    const zeroY = zero.kind === "line" ? zero.y1 : NaN;
    // Zero is inside the plot, not on its bottom edge: there is room below it.
    const { plot } = scene.layout;
    expect(zeroY).toBeGreaterThan(plot.y);
    expect(zeroY).toBeLessThan(plot.y + plot.h);

    const bars = scene.prims.filter(isRect).filter((p) => p.role === "mark");
    expect(bars).toHaveLength(3);
    const [up, down, small] = bars as [(typeof bars)[0], (typeof bars)[0], (typeof bars)[0]];
    // Positive bars end at the zero line; the negative one starts there.
    expect(up.y + up.h).toBeCloseTo(zeroY);
    expect(small.y + small.h).toBeCloseTo(zeroY);
    expect(down.y).toBeCloseTo(zeroY);
    expect(down.h).toBeGreaterThan(0);
    // Magnitudes are to scale: |−25| is 2.5× 10.
    expect(down.h / small.h).toBeCloseTo(2.5);
    // Everything stays inside the plot.
    for (const b of bars) {
      expect(b.y).toBeGreaterThanOrEqual(plot.y - 0.01);
      expect(b.y + b.h).toBeLessThanOrEqual(plot.y + plot.h + 0.01);
    }
    // The tick labels read a negative value.
    expect(
      scene.prims.filter(isText).some((t) => t.role === "tick" && t.text.startsWith("-")),
    ).toBe(true);
  });

  it("puts a line's negative points below the zero line", () => {
    const scene = chartScene({ ...data, type: "line" }, 320, 220);
    const zero = scene.prims.find((p) => p.kind === "line" && p.role === "axis" && p.y1 === p.y2);
    const line = scene.prims.find((p) => p.kind === "polyline");
    if (zero?.kind !== "line" || line?.kind !== "polyline") throw new Error("missing primitives");
    expect(line.points[1]![1]).toBeGreaterThan(zero.y1);
    expect(line.points[0]![1]).toBeLessThan(zero.y1);
  });

  it("ticks include zero when the range spans it", () => {
    expect(chartTicks(-25, 40, 4)).toContain(0);
    const t = chartTicks(0, 1, 5);
    expect(t[0]).toBe(0);
    expect(t[t.length - 1]).toBe(1);
    expect(t).toContain(0.2);
  });

  it("leaves negative values out of a pie, and says so", () => {
    const prims = chartGeometry({ ...data, type: "pie" }, 320, 220);
    expect(prims.filter((p) => p.kind === "path")).toHaveLength(2);
    expect(prims.filter(isText).some((t) => t.role === "note" && /negative/i.test(t.text))).toBe(
      true,
    );
    // All non-positive: nothing to slice, but still a message rather than a blank box.
    const none = chartGeometry(
      { ...data, type: "pie", series: [{ name: "x", values: [-1, 0] }] },
      320,
      220,
    );
    expect(none.filter((p) => p.kind === "path")).toHaveLength(0);
    expect(none.filter(isText).some((t) => /no positive values/i.test(t.text))).toBe(true);
  });
});

describe("chartGeometry: the legend keeps to its own band", () => {
  const longName = (i: number) =>
    `Series ${i} ${"with a very long descriptive name ".repeat(4)}`.slice(0, 120);
  const many: ChartData = {
    type: "bar",
    title: "Quarterly revenue by region and channel",
    labels: ["Q1", "Q2", "Q3", "Q4"],
    series: Array.from({ length: 12 }, (_, i) => ({ name: longName(i), values: [1, 2, 3, 4] })),
  };

  const overlaps = (a: [number, number], b: [number, number]) =>
    a[0] < b[1] - 0.01 && b[0] < a[1] - 0.01;

  for (const [w, h] of [
    [320, 220],
    [640, 400],
    [180, 140],
  ] as const) {
    it(`at ${w}×${h}: no overlap with the title or the plot, names capped with an ellipsis`, () => {
      const { prims, layout } = chartScene(many, w, h);
      const legend = layout.legend!;
      const title = layout.title!;
      expect(legend).toBeDefined();
      // The reserved bands are disjoint, top to bottom.
      expect(legend.y).toBeGreaterThanOrEqual(title.y + title.h);
      expect(layout.plot.y).toBeGreaterThanOrEqual(legend.y + legend.h);
      // The legend band is bounded, however many series there are.
      expect(legend.h).toBeLessThanOrEqual(3 * 14);

      const legendPrims = prims.filter((p) => p.role === "legend");
      expect(legendPrims.length).toBeGreaterThan(0);
      for (const p of legendPrims) {
        const [top, bottom] = yRange(p);
        expect(top).toBeGreaterThanOrEqual(legend.y - 0.01);
        expect(bottom).toBeLessThanOrEqual(legend.y + legend.h + 0.01);
        if (p.kind === "rect") {
          expect(p.x).toBeGreaterThanOrEqual(legend.x);
          expect(p.x + p.w).toBeLessThanOrEqual(legend.x + legend.w + 0.01);
        }
      }
      for (const p of prims.filter((q) => q.role === "title" || q.role === "mark")) {
        expect(overlaps(yRange(p), [legend.y, legend.y + legend.h])).toBe(false);
      }

      const names = legendPrims.filter(isText).filter((t) => !t.text.startsWith("+"));
      for (const t of names) {
        expect(Array.from(t.text).length).toBeLessThanOrEqual(LEGEND_NAME_CHARS);
        expect(t.text.endsWith("…")).toBe(true);
        expect(t.full).toMatch(/^Series \d+ with/);
      }
      // Whatever doesn't fit is counted, not drawn over the plot.
      const swatches = legendPrims.filter((p) => p.kind === "rect").length;
      const more = legendPrims.filter(isText).find((t) => t.text.startsWith("+"));
      if (swatches < 12) expect(more?.text).toBe(`+${12 - swatches} more`);
      else expect(more).toBeUndefined();
      if (w <= 320) expect(swatches).toBeLessThan(12);
    });
  }

  it("ellipsizes a title wider than the box and keeps the full text", () => {
    const t = chartGeometry({ ...many, title: "T".repeat(200) }, 200, 160)
      .filter(isText)
      .find((p) => p.role === "title")!;
    expect(t.text.endsWith("…")).toBe(true);
    expect(t.text.length * 13 * 0.6).toBeLessThanOrEqual(200);
    expect(t.full).toBe("T".repeat(200));
  });

  it("keeps a pie's legend column clear of the pie", () => {
    const pie: ChartData = {
      type: "pie",
      title: "Share",
      labels: Array.from({ length: 30 }, (_, i) => longName(i)),
      series: [{ name: "v", values: Array.from({ length: 30 }, (_, i) => i + 1) }],
    };
    const { prims, layout } = chartScene(pie, 320, 220);
    const legend = layout.legend!;
    expect(legend.x).toBeGreaterThanOrEqual(layout.plot.x + layout.plot.w);
    expect(legend.y + legend.h).toBeLessThanOrEqual(220);
    for (const p of prims.filter((q) => q.role === "legend")) {
      const [top, bottom] = yRange(p);
      expect(top).toBeGreaterThanOrEqual(legend.y - 0.01);
      expect(bottom).toBeLessThanOrEqual(legend.y + legend.h + 0.01);
    }
    expect(
      prims.filter(isText).some((t) => t.role === "legend" && /^\+\d+ more$/.test(t.text)),
    ).toBe(true);
  });
});

describe("chartToMarkdown", () => {
  it("renders the data as a titled Markdown table", () => {
    const md = chartToMarkdown({
      type: "line",
      title: "Sales",
      labels: ["Q1", "Q2"],
      series: [
        { name: "EU", values: [1, 2.5] },
        { name: "US", values: [-3] },
      ],
    });
    expect(md).toContain("**Sales** _(line chart)_");
    expect(md).toContain("| Label | EU | US |");
    expect(md).toContain("| Q1 | 1 | -3 |");
    expect(md).toContain("| Q2 | 2.5 |  |");
  });
});

describe("chart shapes through the op contract", () => {
  const chart = chartFromTable(
    createTable(
      ["Q", "V"],
      [
        ["Q1", "3"],
        ["Q2", "6"],
      ],
    ),
    { type: "line" },
  )!;
  const create: Operation = {
    op: "CREATE_SHAPE",
    id: "c1",
    kind: "chart",
    position: { x: 0, y: 0 },
    size: { width: 320, height: 220 },
    chart,
  };

  it("validates, reduces, and round-trips a stored board", () => {
    expect(validateOperations(createWorkspace(), [create])).toEqual([]);
    const ws = applyOperations(createWorkspace(), [create]);
    expect(ws.shapes.c1?.kind).toBe("chart");
    expect(ws.shapes.c1?.chart).toEqual(chart);
    const parsed = workspaceSchema.parse(JSON.parse(JSON.stringify(ws)));
    expect(parsed.shapes.c1?.chart).toEqual(chart);
  });

  it("undo removes the chart shape", () => {
    const ws = applyOperations(createWorkspace(), [create]);
    const back = applyOperations(ws, inverseOperations([create], createWorkspace()));
    expect(back.shapes.c1).toBeUndefined();
  });

  it("drops a malformed chart on load rather than refusing the board", () => {
    const ws = applyOperations(createWorkspace(), [create]);
    const raw = JSON.parse(JSON.stringify(ws));
    raw.shapes.c1.chart = { type: "bogus" };
    const parsed = workspaceSchema.parse(raw);
    expect(parsed.shapes.c1?.kind).toBe("chart");
    expect(parsed.shapes.c1?.chart).toBeUndefined();
  });
});
