import { describe, it, expect } from "vitest";
import {
  applyOperations,
  chartDataSchema,
  chartFromTable,
  chartGeometry,
  createTable,
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
    const ok: ChartData = { type: "pie", labels: ["A", "B"], series: [{ name: "n", values: [1, 2] }] };
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

describe("chart shapes through the op contract", () => {
  const chart = chartFromTable(
    createTable(["Q", "V"], [["Q1", "3"], ["Q2", "6"]]),
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
