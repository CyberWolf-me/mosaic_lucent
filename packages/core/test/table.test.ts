import { describe, it, expect } from "vitest";
import {
  applyOperations,
  createTable,
  createWorkspace,
  inverseOperations,
  parseDelimited,
  tableDataSchema,
  tableToMarkdown,
  validateOperations,
  workspaceSchema,
  type Operation,
} from "../src/index.js";

/**
 * The `table` object kind (docs/26 §6.1 V4): structured data on a shape's
 * `table` field, mirroring how `vector` rides `shape.vector`.
 */

describe("createTable", () => {
  it("builds columns from headers and pads/keeps rows", () => {
    const t = createTable(["A", "B"], [["1", "2"], ["3"]]);
    expect(t.columns.map((c) => c.header)).toEqual(["A", "B"]);
    expect(t.rows).toEqual([{ cells: ["1", "2"] }, { cells: ["3"] }]);
  });

  it("clamps to the column and header limits and never yields zero columns", () => {
    const many = Array.from({ length: 40 }, (_, i) => `c${i}`);
    const t = createTable(many);
    expect(t.columns.length).toBe(26);
    expect(createTable([]).columns.length).toBe(1);
  });
});

describe("parseDelimited", () => {
  it("reads CSV with a header row", () => {
    const t = parseDelimited("name,role\nAda,Engineer\nGrace,Admiral");
    expect(t?.columns.map((c) => c.header)).toEqual(["name", "role"]);
    expect(t?.rows).toEqual([
      { cells: ["Ada", "Engineer"] },
      { cells: ["Grace", "Admiral"] },
    ]);
  });

  it("handles quoted fields with commas, quotes and newlines", () => {
    const t = parseDelimited('a,b\n"x, y","he said ""hi"""\n"line\nbreak",z');
    expect(t?.rows[0]).toEqual({ cells: ["x, y", 'he said "hi"'] });
    expect(t?.rows[1]).toEqual({ cells: ["line\nbreak", "z"] });
  });

  it("auto-detects TSV", () => {
    const t = parseDelimited("a\tb\tc\n1\t2\t3");
    expect(t?.columns.length).toBe(3);
    expect(t?.rows[0]).toEqual({ cells: ["1", "2", "3"] });
  });

  it("returns null for empty input", () => {
    expect(parseDelimited("   ")).toBeNull();
  });
});

describe("tableToMarkdown", () => {
  it("emits a GFM table with an alignment rule", () => {
    const md = tableToMarkdown(createTable(["A", "B"], [["1", "2"]]));
    expect(md).toContain("| A | B |");
    expect(md).toContain("| --- | --- |");
    expect(md).toContain("| 1 | 2 |");
  });
});

describe("tableDataSchema", () => {
  it("accepts a well-formed table and rejects one with no columns", () => {
    expect(tableDataSchema.safeParse(createTable(["A"], [["1"]])).success).toBe(true);
    expect(tableDataSchema.safeParse({ columns: [], rows: [] }).success).toBe(false);
  });
});

describe("table shapes through the op contract", () => {
  const table = createTable(["Name", "Owner"], [["Login", "Ada"]]);
  const create: Operation = {
    op: "CREATE_SHAPE",
    id: "t1",
    kind: "table",
    position: { x: 0, y: 0 },
    size: { width: 320, height: 140 },
    table,
  };

  it("validates, reduces onto the board, and round-trips a stored workspace", () => {
    expect(validateOperations(createWorkspace(), [create])).toEqual([]);
    const ws = applyOperations(createWorkspace(), [create]);
    expect(ws.shapes.t1?.kind).toBe("table");
    expect(ws.shapes.t1?.table).toEqual(table);
    // The stored shape parses back unchanged.
    const parsed = workspaceSchema.parse(JSON.parse(JSON.stringify(ws)));
    expect(parsed.shapes.t1?.table).toEqual(table);
  });

  it("undo removes the table shape (inverse of CREATE_SHAPE)", () => {
    const ws = applyOperations(createWorkspace(), [create]);
    const inverse = inverseOperations([create], createWorkspace());
    const back = applyOperations(ws, inverse);
    expect(back.shapes.t1).toBeUndefined();
  });

  it("undo restores a replaced table (inverse of UPDATE_SHAPE)", () => {
    const ws = applyOperations(createWorkspace(), [create]);
    const edit: Operation = {
      op: "UPDATE_SHAPE",
      id: "t1",
      table: createTable(["Name", "Owner"], [["Login", "Grace"]]),
    };
    const edited = applyOperations(ws, [edit]);
    const inverse = inverseOperations([edit], ws);
    const back = applyOperations(edited, inverse);
    expect(back.shapes.t1?.table).toEqual(table);
  });

  it("drops a malformed table on load rather than refusing the board", () => {
    const ws = applyOperations(createWorkspace(), [create]);
    const raw = JSON.parse(JSON.stringify(ws));
    raw.shapes.t1.table = { columns: "not an array" };
    const parsed = workspaceSchema.parse(raw);
    expect(parsed.shapes.t1?.kind).toBe("table");
    expect(parsed.shapes.t1?.table).toBeUndefined();
  });
});

