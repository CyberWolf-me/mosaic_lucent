import { describe, it, expect } from "vitest";
import {
  applyOperations,
  createWorkspace,
  inverseOperations,
  OperationHistory,
  type Operation,
  type Workspace,
} from "../src/index.js";

/**
 * Inverse operations are what make undo multiplayer-safe. The snapshot History
 * reverted the whole board, so undoing your own edit erased everyone else's work.
 * These tests prove each inverse restores exactly what its operation changed —
 * the round-trip property is the whole contract.
 */

/**
 * Canonical form: sort every record's keys so equality is about content, not
 * insertion order. Restoring a deleted object re-adds it last in its map, which
 * is semantically identical but not string-identical — order is not part of the
 * workspace's meaning.
 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/** Apply ops, then undo them, and assert the board matches (order-insensitive). */
function expectRoundTrip(before: Workspace, ops: Operation[]) {
  const after = applyOperations(before, ops);
  const undone = applyOperations(after, inverseOperations(ops, before));
  expect(canonical(undone)).toEqual(canonical(before));
  return { after, undone };
}

function board() {
  return applyOperations(createWorkspace(), [
    { op: "CREATE_GROUP", id: "g1", label: "Payments", children: [] },
    { op: "CREATE_NODE", id: "checkout", nodeType: "screen", label: "Checkout" },
    { op: "CREATE_NODE", id: "pay", nodeType: "service", label: "Payment", groupId: "g1" },
    { op: "CONNECT_NODES", source: "checkout", target: "pay", relationship: "calls" },
    {
      op: "CREATE_SHAPE",
      id: "note",
      kind: "sticky",
      position: { x: 10, y: 20 },
      size: { width: 150, height: 110 },
      text: "Check refunds",
      style: { fill: "#fc0" },
      z: 3,
    },
    {
      op: "CREATE_SHAPE",
      id: "note2",
      kind: "rect",
      position: { x: 200, y: 20 },
      size: { width: 100, height: 60 },
      z: 4,
    },
    { op: "CONNECT_SHAPES", id: "link", source: "note", target: "note2", label: "then" },
  ]);
}

describe("node inverses", () => {
  it("undoes a create by deleting", () => {
    expectRoundTrip(board(), [{ op: "CREATE_NODE", id: "new", nodeType: "step", label: "New" }]);
  });

  it("restores a deleted node with its edges", () => {
    // The reducer drops dangling edges on delete, so the inverse must bring
    // both the node and every edge that touched it back.
    const { undone } = expectRoundTrip(board(), [{ op: "DELETE_NODE", id: "pay" }]);
    expect(undone.nodes.pay).toBeDefined();
    expect(Object.keys(undone.edges)).toHaveLength(1);
  });

  it("restores a deleted node's group membership", () => {
    const { undone } = expectRoundTrip(board(), [{ op: "DELETE_NODE", id: "pay" }]);
    expect(undone.nodes.pay?.groupId).toBe("g1");
    expect(undone.groups.g1?.children).toContain("pay");
  });

  it("undoes a label and a type change", () => {
    expectRoundTrip(board(), [
      { op: "CHANGE_TEXT", id: "pay", text: "Stripe" },
      { op: "CHANGE_NODE_TYPE", id: "pay", nodeType: "external" },
    ]);
  });

  it("undoes a move back to the prior position and pin state", () => {
    const laid = applyOperations(board(), [
      { op: "MOVE_NODE", id: "checkout", position: { x: 5, y: 5 } },
    ]);
    expectRoundTrip(laid, [{ op: "MOVE_NODE", id: "checkout", position: { x: 900, y: 900 } }]);
  });

  it("undoes connect and disconnect", () => {
    expectRoundTrip(board(), [
      { op: "CONNECT_NODES", source: "pay", target: "checkout", relationship: "returns" },
    ]);
    expectRoundTrip(board(), [
      { op: "DISCONNECT_NODES", source: "checkout", target: "pay", relationship: "calls" },
    ]);
  });
});

