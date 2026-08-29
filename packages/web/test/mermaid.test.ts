import { describe, it, expect } from "vitest";
import { applyOperations, createWorkspace, validateOperations } from "@lucent/core";
import { boardToMermaid, mermaidToOps, parseMermaid } from "../src/board/mermaid.js";

/**
 * Mermaid is the practical integration surface: GitHub, GitLab, and Notion render
 * it inline, so export means "paste this board into a README" and import means
 * "pull the diagram already in the repo onto the board".
 */

function board() {
  return applyOperations(createWorkspace({ diagramKind: "flowchart" }), [
    { op: "CREATE_GROUP", id: "payments", label: "Payments", children: [] },
    { op: "CREATE_NODE", id: "start", nodeType: "start", label: "Cart" },
    { op: "CREATE_NODE", id: "check", nodeType: "decision", label: "Signed in?" },
    { op: "CREATE_NODE", id: "stripe", nodeType: "service", label: "Stripe", groupId: "payments" },
    { op: "CREATE_NODE", id: "db", nodeType: "database", label: "Orders DB" },
    { op: "CONNECT_NODES", source: "start", target: "check", relationship: "next" },
    { op: "CONNECT_NODES", source: "check", target: "stripe", relationship: "yes" },
    { op: "CONNECT_NODES", source: "stripe", target: "db", relationship: "writes" },
  ]);
}

describe("boardToMermaid", () => {
  const out = boardToMermaid(board());

  it("emits a flowchart header with a direction", () => {
    expect(out.startsWith("flowchart TD")).toBe(true);
  });

  it("uses left-to-right for a process map", () => {
    const ws = applyOperations(createWorkspace({ diagramKind: "process" }), [
      { op: "CREATE_NODE", id: "a", nodeType: "step", label: "A" },
    ]);
    expect(boardToMermaid(ws).startsWith("flowchart LR")).toBe(true);
  });

  it("maps node semantics onto Mermaid shapes", () => {
    expect(out).toContain('check{"Signed in?"}');
    expect(out).toContain('start(["Cart"])');
    expect(out).toContain('db[("Orders DB")]');
  });

  it("wraps grouped nodes in a subgraph", () => {
    expect(out).toContain('subgraph payments["Payments"]');
    expect(out).toContain("stripe[");
    expect(out).toContain("\n  end");
  });

  it("writes labelled edges", () => {
    expect(out).toContain("start -->|next| check");
    expect(out).toContain("check -->|yes| stripe");
  });

  it("declares every node exactly once", () => {
    for (const id of ["start", "check", "stripe", "db"]) {
      const declarations = out.split("\n").filter((l) => new RegExp(`^\\s*${id}[[({]`).test(l));
      expect(declarations, id).toHaveLength(1);
    }
  });

  it("handles an empty board without emitting broken syntax", () => {
    expect(boardToMermaid(createWorkspace())).toContain("flowchart TD");
  });

  it("sanitizes a label containing quotes and newlines", () => {
    const ws = applyOperations(createWorkspace(), [
      { op: "CREATE_NODE", id: "n", nodeType: "step", label: 'He said "hi"\nthen left' },
    ]);
    const text = boardToMermaid(ws);
    expect(text).not.toContain('"hi"');
    expect(text.split("\n").filter((l) => l.includes("n["))).toHaveLength(1);
  });

  it("makes an unsafe id identifier-safe", () => {
    const ws = applyOperations(createWorkspace(), [
      { op: "CREATE_NODE", id: "pay-service.v2", nodeType: "service", label: "Pay" },
    ]);
    expect(boardToMermaid(ws)).toContain("pay_service_v2[");
  });
});

