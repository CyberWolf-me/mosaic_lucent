import { describe, it, expect } from "vitest";
import { createWorkspace, applyOperations } from "@lucent/core";
import type { Operation } from "@lucent/core";
import { focusSet, focusOpacity, focusEdgeOpacity } from "../src/board/focus.js";

/**
 * Selection focus (P1, docs/15 M3.1) — the pure contract. The advisory's
 * framing: "Click a topic/object → selected + related highlighted →
 * everything else subdued." No data changes, no layout changes, no AI
 * changes — the render layer only reads what these helpers decide.
 *
 * The one rule that makes focus readable rather than just dim: a CONNECTOR
 * stays fully drawn when EITHER endpoint is prominent, so the selected
 * node's relationships never fade while unrelated clusters do. (This is why
 * edges grade by endpoint, not by their own id — the prominence set holds
 * node ids.)
 */

const graph: Operation[] = [
  { op: "CREATE_NODE", id: "hub", nodeType: "service", label: "Hub" },
  { op: "CREATE_NODE", id: "a", nodeType: "service", label: "A" },
  { op: "CREATE_NODE", id: "b", nodeType: "service", label: "B" },
  { op: "CREATE_NODE", id: "isolated", nodeType: "service", label: "Isolated" },
  { op: "CONNECT_NODES", source: "hub", target: "a", relationship: "calls" },
  { op: "CONNECT_NODES", source: "b", target: "hub", relationship: "reads" },
  // `isolated` shares no edge with anything.
];
const board = applyOperations(createWorkspace(), graph);

describe("focusSet", () => {
  it("the selected node plus its direct neighbours are prominent (both edge directions)", () => {
    const focus = focusSet(board, "hub")!;
    expect(focus.selected).toBe("hub");
    expect([...focus.prominent].sort()).toEqual(["a", "b", "hub"]);
  });

  it("an unconnected node is subdued even when something else is focused", () => {
    const focus = focusSet(board, "hub")!;
    expect(focus.prominent.has("isolated")).toBe(false);
  });

  it("focusing an isolated node still shows it (itself prominent, nothing else)", () => {
    const focus = focusSet(board, "isolated")!;
    expect(focus.prominent.has("isolated")).toBe(true);
    expect(focus.prominent.size).toBe(1);
  });

  it("returns null for no selection or an unknown id", () => {
    expect(focusSet(board, null)).toBeNull();
    expect(focusSet(board, "ghost")).toBeNull();
  });
});

describe("focusOpacity — the node grade", () => {
  it("prominent nodes stay at full strength", () => {
    const focus = focusSet(board, "hub")!;
    expect(focusOpacity(focus, "hub")).toBe(1);
    expect(focusOpacity(focus, "a")).toBe(1);
  });

  it("unrelated nodes recede softly (0.35) — visibly present, clearly secondary", () => {
    const focus = focusSet(board, "hub")!;
    expect(focusOpacity(focus, "isolated")).toBe(0.35);
  });

  it("with no focus everything renders at 1 (the idle board is untouched)", () => {
    expect(focusOpacity(null, "hub")).toBe(1);
  });
});

describe("focusEdgeOpacity — the connector grade", () => {
  it("an edge touching a prominent endpoint stays fully drawn (either direction)", () => {
    const focus = focusSet(board, "hub")!;
    expect(focusEdgeOpacity(focus, "hub", "a")).toBe(1); // hub→a
    expect(focusEdgeOpacity(focus, "b", "hub")).toBe(1); // b→hub
  });

  it("an edge between two non-prominent nodes recedes deepest (0.15)", () => {
    const focus = focusSet(board, "hub")!;
    // a and b are both prominent here (both touch hub), so use the isolated
    // node pair: neither endpoint is in the set.
    expect(focusEdgeOpacity(focus, "isolated", "some-other-unrelated")).toBe(0.15);
  });

  it("with no focus every edge renders at 1", () => {
    expect(focusEdgeOpacity(null, "hub", "a")).toBe(1);
  });

  it("edges recede deeper than nodes so the focused relationships dominate", () => {
    const focus = focusSet(board, "hub")!;
    const nodeGrade = focusOpacity(focus, "isolated");
    const edgeGrade = focusEdgeOpacity(focus, "isolated", "unrelated");
    expect(edgeGrade).toBeLessThan(nodeGrade);
  });
});