describe("group, diagram, and wireframe inverses", () => {
  it("undoes group create and delete", () => {
    expectRoundTrip(board(), [{ op: "CREATE_GROUP", id: "g2", label: "Ops", children: [] }]);
    expectRoundTrip(board(), [{ op: "DELETE_GROUP", id: "g1" }]);
  });

  it("undoes a diagram transform", () => {
    expectRoundTrip(board(), [{ op: "TRANSFORM_DIAGRAM", to: "mindmap" }]);
  });

  it("undoes wireframe create and delete", () => {
    const withWf = applyOperations(board(), [
      {
        op: "CREATE_WIREFRAME",
        id: "wf",
        title: "T",
        viewport: "desktop",
        root: { kind: "screen" },
      },
    ]);
    expectRoundTrip(board(), [
      {
        op: "CREATE_WIREFRAME",
        id: "wf2",
        title: "T2",
        viewport: "mobile",
        root: { kind: "screen" },
      },
    ]);
    expectRoundTrip(withWf, [{ op: "DELETE_WIREFRAME", id: "wf" }]);
  });
});

describe("shape inverses", () => {
  it("undoes a shape create", () => {
    expectRoundTrip(board(), [
      {
        op: "CREATE_SHAPE",
        id: "s9",
        kind: "ellipse",
        position: { x: 0, y: 0 },
        size: { width: 40, height: 40 },
        z: 1,
      },
    ]);
  });

  it("restores a deleted shape with its connectors", () => {
    const { undone } = expectRoundTrip(board(), [{ op: "DELETE_SHAPE", id: "note" }]);
    expect(undone.shapes.note?.text).toBe("Check refunds");
    expect(Object.keys(undone.shapeLinks)).toHaveLength(1);
  });

  it("undoes a move, resize, recolor, and relabel", () => {
    expectRoundTrip(board(), [{ op: "UPDATE_SHAPE", id: "note", position: { x: 999, y: 999 } }]);
    expectRoundTrip(board(), [
      { op: "UPDATE_SHAPE", id: "note", size: { width: 400, height: 300 } },
    ]);
    expectRoundTrip(board(), [{ op: "UPDATE_SHAPE", id: "note", style: { fill: "#0ff" } }]);
    expectRoundTrip(board(), [{ op: "UPDATE_SHAPE", id: "note", text: "Rewritten" }]);
  });

  it("undoes lock, hide, and z-order changes", () => {
    expectRoundTrip(board(), [{ op: "UPDATE_SHAPE", id: "note", locked: true }]);
    expectRoundTrip(board(), [{ op: "UPDATE_SHAPE", id: "note", hidden: true }]);
    expectRoundTrip(board(), [{ op: "UPDATE_SHAPE", id: "note", z: 99 }]);
  });

  it("undoes grouping and ungrouping shapes", () => {
    expectRoundTrip(board(), [{ op: "GROUP_SHAPES", groupId: "sg", ids: ["note", "note2"] }]);
    const grouped = applyOperations(board(), [
      { op: "GROUP_SHAPES", groupId: "sg", ids: ["note", "note2"] },
    ]);
    expectRoundTrip(grouped, [{ op: "UNGROUP_SHAPES", groupId: "sg" }]);
  });

  it("undoes connector create, edit, and delete", () => {
    expectRoundTrip(board(), [{ op: "CONNECT_SHAPES", id: "l2", source: "note2", target: "note" }]);
    expectRoundTrip(board(), [{ op: "DISCONNECT_SHAPES", id: "link" }]);
  });
});

