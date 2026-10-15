import { describe, it, expect } from "vitest";
import { createWorkspace } from "../src/model.js";
import { applyOperations } from "../src/reducer.js";
import { OperationHistory } from "../src/operationHistory.js";
import type { Operation } from "../src/operations.js";

const build: Operation[] = [
  { op: "CREATE_NODE", id: "a", nodeType: "service", label: "A" },
  { op: "CREATE_NODE", id: "b", nodeType: "service", label: "B" },
  { op: "CONNECT_NODES", source: "a", target: "b", relationship: "calls" },
];

describe("OperationHistory — peek and recordApplied", () => {
  it("peeks the next undo and redo without moving the board", () => {
    const h = new OperationHistory(createWorkspace());
    h.commit(build, "build");
    const peek = h.peekUndo();
    expect(peek?.label).toBe("build");
    expect(peek?.inverses.filter((o) => o.op === "DELETE_NODE")).toHaveLength(2);
    expect(Object.keys(h.current().nodes)).toEqual(["a", "b"]);
    expect(h.peekRedo()).toBeUndefined();

    h.undo();
    expect(h.peekUndo()).toBeUndefined();
    expect(h.peekRedo()?.label).toBe("build");
  });

  it("records a batch applied elsewhere so undo reverts exactly it", () => {
    const base = applyOperations(createWorkspace(), [
      { op: "CREATE_NODE", id: "keep", nodeType: "note", label: "Someone else's" },
    ]);
    const h = new OperationHistory(base);
    // The batch reached the board remotely: the history is told the new state…
    const after = applyOperations(base, build);
    h.syncFromRemote(after);
    // …and records the batch against the state it was applied to.
    h.recordApplied(build, base, "approved proposal");
    expect(h.canUndo()).toBe(true);
    const { workspace, ops } = h.undo();
    expect(Object.keys(workspace.nodes)).toEqual(["keep"]);
    expect(ops.some((o) => o.op === "DELETE_NODE" && o.id === "keep")).toBe(false);
    const redone = h.redo();
    expect(Object.keys(redone.workspace.nodes).sort()).toEqual(["a", "b", "keep"]);
  });

  it("recording a remote batch starts a new branch (clears redo)", () => {
    const h = new OperationHistory(createWorkspace());
    h.commit([{ op: "CREATE_NODE", id: "x", nodeType: "note", label: "X" }], "x");
    h.undo();
    expect(h.canRedo()).toBe(true);
    const before = h.current();
    h.recordApplied(build, before, "approved");
    expect(h.canRedo()).toBe(false);
  });
});