describe("table and chart payloads belong to their own shape kinds", () => {
  const table = createTable(["Name", "Owner"], [["API", "Sam"]]);
  const chart = {
    type: "bar" as const,
    labels: ["Q1"],
    series: [{ name: "Revenue", values: [3] }],
  };
  const base = applyOperations(createWorkspace(), [
    { op: "CREATE_SHAPE", id: "note", kind: "sticky", position: { x: 0, y: 0 }, size: { width: 150, height: 110 }, text: "hi" },
    { op: "CREATE_SHAPE", id: "t1", kind: "table", position: { x: 0, y: 0 }, size: { width: 300, height: 120 }, table },
  ]);

  it("refuses a table or chart riding another kind, and a table or chart shape with no data", () => {
    const refused: Operation[][] = [
      [{ op: "CREATE_SHAPE", id: "x", kind: "sticky", position: { x: 0, y: 0 }, size: { width: 10, height: 10 }, table }],
      [{ op: "CREATE_SHAPE", id: "x", kind: "rect", position: { x: 0, y: 0 }, size: { width: 10, height: 10 }, chart }],
      [{ op: "CREATE_SHAPE", id: "x", kind: "table", position: { x: 0, y: 0 }, size: { width: 10, height: 10 } }],
      [{ op: "CREATE_SHAPE", id: "x", kind: "chart", position: { x: 0, y: 0 }, size: { width: 10, height: 10 } }],
      [{ op: "UPDATE_SHAPE", id: "note", table }],
      [{ op: "UPDATE_SHAPE", id: "t1", chart }],
    ];
    for (const ops of refused) expect(validateOperations(base, ops), JSON.stringify(ops[0])).not.toEqual([]);
  });

  it("knows the kind of a shape created earlier in the same batch", () => {
    const ops: Operation[] = [
      { op: "CREATE_SHAPE", id: "c1", kind: "chart", position: { x: 0, y: 0 }, size: { width: 200, height: 120 }, chart },
      { op: "UPDATE_SHAPE", id: "c1", chart: { ...chart, type: "line" } },
    ];
    expect(validateOperations(base, ops)).toEqual([]);
    expect(validateOperations(base, [...ops, { op: "UPDATE_SHAPE", id: "c1", table }])).not.toEqual([]);
  });

  it("undoing a table edit restores the previous table exactly", () => {
    const edit: Operation[] = [
      { op: "UPDATE_SHAPE", id: "t1", table: createTable(["Name", "Owner"], [["API", "Kim"]]) },
    ];
    const edited = applyOperations(base, edit);
    const undone = applyOperations(edited, inverseOperations(edit, base));
    expect(undone.shapes.t1?.table).toEqual(table);
  });

  it("caps a table's total size, not just each cell", () => {
    const wide = Array.from({ length: 26 }, (_, i) => `C${i}`);
    const rows = Array.from({ length: 100 }, () => wide.map(() => "x".repeat(100)));
    expect(tableDataSchema.safeParse(createTable(wide, rows)).success).toBe(false);
    expect(tableDataSchema.safeParse(createTable(wide, rows.slice(0, 50))).success).toBe(true);
  });
});