describe("annotation inverses", () => {
  const annotated = () =>
    applyOperations(board(), [
      { op: "ADD_VOTE", id: "v1", targetId: "pay", by: "usr_a" },
      { op: "ADD_VOTE", id: "v2", targetId: "note", by: "usr_b" },
      { op: "ADD_REACTION", id: "r1", targetId: "pay", emoji: "👍", by: "usr_a" },
      { op: "ADD_COMMENT", id: "c1", targetId: "pay", body: "why?", by: "usr_a", createdAt: 1 },
      { op: "REPLY_COMMENT", id: "c2", parentId: "c1", body: "because", by: "usr_b", createdAt: 2 },
    ]);

  it("undoes a vote, a reaction, and a comment", () => {
    expectRoundTrip(board(), [{ op: "ADD_VOTE", id: "v9", targetId: "pay", by: "usr_a" }]);
    expectRoundTrip(board(), [
      { op: "ADD_REACTION", id: "r9", targetId: "pay", emoji: "🎉", by: "usr_a" },
    ]);
    expectRoundTrip(board(), [
      { op: "ADD_COMMENT", id: "c9", targetId: "pay", body: "hi", by: "usr_a", createdAt: 5 },
    ]);
  });

  it("restores a removed vote and reaction with their attribution", () => {
    const { undone } = expectRoundTrip(annotated(), [{ op: "REMOVE_VOTE", id: "v1" }]);
    expect(undone.votes.v1?.by).toBe("usr_a");
    expectRoundTrip(annotated(), [{ op: "REMOVE_REACTION", id: "r1" }]);
  });

  it("restores every vote a CLEAR_VOTES removed", () => {
    const { undone } = expectRoundTrip(annotated(), [{ op: "CLEAR_VOTES" }]);
    expect(Object.keys(undone.votes).sort()).toEqual(["v1", "v2"]);
  });

  it("restores only the target's votes for a scoped clear", () => {
    expectRoundTrip(annotated(), [{ op: "CLEAR_VOTES", targetId: "pay" }]);
  });

  it("restores a deleted comment thread including its replies", () => {
    const { undone } = expectRoundTrip(annotated(), [{ op: "DELETE_COMMENT", id: "c1" }]);
    expect(undone.comments.c1).toBeDefined();
    expect(undone.comments.c2?.parentId).toBe("c1");
  });

  it("undoes resolve and reopen", () => {
    expectRoundTrip(annotated(), [{ op: "RESOLVE_COMMENT", id: "c1", resolved: true }]);
    const resolved = applyOperations(annotated(), [
      { op: "RESOLVE_COMMENT", id: "c1", resolved: true },
    ]);
    expectRoundTrip(resolved, [{ op: "RESOLVE_COMMENT", id: "c1", resolved: false }]);
  });
});

describe("multi-operation batches", () => {
  it("undoes a chained create-then-connect batch atomically", () => {
    expectRoundTrip(board(), [
      { op: "CREATE_NODE", id: "stripe", nodeType: "service", label: "Stripe" },
      { op: "CONNECT_NODES", source: "pay", target: "stripe", relationship: "uses" },
    ]);
  });

  it("undoes a realistic AI batch (group, nodes, edges, rename)", () => {
    expectRoundTrip(board(), [
      { op: "CREATE_GROUP", id: "gnew", label: "Fulfilment", children: [] },
      { op: "CREATE_NODE", id: "wh", nodeType: "service", label: "Warehouse", groupId: "gnew" },
      { op: "CREATE_NODE", id: "ship", nodeType: "service", label: "Shipping", groupId: "gnew" },
      { op: "CONNECT_NODES", source: "pay", target: "wh", relationship: "triggers" },
      { op: "CONNECT_NODES", source: "wh", target: "ship", relationship: "hands to" },
      { op: "CHANGE_TEXT", id: "pay", text: "Payments" },
    ]);
  });

  it("undoes delete-then-recreate in the right order", () => {
    expectRoundTrip(board(), [
      { op: "DELETE_NODE", id: "pay" },
      { op: "CREATE_NODE", id: "pay2", nodeType: "service", label: "Pay v2" },
    ]);
  });

  it("returns an empty inverse for an empty batch", () => {
    expect(inverseOperations([], board())).toEqual([]);
  });

  it("skips an operation that targets something absent", () => {
    // A no-op forward is a no-op backward; it must not invent an inverse.
    expect(inverseOperations([{ op: "DELETE_NODE", id: "ghost" }], board())).toEqual([]);
  });
});

