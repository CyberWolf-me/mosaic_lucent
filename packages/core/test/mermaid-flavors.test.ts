import { describe, expect, it } from "vitest";
import {
  applyOperations,
  boardToMermaid,
  computeLayout,
  createWorkspace,
  detectMermaid,
  mermaidToOps,
  parseMermaid,
  validateOperations,
  type Operation,
} from "@lucent/core";

/**
 * docs/27 D2: Mermaid in, as meaning. The flowchart syntax people actually
 * write (chains, fans, dotted and thick links, text on links, one-liners), plus
 * state diagrams and mind maps onto Lucent's own kinds — and every import is a
 * batch the validator accepts, so it lands through the one contract.
 */

const lands = (ops: Operation[]) => {
  expect(validateOperations(createWorkspace(), ops)).toEqual([]);
  return applyOperations(createWorkspace(), ops);
};

describe("detectMermaid", () => {
  it("names each flavour, from a README fence too", () => {
    expect(detectMermaid("flowchart LR\n A --> B")).toBe("flowchart");
    expect(detectMermaid("graph TD; A-->B")).toBe("flowchart");
    expect(detectMermaid("stateDiagram-v2\n [*] --> A")).toBe("state");
    expect(detectMermaid("mindmap\n  root((X))")).toBe("mindmap");
    expect(detectMermaid("# Docs\n\n```mermaid\nflowchart TD\n A --> B\n```\n")).toBe("flowchart");
    expect(detectMermaid("---\ntitle: Checkout\n---\nflowchart TD\n A --> B")).toBe("flowchart");
  });

  it("does not mistake prose for a diagram", () => {
    expect(detectMermaid("Graph theory notes\nNodes and edges")).toBeNull();
    expect(detectMermaid("flowchart ideas for the offsite")).toBeNull();
    expect(detectMermaid("sequenceDiagram\n A->>B: hi")).toBeNull();
  });
});

describe("flowchart syntax people write", () => {
  it("chains, fans out with &, and reads every link style", () => {
    const g = parseMermaid(`flowchart LR
  A[Cart] --> B{Paid?} -->|yes| C([Ship])
  B -. retry .-> A
  B == no ==> D[(Ledger)]
  C & D --> E((Customer))
  E --- F
  F --o G`);
    const pairs = g.edges.map((e) => `${e.source}>${e.target}:${e.relationship}`);
    expect(pairs).toEqual([
      "A>B:next",
      "B>C:yes",
      "B>A:retry",
      "B>D:no",
      "C>E:next",
      "D>E:next",
      "E>F:next",
      "F>G:next",
    ]);
    const type = (id: string) => g.nodes.find((n) => n.id === id)?.nodeType;
    expect([type("B"), type("C"), type("D"), type("E")]).toEqual([
      "decision",
      "start",
      "database",
      "actor",
    ]);
    expect(g.kind).toBe("process");
  });

  it("reads a one-line diagram and a label with brackets inside quotes", () => {
    const g = parseMermaid(`graph TD; A["Retry [max 3]"]-->B; B-->C`);
    expect(g.nodes.map((n) => n.label)).toEqual(["Retry [max 3]", "B", "C"]);
    expect(g.edges).toHaveLength(2);
  });

  it("reads v11 shape syntax, hyphenated ids, and cleans label markup", () => {
    const g = parseMermaid(`flowchart TD
  api-gateway@{ shape: diam, label: "Auth ok?" } --> user-db[(Users<br/>DB)]
  note["\`**Bold** move\`"]`);
    expect(g.nodes).toEqual([
      { id: "api-gateway", label: "Auth ok?", nodeType: "decision" },
      { id: "user-db", label: "Users DB", nodeType: "database" },
      { id: "note", label: "Bold move", nodeType: "step" },
    ]);
  });

  it("skips styling and click lines, and counts them", () => {
    const g = parseMermaid(`flowchart TD
  A --> B
  classDef hot fill:#f00
  class A hot
  style B stroke:#333
  click A "https://example.com"
  linkStyle 0 stroke:red`);
    expect(g.nodes).toHaveLength(2);
    expect(g.skipped).toBe(5);
  });

  it("subgraphs: bracket, quoted and bare titles; nesting keeps the innermost", () => {
    const g = parseMermaid(`flowchart TD
  subgraph "Payment service"
    P1 --> P2
    subgraph inner [Ledger]
      L1
    end
  end
  subgraph Ops
    O1
  end`);
    expect(g.groups).toEqual([
      { id: "payment_service", label: "Payment service" },
      { id: "inner", label: "Ledger" },
      { id: "Ops", label: "Ops" },
    ]);
    const groupOf = (id: string) => g.nodes.find((n) => n.id === id)?.groupId;
    expect([groupOf("P1"), groupOf("L1"), groupOf("O1")]).toEqual([
      "payment_service",
      "inner",
      "Ops",
    ]);
  });

  it("drops a self-loop (the validator refuses them) and a duplicate edge", () => {
    const g = parseMermaid("flowchart TD\n A --> A\n A --> B\n A --> B");
    expect(g.edges).toEqual([{ source: "A", target: "B", relationship: "next" }]);
  });
});

