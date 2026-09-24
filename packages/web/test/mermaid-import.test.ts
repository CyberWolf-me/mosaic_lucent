import { describe, expect, it } from "vitest";
import { applyOperations, createWorkspace, validateOperations } from "@lucent/core";
import { planMermaidImport } from "../src/board/mermaidImport.js";

/**
 * docs/27 D2, the canvas side: an empty board becomes the pasted diagram; a
 * board with content gains it as a region, keeping its own kind.
 */

const STATE =
  "stateDiagram-v2\n  [*] --> Draft\n  Draft --> Live : publish\n  note right of Draft : wip";

describe("planMermaidImport", () => {
  it("an empty board becomes the diagram", () => {
    const plan = planMermaidImport(createWorkspace(), STATE, "t1");
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.ops[0]).toEqual({ op: "CREATE_DIAGRAM", kind: "statemachine" });
    expect(plan.nodeIds).toEqual(["t1-start", "t1-Draft", "t1-Live"]);
    expect(plan.message).toBe(
      "Imported a state diagram — 3 nodes. Skipped 1 line of styling or notes.",
    );
  });

  it("a board with content gains a region and keeps its kind", () => {
    const ws = applyOperations(createWorkspace({ diagramKind: "architecture" }), [
      { op: "CREATE_NODE", id: "api", nodeType: "service", label: "API" },
    ]);
    const plan = planMermaidImport(ws, STATE, "t2");
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(validateOperations(ws, plan.ops)).toEqual([]);
    const next = applyOperations(ws, plan.ops);
    expect(next.diagramKind).toBe("architecture");
    expect(next.groups["t2-region"]).toMatchObject({ kind: "statemachine" });
    expect(plan.message).toContain("as its own region");
  });

  it("says what's wrong when there's nothing to import", () => {
    expect(planMermaidImport(createWorkspace(), "just a note")).toEqual({
      ok: false,
      error: "That isn't a Mermaid flowchart, state diagram or mind map.",
    });
    expect(planMermaidImport(createWorkspace(), "mindmap\n")).toEqual({
      ok: false,
      error: "That Mermaid mind map has no nodes to import.",
    });
  });
});
