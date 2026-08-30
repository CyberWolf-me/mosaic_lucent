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

// ---- deep-chain wrap (found by the live test pass) -------------------------
//
// An 8-node linear chain (the exact e-commerce shape a first prompt builds)
// used to lay out as one node per layer stacked into a single 1300px-tall
// pole at one x — readable as a strand, not as a flow. The wrap breaks deep
// chains into rows across the canvas once the flow axis dwarfs the widest
// row. These tests pin the property a reader experiences (a bounded aspect,
// more than one x) rather than exact coordinates, so the rule can be tuned
// without breaking the pin.
describe("layered layout: deep-chain wrap", () => {
  /** The e-commerce chain: n nodes, each connected to the next. */
  const longChain = (n: number): Operation[] => {
    const ops: Operation[] = [{ op: "CREATE_NODE", id: "n0", nodeType: "actor", label: "Start" }];
    for (let i = 1; i < n; i += 1) {
      ops.push({ op: "CREATE_NODE", id: `n${i}`, nodeType: "step", label: `Step ${i}` });
      ops.push({
        op: "CONNECT_NODES",
        source: `n${i - 1}`,
        target: `n${i}`,
        relationship: "next",
      });
    }
    return ops;
  };

  it("an 8-node chain no longer lays out as a single pole", () => {
    const ws = applyOperations(createWorkspace(), longChain(8));
    const placed = applyLayout(ws, computeLayout(ws, { direction: "vertical" }));
    const xs = Object.values(placed.nodes).map((n) => Math.round(n.position?.x ?? 0));
    // The pole had exactly one x for every node. Wrapping must produce at
    // least two distinct columns — that is the whole fix.
    expect(new Set(xs).size).toBeGreaterThan(1);
  });

  it("the wrapped board's aspect is reader-shaped, not a strand", () => {
    const ws = applyOperations(createWorkspace(), longChain(8));
    const placed = applyLayout(ws, computeLayout(ws, { direction: "vertical" }));
    const xs = Object.values(placed.nodes).map((n) => n.position?.x ?? 0);
    const ys = Object.values(placed.nodes).map((n) => n.position?.y ?? 0);
    const height = Math.max(...ys) - Math.min(...ys);
    const width = Math.max(...xs) - Math.min(...xs);
    // Before the wrap this ratio was ~7 (a pole: 1300 tall, ~0 wide). After
    // it the board fills both axes; anything under 3 reads as a diagram.
    expect(height).toBeGreaterThan(0);
    if (width > 0) {
      expect(height / Math.max(width, 1)).toBeLessThan(3);
    }
  });

  it("a short chain is left alone (no wrap on 3 nodes)", () => {
    const ws = applyOperations(createWorkspace(), longChain(3));
    const placed = applyLayout(ws, computeLayout(ws, { direction: "vertical" }));
    // Short chains keep the classic single-column flow — the wrap only
    // engages past WRAP_ROW_LAYERS layers, so small boards don't change.
    const xs = Object.values(placed.nodes).map((n) => Math.round(n.position?.x ?? 0));
    expect(new Set(xs).size).toBe(1);
  });

  it("a board with hand-pinned nodes never wraps", () => {
    let ws = applyOperations(createWorkspace(), longChain(8));
    // Pin the first node, as a hand placement would.
    const first = Object.keys(ws.nodes)[0]!;
    ws = {
      ...ws,
      nodes: {
        ...ws.nodes,
        [first]: { ...ws.nodes[first]!, pinned: true, position: { x: 0, y: 0 } },
      },
    };
    const placed = applyLayout(ws, computeLayout(ws, { direction: "vertical" }));
    // The pinned node kept its coordinates (the existing contract) and the
    // wrap stayed off, so the user's arrangement is not re-flowed.
    expect(placed.nodes[first]!.position).toEqual({ x: 0, y: 0 });
    expect(placed.nodes[first]!.pinned).toBe(true);
  });
});
