import { describe, it, expect } from "vitest";
import {
  applyOperations,
  createWorkspace,
  computeLayout,
  measureNode,
  nodeCardExtraHeight,
  type Operation,
} from "../src/index.js";

/**
 * Every node card used to be forced to 160x64, so a realistic model-written
 * label ("Payment Reconciliation Service") was clipped. Sizing lives in the
 * layout engine, not CSS, because connector anchors, the minimap, comment pins,
 * and SVG export all read node.size.
 *
 * Stage C2/D regression: the card also renders a nodeType sub row and a
 * statement chip; without reserving height for them the fixed-height card
 * clipped that content symmetrically (the "cut top and bottom" report).
 */
describe("measureNode", () => {
  const base = { width: 160, height: 64 };

  it("keeps short labels at the base size", () => {
    expect(measureNode("Cart", base)).toEqual(base);
  });

  it("widens for a long label", () => {
    const s = measureNode("Payment Reconciliation Service", base);
    expect(s.width).toBeGreaterThan(base.width);
  });

  it("never exceeds the max width", () => {
    const s = measureNode("x".repeat(300), base, { maxWidth: 280 });
    expect(s.width).toBeLessThanOrEqual(280);
  });

  it("grows taller once the label must wrap", () => {
    const s = measureNode("x".repeat(200), base, { maxWidth: 280 });
    expect(s.height).toBeGreaterThan(base.height);
  });

  it("is deterministic — no DOM measurement", () => {
    expect(measureNode("Order Service", base)).toEqual(measureNode("Order Service", base));
  });

  it("handles an empty label without collapsing", () => {
    expect(measureNode("", base)).toEqual(base);
  });

  it("reserves the sub row + chip height for a statement node", () => {
    const plain = measureNode("Cart", base, { extraHeight: nodeCardExtraHeight(undefined) });
    const withSub = measureNode("Cart", base, { extraHeight: nodeCardExtraHeight({}) });
    const withChip = measureNode("Cart", base, {
      extraHeight: nodeCardExtraHeight({ statement: { kind: "goal", status: "open" } }),
    });
    expect(plain.height).toBe(base.height);
    expect(withSub.height).toBe(base.height + 15);
    expect(withChip.height).toBe(base.height + 15 + 23);
  });

  it("the layout reserves the extra rows for statement nodes", () => {
    let ws = createWorkspace({ diagramKind: "flowchart" });
    ws = applyOperations(ws, [
      { op: "CREATE_NODE", id: "s1", nodeType: "goal", label: "Ship" },
      { op: "SET_STATEMENT", id: "s1", statement: { kind: "goal", status: "open" } },
      { op: "CREATE_NODE", id: "s2", nodeType: "service", label: "Ship" },
    ] satisfies Operation[]);
    const layout = computeLayout(ws, { direction: "vertical" });
    expect(layout.s1!.size.height).toBe(base.height + 15 + 23);
    expect(layout.s2!.size.height).toBe(base.height + 15);
  });
});

describe("layered layout with measured sizes", () => {
  function board(labels: string[]) {
    const ops: Operation[] = labels.map((label, i) => ({
      op: "CREATE_NODE" as const,
      id: `n${i}`,
      nodeType: "service",
      label,
    }));
    return applyOperations(createWorkspace({ diagramKind: "flowchart" }), ops);
  }

  it("gives a long-labelled node a wider box than a short one", () => {
    const ws = board(["Hi", "Payment Reconciliation Service"]);
    const layout = computeLayout(ws, { direction: "vertical" });
    expect(layout.n1!.size.width).toBeGreaterThan(layout.n0!.size.width);
  });

  it("does not overlap siblings in a row after widening", () => {
    const ws = board([
      "Payment Reconciliation Service",
      "Inventory Projection Service",
      "Notification Dispatch Service",
    ]);
    const layout = computeLayout(ws, { direction: "vertical" });
    const boxes = ["n0", "n1", "n2"]
      .map((id) => layout[id]!)
      .sort((a, b) => a.position.x - b.position.x);
    for (let i = 1; i < boxes.length; i++) {
      const prevRight = boxes[i - 1]!.position.x + boxes[i - 1]!.size.width;
      expect(boxes[i]!.position.x).toBeGreaterThanOrEqual(prevRight);
    }
  });

  it("keeps rows clear of each other when a label wraps", () => {
    let ws = board(["A", "B"]);
    ws = applyOperations(ws, [
      { op: "CHANGE_TEXT", id: "n0", text: "x".repeat(120) },
      { op: "CONNECT_NODES", source: "n0", target: "n1", relationship: "next" },
    ]);
    const layout = computeLayout(ws, { direction: "vertical" });
    const top = layout.n0!;
    const bottom = layout.n1!;
    expect(bottom.position.y).toBeGreaterThanOrEqual(top.position.y + top.size.height);
  });
});
