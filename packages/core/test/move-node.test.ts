import { describe, it, expect } from "vitest";
import {
  applyLayout,
  applyOperations,
  computeLayout,
  createWorkspace,
  validateOperations,
} from "../src/index.js";

/**
 * A node the user drags by hand must keep its coordinates through later layout
 * passes; otherwise every AI edit snaps the board back and manual arrangement is
 * impossible.
 */

function seeded() {
  return applyOperations(createWorkspace(), [
    { op: "CREATE_NODE", id: "a", nodeType: "actor", label: "A" },
    { op: "CREATE_NODE", id: "b", nodeType: "service", label: "B" },
    { op: "CONNECT_NODES", source: "a", target: "b", relationship: "calls" },
  ]);
}

const laidOut = (ws: ReturnType<typeof seeded>) =>
  applyLayout(ws, computeLayout(ws, { direction: "vertical" }));

describe("MOVE_NODE", () => {
  it("validates against an existing node", () => {
    const ws = seeded();
    expect(
      validateOperations(ws, [{ op: "MOVE_NODE", id: "a", position: { x: 5, y: 6 } }]),
    ).toHaveLength(0);
    expect(
      validateOperations(ws, [{ op: "MOVE_NODE", id: "nope", position: { x: 0, y: 0 } }]),
    ).toHaveLength(1);
  });

  it("sets the position and pins the node", () => {
    const ws = applyOperations(seeded(), [
      { op: "MOVE_NODE", id: "a", position: { x: 300, y: 120 } },
    ]);
    expect(ws.nodes.a?.position).toEqual({ x: 300, y: 120 });
    expect(ws.nodes.a?.pinned).toBe(true);
  });

  it("survives a subsequent layout pass", () => {
    let ws = laidOut(seeded());
    const autoB = ws.nodes.b?.position;
    ws = applyOperations(ws, [{ op: "MOVE_NODE", id: "a", position: { x: 900, y: 400 } }]);
    ws = laidOut(ws);
    // The dragged node keeps the human placement...
    expect(ws.nodes.a?.position).toEqual({ x: 900, y: 400 });
    // ...while untouched nodes stay under automatic layout.
    expect(ws.nodes.b?.position).toEqual(autoB);
  });

  it("releases back to automatic layout when unpinned", () => {
    let ws = laidOut(seeded());
    const autoA = ws.nodes.a?.position;
    ws = applyOperations(ws, [{ op: "MOVE_NODE", id: "a", position: { x: 900, y: 400 } }]);
    ws = applyOperations(ws, [
      { op: "MOVE_NODE", id: "a", position: { x: 900, y: 400 }, pinned: false },
    ]);
    expect(ws.nodes.a?.pinned).toBeUndefined();
    ws = laidOut(ws);
    expect(ws.nodes.a?.position).toEqual(autoA);
  });

  it("keeps a size for a pinned node that never had one", () => {
    let ws = applyOperations(seeded(), [{ op: "MOVE_NODE", id: "a", position: { x: 10, y: 10 } }]);
    ws = laidOut(ws);
    expect(ws.nodes.a?.size).toBeDefined();
  });
});