describe("state diagrams → statemachine", () => {
  const text = `stateDiagram-v2
  direction LR
  [*] --> Draft
  state "In review" as Review
  Draft --> Review : submit
  Review --> Draft : request changes
  Review --> Published : approve
  state check <<choice>>
  Published --> check
  check --> Archived : stale
  check --> Published : fresh
  Archived --> [*]
  Draft : being written
  note right of Draft : authors only`;

  it("maps [*] to start and end pseudo-states and keeps events as labels", () => {
    const g = parseMermaid(text);
    expect(g.kind).toBe("statemachine");
    expect(g.direction).toBe("LR");
    const node = (id: string) => g.nodes.find((n) => n.id === id);
    expect(node("start")).toMatchObject({ nodeType: "start", label: "Start" });
    expect(node("end")).toMatchObject({ nodeType: "end", label: "End" });
    expect(node("Review")?.label).toBe("In review");
    expect(node("check")?.nodeType).toBe("decision");
    expect(g.edges).toContainEqual({ source: "Draft", target: "Review", relationship: "submit" });
    expect(g.edges).toContainEqual({ source: "Published", target: "check", relationship: "" });
    expect(g.skipped).toBe(2); // the description and the note
  });

  it("lands as a state machine the layout shrinks to pseudo-states", () => {
    const ws = lands(mermaidToOps(text));
    expect(ws.diagramKind).toBe("statemachine");
    const layout = computeLayout(ws);
    expect(layout.start?.size.width).toBe(36);
    expect(layout.Draft?.size.width).toBeGreaterThan(36);
  });

  it("a composite state is a group; a transition into it enters at its start", () => {
    const g = parseMermaid(`stateDiagram-v2
  [*] --> Active
  state Active {
    [*] --> Idle
    Idle --> Busy : job
    Busy --> Idle : done
  }
  Active --> Stopped : kill`);
    expect(g.groups).toEqual([{ id: "Active", label: "Active" }]);
    expect(g.nodes.some((n) => n.id === "Active")).toBe(false);
    expect(g.edges).toContainEqual({ source: "start", target: "Active__start", relationship: "" });
    // Leaving the composite: from its last member (it has no [*] end).
    expect(g.edges).toContainEqual({ source: "Busy", target: "Stopped", relationship: "kill" });
    lands(
      mermaidToOps(`stateDiagram-v2
  state Active {
    [*] --> Idle
  }
  Idle --> Idle : tick`),
    );
  });
});

describe("mind maps → mindmap", () => {
  const text = `mindmap
  root((Launch plan))
    Marketing
      Blog post
      id1[Press kit]
    Product
      Tools (dev)
      ::icon(fa fa-wrench)
    Sales`;

  it("reads the indentation tree as branch edges", () => {
    const g = parseMermaid(text);
    expect(g.kind).toBe("mindmap");
    const label = (id: string) => g.nodes.find((n) => n.id === id)?.label;
    const tree = g.edges.map((e) => `${label(e.source)} > ${label(e.target)}`);
    expect(tree).toEqual([
      "Launch plan > Marketing",
      "Marketing > Blog post",
      "Marketing > Press kit",
      "Launch plan > Product",
      "Product > Tools (dev)",
      "Launch plan > Sales",
    ]);
    expect(g.edges.every((e) => e.relationship === "branch")).toBe(true);
    expect(g.skipped).toBe(1);
  });

  it("lands as a mind map and round-trips as one", () => {
    const ws = lands(mermaidToOps(text));
    expect(ws.diagramKind).toBe("mindmap");
    const out = boardToMermaid(ws);
    expect(out.startsWith("mindmap\n")).toBe(true);
    expect(out).toContain("root((Launch plan))");
    const again = parseMermaid(out);
    expect(again.nodes.map((n) => n.label).sort()).toEqual(
      [
        "Blog post",
        "Launch plan",
        "Marketing",
        "Press kit",
        "Product",
        "Sales",
        "Tools dev",
      ].sort(),
    );
  });
});

