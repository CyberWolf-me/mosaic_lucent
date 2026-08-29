import { describe, it, expect } from "vitest";
import { createWorkspace } from "../src/model.js";
import { applyOperations } from "../src/reducer.js";
import { History } from "../src/history.js";

describe("History", () => {
  const base = createWorkspace();
  const withA = applyOperations(base, [
    { op: "CREATE_NODE", id: "a", nodeType: "service", label: "A" },
  ]);
  const withAB = applyOperations(withA, [
    { op: "CREATE_NODE", id: "b", nodeType: "service", label: "B" },
  ]);

  it("commits and undoes/redoes", () => {
    const h = new History(base, "initial");
    h.commit(withA, "add A");
    h.commit(withAB, "add B");
    expect(Object.keys(h.current.nodes)).toEqual(["a", "b"]);
    expect(h.undo()).toBe(withA);
    expect(h.canRedo()).toBe(true);
    expect(h.redo()).toBe(withAB);
  });

  it("restores an earlier version non-destructively", () => {
    const h = new History(base, "initial");
    h.commit(withA, "add A");
    h.commit(withAB, "add B");

    // timeline: [initial, add A, add B] -> restore index 1 (add A)
    const restored = h.restoreTo(1);
    expect(Object.keys(restored.nodes)).toEqual(["a"]);
    // The restore is itself a new entry, so the full history is preserved.
    expect(h.timeline()).toHaveLength(4);
    // ...and reversible: undoing returns to the pre-restore present (add B).
    expect(Object.keys(h.undo().nodes)).toEqual(["a", "b"]);
  });

  it("is a no-op for an out-of-range index", () => {
    const h = new History(base, "initial");
    h.commit(withA, "add A");
    expect(h.restoreTo(99)).toBe(withA);
  });
});
