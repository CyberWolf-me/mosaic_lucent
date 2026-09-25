import { describe, expect, it } from "vitest";
import {
  applyOperations,
  createTable,
  createWorkspace,
  TABLE_LIMITS,
  tableDataSchema,
  validateOperations,
  type Operation,
  type Shape,
} from "@lucent/core";
import {
  delimitedToTableOp,
  pastedTableOp,
  tableShapeSize,
  TABLE_TRIM_NOTE,
} from "../src/board/importers.js";
import { chartBesideTableOp } from "../src/shapes.js";
import { nextTableCell, setTableCursor } from "../src/ui/TableView.js";

/**
 * Tables and charts made usable (docs/26 §6.1 V4): a CSV or a spreadsheet
 * paste lands as ONE table shape, and a table charts into a chart shape beside
 * it — each through an operation the validator accepts.
 */

const accepted = (ops: Operation[]) =>
  expect(validateOperations(createWorkspace(), ops)).toEqual([]);

describe("CSV / TSV import → one table shape", () => {
  it("turns a dropped CSV into a single valid table op at the drop point", () => {
    const r = delimitedToTableOp(
      "Task,Owner,Points\nDesign,Alex,3\nBuild,Sam,5\n",
      { x: 260, y: 200 },
      4,
    )!;
    expect(r.truncated).toBe(false);
    expect(r.op.kind).toBe("table");
    expect(r.op.position).toEqual({ x: 260, y: 200 });
    expect(r.op.z).toBe(4);
    expect(r.op.table?.columns.map((c) => c.header)).toEqual(["Task", "Owner", "Points"]);
    expect(r.op.table?.rows).toHaveLength(2);
    accepted([r.op]);
  });

  it("splits a .tsv on tabs even when its cells hold commas", () => {
    const r = delimitedToTableOp("City\tNote\nParis\tbig, old\n", { x: 0, y: 0 }, 1, "\t")!;
    expect(r.op.table?.rows[0]).toEqual({ cells: ["Paris", "big, old"] });
  });

  it("returns null for an empty file", () => {
    expect(delimitedToTableOp("  \n\n", { x: 0, y: 0 }, 1)).toBeNull();
  });

  it("trims an oversized file to the limits, flags it, and still validates", () => {
    const csv = ["n", ...Array.from({ length: 700 }, (_, i) => String(i))].join("\n");
    const r = delimitedToTableOp(csv, { x: 0, y: 0 }, 1)!;
    expect(r.truncated).toBe(true);
    expect(r.op.table?.rows).toHaveLength(TABLE_LIMITS.rows);
    expect(tableDataSchema.safeParse(r.op.table).success).toBe(true);
    accepted([r.op]);
    expect(TABLE_TRIM_NOTE).toMatch(/500 rows, 26 columns and 200,000 characters/);
  });
});

describe("pasted text → table only when it is a grid", () => {
  it("pastes a spreadsheet copy as a table centred on the paste point", () => {
    const r = pastedTableOp("Name\tScore\nAda\t9\nGrace\t10\n", { x: 500, y: 300 }, 7)!;
    expect(r.op.kind).toBe("table");
    const { width, height } = r.op.size;
    expect(r.op.position).toEqual({
      x: Math.round(500 - width / 2),
      y: Math.round(300 - height / 2),
    });
    accepted([r.op]);
  });

  it("leaves a sentence with a comma to the ordinary text paste", () => {
    expect(pastedTableOp("Hi Bob, how are you?", { x: 0, y: 0 }, 1)).toBeNull();
    expect(
      pastedTableOp("Ship it by Friday, then rest.\nOr not, we'll see.", { x: 0, y: 0 }, 1),
    ).toBeNull();
  });
});