describe("importing onto a board that has content", () => {
  it("prefixed ids never collide with what's there, or with a second import", () => {
    const text = "flowchart TD\n A --> B";
    const ws = lands(mermaidToOps(text, { idPrefix: "mm1" }));
    const second = mermaidToOps(text, { idPrefix: "mm2" });
    expect(validateOperations(ws, second)).toEqual([]);
    expect(Object.keys(applyOperations(ws, second).nodes).sort()).toEqual([
      "mm1-A",
      "mm1-B",
      "mm2-A",
      "mm2-B",
    ]);
  });

  it("as a region: its own kind, the board's kind untouched, subgraphs flattened", () => {
    const existing = applyOperations(createWorkspace({ diagramKind: "architecture" }), [
      { op: "CREATE_NODE", id: "api", nodeType: "service", label: "API" },
    ]);
    const ops = mermaidToOps(
      `---
title: Order lifecycle
---
stateDiagram-v2
  [*] --> Placed
  Placed --> Paid : pay`,
      { idPrefix: "imp", region: { id: "imp-region" } },
    );
    expect(ops[0]).toEqual({
      op: "CREATE_GROUP",
      id: "imp-region",
      label: "Order lifecycle",
      children: [],
      kind: "statemachine",
    });
    expect(validateOperations(existing, ops)).toEqual([]);
    const ws = applyOperations(existing, ops);
    expect(ws.diagramKind).toBe("architecture");
    expect(Object.values(ws.nodes).filter((n) => n.groupId === "imp-region")).toHaveLength(3);
  });

  it("cleans ids the reducer would otherwise carry verbatim", () => {
    const ops = mermaidToOps("flowchart TD\n Zürich --> Genève");
    const ids = ops.filter((o) => o.op === "CREATE_NODE").map((o) => (o as { id: string }).id);
    expect(ids).toEqual(["Z_rich", "Gen_ve"]);
    lands(ops);
  });
});

describe("export per kind", () => {
  it("a state machine exports as a state diagram and round-trips", () => {
    const ws = applyOperations(createWorkspace({ diagramKind: "statemachine" }), [
      { op: "CREATE_NODE", id: "s", nodeType: "start", label: "Start" },
      { op: "CREATE_NODE", id: "draft", nodeType: "state", label: "Draft" },
      { op: "CREATE_NODE", id: "live", nodeType: "state", label: "Live" },
      { op: "CREATE_NODE", id: "e", nodeType: "end", label: "End" },
      { op: "CONNECT_NODES", source: "s", target: "draft", relationship: "create" },
      { op: "CONNECT_NODES", source: "draft", target: "live", relationship: "publish" },
      { op: "CONNECT_NODES", source: "live", target: "e", relationship: "" },
    ]);
    const out = boardToMermaid(ws);
    expect(out).toBe(
      [
        "stateDiagram-v2",
        '  state "Draft" as draft',
        '  state "Live" as live',
        "  [*] --> draft : create",
        "  draft --> live : publish",
        "  live --> [*]",
        "",
      ].join("\n"),
    );
    const back = lands(mermaidToOps(out));
    expect(Object.keys(back.nodes)).toHaveLength(4);
    expect(
      Object.values(back.edges)
        .map((e) => e.relationship)
        .sort(),
    ).toEqual(["", "create", "publish"]);
  });

  it("a mind map that isn't a tree falls back to a flowchart", () => {
    const ws = applyOperations(createWorkspace({ diagramKind: "mindmap" }), [
      { op: "CREATE_NODE", id: "a", nodeType: "idea", label: "A" },
      { op: "CREATE_NODE", id: "b", nodeType: "idea", label: "B" },
      { op: "CREATE_NODE", id: "c", nodeType: "idea", label: "C" },
      { op: "CONNECT_NODES", source: "a", target: "c", relationship: "branch" },
      { op: "CONNECT_NODES", source: "b", target: "c", relationship: "branch" },
    ]);
    expect(boardToMermaid(ws).startsWith("flowchart TD")).toBe(true);
  });

  it("an unlabelled edge exports without an empty label", () => {
    const ws = applyOperations(createWorkspace(), [
      { op: "CREATE_NODE", id: "a", nodeType: "step", label: "A" },
      { op: "CREATE_NODE", id: "b", nodeType: "step", label: "B" },
      { op: "CONNECT_NODES", source: "a", target: "b", relationship: "" },
    ]);
    expect(boardToMermaid(ws)).toContain("  a --> b\n");
  });
});
