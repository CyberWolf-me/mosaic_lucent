/**
 * COMPOSITION DERIVATION (V1): the board's main subject, primary flow, and
 * clusters read as a pure function. Pinned: subject selection (degree,
 * declaration-order ties), the flow walk (forward spine, sink head-walk,
 * cycle safety), cluster reading, the empty-board contract, and the
 * one-line summary the AI path embeds.
 */

import { describe, expect, it } from "vitest";
import {
  applyOperations,
  compositionLine,
  deriveComposition,
  type Operation,
} from "../src/index.js";
import { createWorkspace } from "../src/model.js";

function board(
  nodes: string[],
  edges: Array<[string, string]>,
  groups?: Array<{ id: string; label: string; children: string[]; kind?: string }>,
) {
  const ws = createWorkspace({ diagramKind: "flowchart" });
  const ops: Operation[] = nodes.map((id) => ({
    op: "CREATE_NODE" as const,
    id,
    nodeType: "process",
    label: id.toUpperCase(),
  }));
  for (const [s, t] of edges) {
    ops.push({ op: "CONNECT_NODES" as const, source: s, target: t, relationship: "calls" });
  }
  for (const g of groups ?? []) {
    ops.push({
      op: "CREATE_GROUP" as const,
      id: g.id,
      label: g.label,
      children: g.children,
      ...(g.kind ? { kind: g.kind as never } : {}),
    });
  }
  return applyOperations(ws, ops);
}

describe("deriveComposition", () => {
  it("an empty board has no subject and no story", () => {
    const c = deriveComposition(createWorkspace());
    expect(c.mainSubject).toBeNull();
    expect(c.primaryFlow).toEqual([]);
    expect(c.clusters).toEqual([]);
    expect(compositionLine(createWorkspace())).toBe("");
  });

  it("the highest-degree node is the main subject; the flow is the forward spine", () => {
    // signup is the hub: two in, two out.
    const ws = board(
      ["landing", "signup", "onboarding", "checkout", "payment", "email"],
      [
        ["landing", "signup"],
        ["signup", "onboarding"],
        ["signup", "checkout"],
        ["checkout", "payment"],
        ["onboarding", "email"],
      ],
    );
    const c = deriveComposition(ws);
    expect(c.mainSubject).toBe("signup");
    // Forward spine: FIRST-created outgoing edge each step (deterministic):
    // signup → onboarding → email.
    expect(c.primaryFlow).toEqual(["signup", "onboarding", "email"]);
  });

  it("a sink subject walks backwards to its chain head first", () => {
    // c is the sink hub: three incoming, no outgoing (strictly highest degree).
    const ws = board(
      ["a", "b", "c", "x", "y"],
      [
        ["a", "b"],
        ["b", "c"],
        ["x", "c"],
        ["y", "c"],
      ],
    );
    const c = deriveComposition(ws);
    expect(c.mainSubject).toBe("c");
    // Head-walk lands on the chain head, then the forward spine reads out.
    expect(c.primaryFlow).toEqual(["a", "b", "c"]);
  });

  it("cycles never hang the walk", () => {
    const ws = board(
      ["a", "b", "c", "d"],
      [
        ["a", "b"],
        ["b", "c"],
        ["c", "d"],
        ["d", "a"], // the return edge
      ],
    );
    const c = deriveComposition(ws);
    expect(c.primaryFlow.length).toBeLessThanOrEqual(4);
    expect(new Set(c.primaryFlow).size).toBe(c.primaryFlow.length); // no revisits
  });

  it("clusters read kind-regions with member counts", () => {
    const ws = board(
      ["a", "b", "c"],
      [["a", "b"]],
      [{ id: "g1", label: "Checkout", children: ["a", "b"], kind: "flowchart" }],
    );
    const c = deriveComposition(ws);
    expect(c.clusters).toEqual([{ id: "g1", label: "Checkout", memberCount: 2 }]);
  });

  it("the summary line names the story and regions", () => {
    const ws = board(
      ["a", "b", "c", "d", "x"],
      [
        ["a", "b"],
        ["b", "c"],
        ["c", "d"],
      ],
      [{ id: "g1", label: "Payments", children: ["x"], kind: "mindmap" }],
    );
    const line = compositionLine(ws);
    // Subject = b (degree 2), flow = the first-edge spine B → C → D.
    expect(line).toContain("B → C → D");
    expect(line).toContain("1 region (Payments)");
  });
});