describe("tableShapeSize", () => {
  it("sizes to the content, within bounds", () => {
    const small = tableShapeSize(
      createTable(
        ["A", "B"],
        [
          ["1", "2"],
          ["3", "4"],
          ["5", "6"],
        ],
      ),
    );
    expect(small.width).toBeGreaterThanOrEqual(200);
    // A header line plus one line per row.
    expect(small.height).toBe(4 * 25 + 2);
    expect(tableShapeSize(createTable(["A"])).height).toBe(64);
    const wide = tableShapeSize(
      createTable(
        Array.from({ length: 26 }, (_, i) => `A long header ${i}`),
        Array.from({ length: 500 }, () => ["x"]),
      ),
    );
    expect(wide.width).toBe(960);
    expect(wide.height).toBe(480);
    // A long cell widens its column only up to the renderer's cell cap.
    const one = tableShapeSize(createTable(["A"], [["y".repeat(2000)]]));
    expect(one.width).toBeLessThanOrEqual(240 + 17);
  });
});

describe("Chart this table", () => {
  const table: Shape = {
    id: "t1",
    kind: "table",
    position: { x: 100, y: 50 },
    size: { width: 300, height: 140 },
    table: createTable(
      ["Quarter", "Revenue", "Region"],
      [
        ["Q1", "100", "EU"],
        ["Q2", "-20", "US"],
      ],
    ),
  };

  it("creates a chart beside the table, bound to its numbers", () => {
    const op = chartBesideTableOp(table, 3)!;
    expect(op.kind).toBe("chart");
    expect(op.position).toEqual({ x: 100 + 300 + 40, y: 50 });
    expect(op.chart?.labels).toEqual(["Q1", "Q2"]);
    expect(op.chart?.series).toEqual([{ name: "Revenue", values: [100, -20] }]);
    // One series has no legend, so its header titles the chart.
    expect(op.chart?.title).toBe("Revenue");
    const ws = applyOperations(createWorkspace(), [
      {
        op: "CREATE_SHAPE",
        id: "t1",
        kind: "table",
        position: table.position,
        size: table.size,
        table: table.table!,
      },
    ]);
    expect(validateOperations(ws, [op])).toEqual([]);
  });

  it("leaves a multi-series chart untitled (its legend names the series)", () => {
    const two: Shape = {
      ...table,
      table: createTable(["Q", "EU", "US"], [["Q1", "1", "2"]]),
    };
    const op = chartBesideTableOp(two, 1, "line")!;
    expect(op.chart?.type).toBe("line");
    expect(op.chart?.title).toBeUndefined();
    expect(op.chart?.series.map((s) => s.name)).toEqual(["EU", "US"]);
  });

  it("returns null when no column is numeric", () => {
    expect(
      chartBesideTableOp({ ...table, table: createTable(["A", "B"], [["x", "y"]]) }, 1),
    ).toBeNull();
    expect(chartBesideTableOp({ ...table, table: undefined }, 1)).toBeNull();
  });
});

describe("table editing helpers", () => {
  const t = createTable(
    ["A", "B"],
    [
      ["1", "2"],
      ["3", "4"],
    ],
  );

  it("Tab walks the header, then each row; Shift+Tab walks back", () => {
    expect(nextTableCell(t, { row: -1, col: 0 }, 1)).toEqual({ row: -1, col: 1 });
    expect(nextTableCell(t, { row: -1, col: 1 }, 1)).toEqual({ row: 0, col: 0 });
    expect(nextTableCell(t, { row: 1, col: 1 }, 1)).toBeNull();
    expect(nextTableCell(t, { row: 0, col: 0 }, -1)).toEqual({ row: -1, col: 1 });
    expect(nextTableCell(t, { row: -1, col: 0 }, -1)).toBeNull();
  });

  it("the cursor store takes and clears a cell without error outside React", () => {
    expect(() => {
      setTableCursor("t1", { row: 0, col: 1 });
      setTableCursor("t1", { row: 0, col: 1 });
      setTableCursor("t1", null);
    }).not.toThrow();
  });
});