describe("parseMermaid", () => {
  const text = `flowchart TD
  A(["Start"]) --> B{"Approved?"}
  B -->|yes| C["Ship it"]
  B -->|no| D["Reject"]
  subgraph ops["Operations"]
    C
  end`;

  it("reads the direction", () => {
    expect(parseMermaid(text).direction).toBe("TD");
    expect(parseMermaid("graph LR\n A --> B").direction).toBe("LR");
  });

  it("recovers labels and inferred types from shapes", () => {
    const parsed = parseMermaid(text);
    const a = parsed.nodes.find((n) => n.id === "A");
    const b = parsed.nodes.find((n) => n.id === "B");
    expect(a?.label).toBe("Start");
    expect(a?.nodeType).toBe("start");
    expect(b?.label).toBe("Approved?");
    expect(b?.nodeType).toBe("decision");
  });

  it("recovers labelled edges and defaults an unlabelled one", () => {
    const parsed = parseMermaid(text);
    expect(parsed.edges).toEqual(
      expect.arrayContaining([
        { source: "A", target: "B", relationship: "next" },
        { source: "B", target: "C", relationship: "yes" },
        { source: "B", target: "D", relationship: "no" },
      ]),
    );
  });

  it("reads subgraphs as groups", () => {
    expect(parseMermaid(text).groups).toEqual([{ id: "ops", label: "Operations" }]);
  });

  it("ignores comments and blank lines", () => {
    const parsed = parseMermaid("flowchart TD\n  %% a note\n\n  A --> B");
    expect(parsed.nodes.map((n) => n.id).sort()).toEqual(["A", "B"]);
  });

  it("returns nothing for text that is not Mermaid", () => {
    expect(parseMermaid("just some prose about diagrams").nodes).toEqual([]);
  });
});

describe("mermaidToOps", () => {
  const text = `flowchart TD
  A["Capture lead"] --> B["Send quote"]
  B -->|accepted| C["Fulfil"]`;

  it("produces a batch the engine validates in order", () => {
    const ops = mermaidToOps(text);
    expect(validateOperations(createWorkspace(), ops)).toHaveLength(0);
  });

  it("declares groups before the nodes that reference them", () => {
    const ops = mermaidToOps(`flowchart TD
  subgraph team["Team"]
    A["Work"]
  end
  A --> B["Done"]`);
    const groupIndex = ops.findIndex((o) => o.op === "CREATE_GROUP");
    const nodeIndex = ops.findIndex((o) => o.op === "CREATE_NODE" && o.groupId === "team");
    expect(groupIndex).toBeGreaterThanOrEqual(0);
    expect(nodeIndex).toBeGreaterThan(groupIndex);
    expect(validateOperations(createWorkspace(), ops)).toHaveLength(0);
  });

  it("chooses a process map for a left-to-right diagram", () => {
    const ops = mermaidToOps("flowchart LR\n A --> B");
    expect(ops[0]).toEqual({ op: "CREATE_DIAGRAM", kind: "process" });
  });

  it("chooses a flowchart for a top-down diagram", () => {
    expect(mermaidToOps(text)[0]).toEqual({ op: "CREATE_DIAGRAM", kind: "flowchart" });
  });

  it("returns nothing when there is no diagram to import", () => {
    expect(mermaidToOps("no diagram here")).toEqual([]);
  });

  it("skips a subgraph no node actually belongs to", () => {
    const ops = mermaidToOps(`flowchart TD
  subgraph empty["Nobody"]
  end
  A --> B`);
    expect(ops.some((o) => o.op === "CREATE_GROUP")).toBe(false);
  });
});

describe("round trip", () => {
  it("preserves nodes, edges, and labels through export and import", () => {
    const original = board();
    const reimported = applyOperations(createWorkspace(), mermaidToOps(boardToMermaid(original)));

    expect(Object.keys(reimported.nodes)).toHaveLength(Object.keys(original.nodes).length);
    expect(Object.keys(reimported.edges)).toHaveLength(Object.keys(original.edges).length);

    const labels = Object.values(reimported.nodes)
      .map((n) => n.label)
      .sort();
    expect(labels).toEqual(["Cart", "Orders DB", "Signed in?", "Stripe"]);

    const rels = Object.values(reimported.edges)
      .map((e) => e.relationship)
      .sort();
    expect(rels).toEqual(["next", "writes", "yes"]);
  });

  it("preserves group membership through the round trip", () => {
    const reimported = applyOperations(createWorkspace(), mermaidToOps(boardToMermaid(board())));
    expect(reimported.nodes.stripe?.groupId).toBe("payments");
  });

  it("keeps decision semantics through the round trip", () => {
    const reimported = applyOperations(createWorkspace(), mermaidToOps(boardToMermaid(board())));
    expect(reimported.nodes.check?.nodeType).toBe("decision");
  });
});
