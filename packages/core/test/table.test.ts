import { describe, it, expect } from "vitest";
import {
  applyOperations,
  createTable,
  createWorkspace,
  deleteTableColumn,
  deleteTableRow,
  insertTableColumn,
  insertTableRow,
  inverseOperations,
  parseDelimited,
  readDelimited,
  setTableCell,
  sniffDelimited,
  TABLE_LIMITS,
  tableChars,
  tableDataSchema,
  tableToMarkdown,
  validateOperations,
  workspaceSchema,
  type Operation,
  type TableData,
  type TableEdit,
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
    expect(t?.rows).toEqual([{ cells: ["Ada", "Engineer"] }, { cells: ["Grace", "Admiral"] }]);
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

describe("readDelimited", () => {
  it("reports nothing dropped for a table within the limits", () => {
    const r = readDelimited("a,b\n1,2\r\n3,4\r\n");
    expect(r?.truncated).toBe(false);
    expect(r?.delimiter).toBe(",");
    expect(r?.table.rows).toHaveLength(2);
  });

  it("drops rows past the row cap and says so", () => {
    const csv = ["n", ...Array.from({ length: 600 }, (_, i) => String(i))].join("\n");
    const r = readDelimited(csv)!;
    expect(r.table.rows).toHaveLength(TABLE_LIMITS.rows);
    expect(r.truncated).toBe(true);
  });

  it("fits the total-character cap by dropping trailing rows, so the schema accepts it", () => {
    // 26 columns × 400 rows × 100 characters: 1 MB of cells, within the
    // row/column/cell caps but five times the table-wide one.
    const header = Array.from({ length: 26 }, (_, i) => `C${i}`).join(",");
    const row = Array.from({ length: 26 }, () => "x".repeat(100)).join(",");
    const r = readDelimited([header, ...Array.from({ length: 400 }, () => row)].join("\n"))!;
    expect(r.truncated).toBe(true);
    expect(tableChars(r.table)).toBeLessThanOrEqual(TABLE_LIMITS.totalChars);
    expect(r.table.rows.length).toBeGreaterThan(0);
    expect(tableDataSchema.safeParse(r.table).success).toBe(true);
    // parseDelimited gives the same fitted table.
    expect(parseDelimited([header, row].join("\n"))).toEqual(
      readDelimited([header, row].join("\n"))!.table,
    );
  });
});

describe("sniffDelimited (paste heuristic)", () => {
  it("takes a spreadsheet copy (tab-separated) as a table", () => {
    const r = sniffDelimited("Name\tQty\tOwner\nApples\t3\tAda\nPears\t5\t\n");
    expect(r?.delimiter).toBe("\t");
    expect(r?.table.columns.map((c) => c.header)).toEqual(["Name", "Qty", "Owner"]);
    expect(r?.table.rows[1]).toEqual({ cells: ["Pears", "5", ""] });
  });

  it("takes a CSV grid as a table", () => {
    expect(sniffDelimited("name,role\nAda,Engineer\nGrace,Admiral")?.delimiter).toBe(",");
    expect(sniffDelimited('city,note\nParis,"big, old"\nOslo,cold')?.table.rows[0]).toEqual({
      cells: ["Paris", "big, old"],
    });
    // Two spaced columns count when one of them is numeric.
    expect(sniffDelimited("Apples, 3\nPears, 5")).not.toBeNull();
    // Three columns with spaces after the commas still read as a grid.
    expect(sniffDelimited("red, green, blue\ncyan, magenta, yellow")).not.toBeNull();
  });

  it("leaves prose, lists and code alone", () => {
    const notTables = [
      "Hi Bob, how are you?", // one line
      "a,b,c", // one line
      "Hi Bob, how are you?\nFine, thanks.", // sentences
      "Hi Bob, how are you\nFine, thanks", // two spaced columns, no numbers
      "Smith, John\nDoe, Jane",
      "I went out, bought milk, and bread\nThen I went home, and slept", // ragged
      "foo(a, b);\nbar(c, d);", // code
      "if (a, b) {\n  go(c, d)\n}",
      "\tfoo\n\tbar", // indentation, not a column
      "apples,\npears,", // trailing punctuation, not a column
      "One sentence.\nAnother, with a comma.\nA third, too.",
      "first line\nsecond line",
      "",
    ];
    for (const text of notTables) expect(sniffDelimited(text), JSON.stringify(text)).toBeNull();
  });
});

describe("table edits", () => {
  const base = createTable(["Name", "Owner"], [["Login", "Ada"], ["Billing"]]);
  const ok = (e: TableEdit): TableData => {
    if (!e.ok) throw new Error(e.error);
    expect(tableDataSchema.safeParse(e.table).success).toBe(true);
    return e.table;
  };

  it("sets a header or a cell without touching the original", () => {
    expect(ok(setTableCell(base, -1, 1, "Lead")).columns[1]?.header).toBe("Lead");
    // A ragged (short) row is padded to the grid before the edit.
    expect(ok(setTableCell(base, 1, 1, "Grace")).rows[1]).toEqual({ cells: ["Billing", "Grace"] });
    expect(base.rows[1]).toEqual({ cells: ["Billing"] });
  });

  it("clips a cell to its cap and refuses what breaks the table-wide cap", () => {
    expect(ok(setTableCell(base, 0, 0, "x".repeat(5000))).rows[0]?.cells[0]).toHaveLength(
      TABLE_LIMITS.cellChars,
    );
    expect(ok(setTableCell(base, -1, 0, "h".repeat(500))).columns[0]?.header).toHaveLength(
      TABLE_LIMITS.headerChars,
    );
    const full = createTable(
      Array.from({ length: 26 }, (_, i) => `C${i}`),
      Array.from({ length: 80 }, () => Array.from({ length: 26 }, () => "x".repeat(96))),
    );
    expect(tableChars(full)).toBeLessThanOrEqual(TABLE_LIMITS.totalChars);
    const refused = setTableCell(full, 0, 0, "y".repeat(2000));
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.error).toMatch(/at most 200,000 characters/);
  });

  it("refuses a cell that no longer exists", () => {
    expect(setTableCell(base, 5, 0, "x").ok).toBe(false);
    expect(setTableCell(base, 0, 9, "x").ok).toBe(false);
  });

  it("inserts and deletes rows", () => {
    const added = ok(insertTableRow(base, 1));
    expect(added.rows).toHaveLength(3);
    expect(added.rows[1]).toEqual({ cells: ["", ""] });
    expect(ok(insertTableRow(base)).rows[2]).toEqual({ cells: ["", ""] });
    expect(ok(deleteTableRow(base, 0)).rows).toEqual([{ cells: ["Billing"] }]);
    // Every body row may go; the header stays.
    expect(ok(deleteTableRow(ok(deleteTableRow(base, 0)), 0)).rows).toEqual([]);
    expect(deleteTableRow(base, 7).ok).toBe(false);
    const fullRows = createTable(
      ["A"],
      Array.from({ length: TABLE_LIMITS.rows }, () => [""]),
    );
    expect(insertTableRow(fullRows).ok).toBe(false);
  });

  it("inserts and deletes columns, keeping every row aligned", () => {
    const added = ok(insertTableColumn(base, 1));
    expect(added.columns.map((c) => c.header)).toEqual(["Name", "Column 3", "Owner"]);
    expect(added.rows).toEqual([{ cells: ["Login", "", "Ada"] }, { cells: ["Billing", "", ""] }]);
    expect(ok(insertTableColumn(base)).columns[2]?.header).toBe("Column 3");
    // The fresh name skips one already taken.
    expect(ok(insertTableColumn(added)).columns[3]?.header).toBe("Column 4");
    const removed = ok(deleteTableColumn(base, 0));
    expect(removed.columns.map((c) => c.header)).toEqual(["Owner"]);
    expect(removed.rows).toEqual([{ cells: ["Ada"] }, { cells: [] }]);
    // The schema needs a column, so the last one can't go.
    expect(deleteTableColumn(removed, 0).ok).toBe(false);
    const wide = createTable(Array.from({ length: TABLE_LIMITS.columns }, (_, i) => `C${i}`));
    expect(insertTableColumn(wide).ok).toBe(false);
  });

  it("lands as an UPDATE_SHAPE that undoes", () => {
    const ws = applyOperations(createWorkspace(), [
      {
        op: "CREATE_SHAPE",
        id: "t",
        kind: "table",
        position: { x: 0, y: 0 },
        size: { width: 300, height: 120 },
        table: base,
      },
    ]);
    const edit: Operation[] = [{ op: "UPDATE_SHAPE", id: "t", table: ok(insertTableColumn(base)) }];
    expect(validateOperations(ws, edit)).toEqual([]);
    const next = applyOperations(ws, edit);
    expect(next.shapes.t?.table?.columns).toHaveLength(3);
    expect(applyOperations(next, inverseOperations(edit, ws)).shapes.t?.table).toEqual(base);
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
    {
      op: "CREATE_SHAPE",
      id: "note",
      kind: "sticky",
      position: { x: 0, y: 0 },
      size: { width: 150, height: 110 },
      text: "hi",
    },
    {
      op: "CREATE_SHAPE",
      id: "t1",
      kind: "table",
      position: { x: 0, y: 0 },
      size: { width: 300, height: 120 },
      table,
    },
  ]);

  it("refuses a table or chart riding another kind, and a table or chart shape with no data", () => {
    const refused: Operation[][] = [
      [
        {
          op: "CREATE_SHAPE",
          id: "x",
          kind: "sticky",
          position: { x: 0, y: 0 },
          size: { width: 10, height: 10 },
          table,
        },
      ],
      [
        {
          op: "CREATE_SHAPE",
          id: "x",
          kind: "rect",
          position: { x: 0, y: 0 },
          size: { width: 10, height: 10 },
          chart,
        },
      ],
      [
        {
          op: "CREATE_SHAPE",
          id: "x",
          kind: "table",
          position: { x: 0, y: 0 },
          size: { width: 10, height: 10 },
        },
      ],
      [
        {
          op: "CREATE_SHAPE",
          id: "x",
          kind: "chart",
          position: { x: 0, y: 0 },
          size: { width: 10, height: 10 },
        },
      ],
      [{ op: "UPDATE_SHAPE", id: "note", table }],
      [{ op: "UPDATE_SHAPE", id: "t1", chart }],
    ];
    for (const ops of refused)
      expect(validateOperations(base, ops), JSON.stringify(ops[0])).not.toEqual([]);
  });

  it("knows the kind of a shape created earlier in the same batch", () => {
    const ops: Operation[] = [
      {
        op: "CREATE_SHAPE",
        id: "c1",
        kind: "chart",
        position: { x: 0, y: 0 },
        size: { width: 200, height: 120 },
        chart,
      },
      { op: "UPDATE_SHAPE", id: "c1", chart: { ...chart, type: "line" } },
    ];
    expect(validateOperations(base, ops)).toEqual([]);
    expect(validateOperations(base, [...ops, { op: "UPDATE_SHAPE", id: "c1", table }])).not.toEqual(
      [],
    );
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
