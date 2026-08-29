import { describe, it, expect } from "vitest";
import { createWorkspace } from "../src/model.js";
import { applyOperations } from "../src/reducer.js";
import { computeLayout, applyLayout } from "../src/layout.js";
import { History } from "../src/history.js";
import type { Operation } from "../src/operations.js";

const chain: Operation[] = [
  { op: "CREATE_NODE", id: "a", nodeType: "t", label: "A" },
  { op: "CREATE_NODE", id: "b", nodeType: "t", label: "B" },
  { op: "CREATE_NODE", id: "c", nodeType: "t", label: "C" },
  { op: "CONNECT_NODES", source: "a", target: "b", relationship: "next" },
  { op: "CONNECT_NODES", source: "b", target: "c", relationship: "next" },
];

describe("layout", () => {
  it("assigns increasing layers along a chain", () => {
    const ws = applyOperations(createWorkspace(), chain);
    const layout = computeLayout(ws, { direction: "vertical" });
    expect(layout.a.position.y).toBeLessThan(layout.b.position.y);
    expect(layout.b.position.y).toBeLessThan(layout.c.position.y);
  });

  it("does not hang on cycles", () => {
    const ws = applyOperations(createWorkspace(), [
      ...chain,
      { op: "CONNECT_NODES", source: "c", target: "a", relationship: "loop" },
    ]);
    const layout = computeLayout(ws);
    expect(Object.keys(layout)).toHaveLength(3);
  });

  it("applyLayout writes positions onto nodes immutably", () => {
    const ws = applyOperations(createWorkspace(), chain);
    const laid = applyLayout(ws, computeLayout(ws));
    expect(laid.nodes.a.position).toBeDefined();
    expect(ws.nodes.a.position).toBeUndefined();
  });
});

describe("history", () => {
  it("undo and redo move between states", () => {
    const h = new History(createWorkspace(), "start");
    const step1 = applyOperations(h.current, [chain[0]]);
    h.commit(step1, "add a");
    const step2 = applyOperations(h.current, [chain[1]]);
    h.commit(step2, "add b");

    expect(Object.keys(h.current.nodes)).toEqual(["a", "b"]);
    h.undo();
    expect(Object.keys(h.current.nodes)).toEqual(["a"]);
    h.undo();
    expect(Object.keys(h.current.nodes)).toHaveLength(0);
    h.redo();
    expect(Object.keys(h.current.nodes)).toEqual(["a"]);
  });

  it("commit clears the redo stack", () => {
    const h = new History(createWorkspace());
    h.commit(applyOperations(h.current, [chain[0]]), "add a");
    h.undo();
    expect(h.canRedo()).toBe(true);
    h.commit(applyOperations(h.current, [chain[1]]), "add b instead");
    expect(h.canRedo()).toBe(false);
  });
});