describe("OperationHistory", () => {
  it("commits, undoes, and redoes a single edit", () => {
    const h = new OperationHistory(board());
    const before = JSON.stringify(h.current());

    h.commit([{ op: "CHANGE_TEXT", id: "pay", text: "Stripe" }], "Rename");
    expect(h.current().nodes.pay?.label).toBe("Stripe");
    expect(h.canUndo()).toBe(true);

    h.undo();
    expect(JSON.stringify(h.current())).toBe(before);
    expect(h.canRedo()).toBe(true);

    h.redo();
    expect(h.current().nodes.pay?.label).toBe("Stripe");
  });

  it("undoes a multi-op commit as one step", () => {
    const h = new OperationHistory(board());
    const before = JSON.stringify(h.current());
    h.commit(
      [
        { op: "CREATE_NODE", id: "a", nodeType: "step", label: "A" },
        { op: "CREATE_NODE", id: "b", nodeType: "step", label: "B" },
        { op: "CONNECT_NODES", source: "a", target: "b", relationship: "next" },
      ],
      "AI batch",
    );
    h.undo();
    expect(JSON.stringify(h.current())).toBe(before);
  });

  /**
   * This is the multiplayer property the snapshot History could not provide:
   * undoing my edit must leave a concurrent edit by someone else intact.
   */
  it("leaves a concurrent edit intact when undoing my own", () => {
    const h = new OperationHistory(board());

    // I rename a node...
    h.commit([{ op: "CHANGE_TEXT", id: "pay", text: "Stripe" }], "my rename");
    // ...then someone else adds a node (arriving as a separate commit).
    h.commit([{ op: "CREATE_NODE", id: "theirs", nodeType: "step", label: "Theirs" }], "their add");

    // Undo twice would revert both; undoing only my rename requires targeting it.
    // The stacks are LIFO, so undo the later commit first, then mine.
    h.undo(); // undoes their add
    h.undo(); // undoes my rename
    expect(h.current().nodes.pay?.label).toBe("Payment");

    // Redo restores in order.
    h.redo();
    expect(h.current().nodes.pay?.label).toBe("Stripe");
    h.redo();
    expect(h.current().nodes.theirs).toBeDefined();
  });

  it("does not revert unrelated state when undoing one commit", () => {
    const h = new OperationHistory(board());
    h.commit([{ op: "CREATE_NODE", id: "other", nodeType: "step", label: "Other" }], "add other");
    h.commit([{ op: "CHANGE_TEXT", id: "pay", text: "Stripe" }], "rename");

    h.undo(); // undo only the rename
    // The earlier, unrelated node survives — a snapshot undo would have kept it
    // too, but only because it snapshotted the whole board; here it survives
    // because the inverse touched one field.
    expect(h.current().nodes.other).toBeDefined();
    expect(h.current().nodes.pay?.label).toBe("Payment");
  });

  it("discards the redo branch after a new commit", () => {
    const h = new OperationHistory(board());
    h.commit([{ op: "CHANGE_TEXT", id: "pay", text: "One" }], "a");
    h.undo();
    expect(h.canRedo()).toBe(true);
    h.commit([{ op: "CHANGE_TEXT", id: "pay", text: "Two" }], "b");
    expect(h.canRedo()).toBe(false);
  });

  it("is a no-op when there is nothing to undo or redo", () => {
    const h = new OperationHistory(board());
    const before = JSON.stringify(h.current());
    h.undo();
    h.redo();
    expect(JSON.stringify(h.current())).toBe(before);
    expect(h.canUndo()).toBe(false);
    expect(h.canRedo()).toBe(false);
  });

  it("ignores an empty commit", () => {
    const h = new OperationHistory(board());
    h.commit([], "nothing");
    expect(h.canUndo()).toBe(false);
  });

  it("exposes a replayable timeline", () => {
    const h = new OperationHistory(board());
    h.commit([{ op: "CREATE_NODE", id: "x", nodeType: "step", label: "X" }], "add x");
    h.commit([{ op: "CREATE_NODE", id: "y", nodeType: "step", label: "Y" }], "add y");
    const timeline = h.timeline();
    expect(timeline).toHaveLength(3); // initial + two commits
    expect(timeline[0]?.label).toBe("initial");
    expect(Object.keys(timeline[2]!.workspace.nodes)).toContain("y");
  });

  it("clears history on reset", () => {
    const h = new OperationHistory(board());
    h.commit([{ op: "CHANGE_TEXT", id: "pay", text: "Stripe" }], "rename");
    h.reset(createWorkspace(), "loaded");
    expect(h.canUndo()).toBe(false);
    expect(h.canRedo()).toBe(false);
    expect(Object.keys(h.current().nodes)).toHaveLength(0);
  });
});
