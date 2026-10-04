import { describe, it, expect } from "vitest";
import { createTable, createWorkspace, applyOperations, representationLabel } from "@lucent/core";
import type { Operation } from "@lucent/core";
import {
  boardToMarkdown,
  boardToCsv,
  parseCsv,
  csvToStickyOps,
  csvCell,
} from "../src/board/serialize.js";

function ecommerce() {
  const ops: Operation[] = [
    { op: "CREATE_NODE", id: "user", nodeType: "actor", label: "Customer" },
    { op: "CREATE_NODE", id: "checkout", nodeType: "screen", label: "Checkout" },
    { op: "CONNECT_NODES", source: "user", target: "checkout", relationship: "uses" },
    {
      op: "CREATE_SHAPE",
      id: "s1",
      kind: "sticky",
      position: { x: 0, y: 0 },
      size: { width: 100, height: 60 },
      text: "Ship faster",
    },
  ];
  return applyOperations(createWorkspace({ name: "Shop" }), ops);
}

describe("board serialize (Phase B)", () => {
  it("exports Markdown with nodes, connections, and notes", () => {
    const md = boardToMarkdown(ecommerce());
    expect(md).toContain("# Shop");
    expect(md).toContain("**Customer**");
    expect(md).toContain("Customer → Checkout");
    expect(md).toContain("- Ship faster");
  });

  it("names the diagram kind by its registry label, not its raw id", () => {
    const md = boardToMarkdown(ecommerce());
    expect(md).toContain(`## Diagram (${representationLabel("flowchart")})`);
    expect(md).not.toContain("## Diagram (flowchart)");
  });

  it("exports tables as Markdown tables and charts as their data", () => {
    const ws = applyOperations(ecommerce(), [
      {
        op: "CREATE_SHAPE",
        id: "t1",
        kind: "table",
        position: { x: 0, y: 0 },
        size: { width: 300, height: 100 },
        table: createTable(["Task", "Owner"], [["Design", "Alex | Sam"]]),
      },
      {
        op: "CREATE_SHAPE",
        id: "c1",
        kind: "chart",
        position: { x: 0, y: 200 },
        size: { width: 300, height: 200 },
        chart: {
          type: "bar",
          title: "Revenue",
          labels: ["Q1", "Q2"],
          series: [{ name: "EU", values: [3, -1] }],
        },
      },
    ]);
    const md = boardToMarkdown(ws);
    expect(md).toContain("## Tables");
    expect(md).toContain("| Task | Owner |");
    // A pipe inside a cell is escaped so it can't split the column.
    expect(md).toContain("| Design | Alex \\| Sam |");
    expect(md).toContain("## Charts");
    expect(md).toContain("**Revenue** _(bar chart)_");
    expect(md).toContain("| Q2 | -1 |");
  });

  it("exports CSV with node rows and outgoing edges", () => {
    const csv = boardToCsv(ecommerce());
    expect(csv.split("\n")[0]).toBe("id,type,label,connects_to");
    expect(csv).toContain("user,actor,Customer,Checkout");
  });

  it("parses CSV including quoted cells with commas and newlines", () => {
    const rows = parseCsv(`a,b\n"x,y","line1\nline2"`);
    expect(rows).toEqual([
      ["a", "b"],
      ["x,y", "line1\nline2"],
    ]);
  });

  it("turns CSV into a grid of sticky CREATE_SHAPE ops", () => {
    const ops = csvToStickyOps("Task,Owner\nDesign,Alex");
    const kinds = ops.map((o) => (o as { op: string }).op);
    expect(kinds.every((k) => k === "CREATE_SHAPE")).toBe(true);
    // 2 header cells + 2 data cells = 4 stickies
    expect(ops).toHaveLength(4);
  });

  it("round-trips a CSV import into a usable workspace", () => {
    const ops = csvToStickyOps("A,B\nC,D");
    const ws = applyOperations(createWorkspace(), ops);
    expect(Object.keys(ws.shapes)).toHaveLength(4);
  });

  it("prefixes formula triggers so spreadsheet apps treat them as text", () => {
    expect(csvCell("=1+1")).toBe("'=1+1");
    expect(csvCell("+cmd")).toBe("'+cmd");
    expect(csvCell("-2+3")).toBe("'-2+3");
    expect(csvCell("@mention")).toBe("'@mention");
    expect(csvCell("  =evil")).toBe("'  =evil");
    // Normal cells are untouched.
    expect(csvCell("Customer")).toBe("Customer");
    expect(csvCell("a,b")).toBe('"a,b"');
  });
});
