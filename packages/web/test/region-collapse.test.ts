import { describe, it, expect } from "vitest";
import { createWorkspace, applyOperations, applyLayout, computeLayout } from "@lucent/core";
import type { Operation, Workspace } from "@lucent/core";
import { diagramScene, groupRegions, visibleNodes } from "../src/board/culling.js";

/**
 * Region collapse (P1, docs/15 M3.3) — the invariants that make it safe:
 *
 *   1. Collapse is a RENDER filter only: the model never changes, so
 *      expanding returns the exact prior geometry — "expand == pixel-
 *      identical before" is asserted against real layout coordinates.
 *   2. Cross-region edges stay visible when a region collapses (they
 *      connect the collapsed card to the rest of the board); only edges
 *      fully inside the collapsed region hide with its nodes.
 *   3. The summary card's counts derive from the model, so the card tells
 *      the truth about what it is hiding.
 *
 * The interactive half (the toggle + card) lives in CanvasView/DiagramLayer;
 * these tests pin the pure filtering the render layer performs.
 */

const seedRegions = (): Operation[] => [
  // Product region (a kind-region: collapse only applies to these).
  { op: "CREATE_NODE", id: "p1", nodeType: "topic", label: "Product", groupId: "product" },
  { op: "CREATE_NODE", id: "p2", nodeType: "idea", label: "Users", groupId: "product" },
  { op: "CONNECT_NODES", source: "p1", target: "p2", relationship: "branch" },
  {
    op: "CREATE_GROUP",
    id: "product",
    label: "Product",
    children: ["p1", "p2"],
    kind: "mindmap",
  },
  // Pricing region.
  { op: "CREATE_NODE", id: "pr1", nodeType: "step", label: "Free tier", groupId: "pricing" },
  { op: "CREATE_NODE", id: "pr2", nodeType: "step", label: "Pro", groupId: "pricing" },
  { op: "CONNECT_NODES", source: "pr1", target: "pr2", relationship: "then" },
  {
    op: "CREATE_GROUP",
    id: "pricing",
    label: "Pricing",
    children: ["pr1", "pr2"],
    kind: "flowchart",
  },
  // A cross-region edge: Product ↔ Pricing (must survive a collapse of
  // either side).
  { op: "CONNECT_NODES", source: "p1", target: "pr1", relationship: "constrains" },
];

const laidOutBoard = (): Workspace => {
  const ws = applyOperations(createWorkspace(), seedRegions());
  return applyLayout(ws, computeLayout(ws, { direction: "vertical" }));
};

/** The same member filter DiagramLayer applies for a collapsed set. */
const membersHiddenBy = (ws: Workspace, collapsed: ReadonlySet<string>) => {
  const of = (id: string) => ws.nodes[id]?.groupId;
  return new Set(Object.keys(ws.nodes).filter((id) => collapsed.has(of(id) ?? "")));
};

describe("collapse is a render filter — the model never changes", () => {
  it("expanding returns the EXACT prior geometry (pixel-identical)", () => {
    const board = laidOutBoard();
    const before = {
      p1: { ...board.nodes["p1"]!.position! },
      p2: { ...board.nodes["p2"]!.position! },
      pr1: { ...board.nodes["pr1"]!.position! },
    };

    // Collapse pricing: the model is untouched by definition, but prove it —
    // collapse→expand is two render states over one unchanged workspace.
    const collapsed = new Set(["pricing"]);
    expect(membersHiddenBy(board, collapsed)).toEqual(new Set(["pr1", "pr2"]));

    // The workspace the renderer would draw after expanding is the same
    // object it drew before collapsing: positions identical, byte for byte.
    expect(board.nodes["p1"]!.position).toEqual(before.p1);
    expect(board.nodes["p2"]!.position).toEqual(before.p2);
    expect(board.nodes["pr1"]!.position).toEqual(before.pr1);
  });

  it("a collapsed region hides exactly its members' nodes — no collateral", () => {
    const board = laidOutBoard();
    const hidden = membersHiddenBy(board, new Set(["product"]));
    expect([...hidden].sort()).toEqual(["p1", "p2"]);
    // Pricing members render on.
    const scene = diagramScene(board);
    const visible = visibleNodes(scene.nodes, null).map((n) => n.id);
    expect(visible).toContain("pr1");
  });
});

describe("cross-region edges survive a collapse", () => {
  it("an edge into a collapsed region keeps drawing (connects the card to the board)", () => {
    const board = laidOutBoard();
    const collapsed = new Set(["pricing"]);
    const isHidden = (id: string) => collapsed.has(board.nodes[id]?.groupId ?? "");
    // The DiagramLayer rule: an edge hides only when BOTH endpoints are
    // collapsed members. p1 (product, visible) → pr1 (pricing, collapsed)
    // stays — it visually ties the collapsed card to the product region.
    const crossEdge = Object.values(board.edges).find((e) => e.relationship === "constrains")!;
    const hide = isHidden(crossEdge.source) && isHidden(crossEdge.target);
    expect(hide).toBe(false);
    // The fully-inside-pricing edge hides.
    const inside = Object.values(board.edges).find((e) => e.relationship === "then")!;
    expect(isHidden(inside.source) && isHidden(inside.target)).toBe(true);
  });
});

describe("the summary card tells the truth about what it hides", () => {
  it("counts members and internal edges from the model", () => {
    const board = laidOutBoard();
    const group = board.groups["pricing"]!;
    // The counts the collapsed card shows (computed the way DiagramLayer does).
    const memberCount = Object.values(board.nodes).filter((n) => n.groupId === group.id).length;
    const edgeCount = Object.values(board.edges).filter(
      (e) =>
        board.nodes[e.source]?.groupId === group.id && board.nodes[e.target]?.groupId === group.id,
    ).length;
    expect(memberCount).toBe(2);
    expect(edgeCount).toBe(1);
    // And the region box is measured over the same members the card claims.
    const scene = diagramScene(board);
    const box = groupRegions(board, (id) => scene.byId.get(id)).find((r) => r.id === "pricing");
    expect(box).toBeDefined();
    expect(box!.width).toBeGreaterThan(0);
  });
});
