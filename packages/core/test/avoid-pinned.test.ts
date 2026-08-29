import { describe, it, expect } from "vitest";
import {
  applyLayout,
  applyOperations,
  computeLayout,
  createWorkspace,
  type Operation,
} from "../src/index.js";

/**
 * The layout engine lays out the graph as if the canvas were empty, but a node
 * the user dragged by hand keeps its coordinates. Generating a new diagram onto a
 * board that already has hand-placed cards therefore dropped the new nodes right
 * on top of them.
 */
function overlaps(
  a: { position?: { x: number; y: number }; size?: { width: number; height: number } },
  b: { position?: { x: number; y: number }; size?: { width: number; height: number } },
) {
  if (!a.position || !a.size || !b.position || !b.size) return false;
  return (
    a.position.x < b.position.x + b.size.width &&
    b.position.x < a.position.x + a.size.width &&
    a.position.y < b.position.y + b.size.height &&
    b.position.y < a.position.y + a.size.height
  );
}

function laidOut(ws: ReturnType<typeof createWorkspace>) {
  return applyLayout(ws, computeLayout(ws, { direction: "vertical" }));
}

describe("layout avoids pinned nodes", () => {
  it("keeps generated nodes clear of a hand-placed node", () => {
    let ws = createWorkspace({ diagramKind: "flowchart" });
    // A note the user dragged to the origin area.
    ws = applyOperations(ws, [
      { op: "CREATE_NODE", id: "pinned", nodeType: "note", label: "hand placed" },
      { op: "MOVE_NODE", id: "pinned", position: { x: 0, y: 0 } },
    ]);
    // Then a generated diagram.
    const gen: Operation[] = [
      { op: "CREATE_NODE", id: "a", nodeType: "service", label: "A" },
      { op: "CREATE_NODE", id: "b", nodeType: "service", label: "B" },
      { op: "CONNECT_NODES", source: "a", target: "b", relationship: "calls" },
    ];
    const out = laidOut(applyOperations(ws, gen));
    expect(overlaps(out.nodes.a!, out.nodes.pinned!)).toBe(false);
    expect(overlaps(out.nodes.b!, out.nodes.pinned!)).toBe(false);
  });

  it("leaves the pinned node exactly where the user put it", () => {
    let ws = createWorkspace({ diagramKind: "flowchart" });
    ws = applyOperations(ws, [
      { op: "CREATE_NODE", id: "pinned", nodeType: "note", label: "n" },
      { op: "MOVE_NODE", id: "pinned", position: { x: 42, y: 77 } },
      { op: "CREATE_NODE", id: "a", nodeType: "service", label: "A" },
    ]);
    const out = laidOut(ws);
    expect(out.nodes.pinned!.position).toEqual({ x: 42, y: 77 });
  });

  it("is a no-op when nothing is pinned", () => {
    let ws = createWorkspace({ diagramKind: "flowchart" });
    ws = applyOperations(ws, [
      { op: "CREATE_NODE", id: "a", nodeType: "service", label: "A" },
      { op: "CREATE_NODE", id: "b", nodeType: "service", label: "B" },
    ]);
    const layout = computeLayout(ws, { direction: "vertical" });
    const out = applyLayout(ws, layout);
    expect(out.nodes.a!.position).toEqual(layout.a!.position);
    expect(out.nodes.b!.position).toEqual(layout.b!.position);
  });

  it("handles several pinned obstacles", () => {
    let ws = createWorkspace({ diagramKind: "flowchart" });
    ws = applyOperations(ws, [
      { op: "CREATE_NODE", id: "p1", nodeType: "note", label: "p1" },
      { op: "MOVE_NODE", id: "p1", position: { x: 0, y: 0 } },
      { op: "CREATE_NODE", id: "p2", nodeType: "note", label: "p2" },
      { op: "MOVE_NODE", id: "p2", position: { x: 0, y: 120 } },
      { op: "CREATE_NODE", id: "a", nodeType: "service", label: "A" },
    ]);
    const out = laidOut(ws);
    expect(overlaps(out.nodes.a!, out.nodes.p1!)).toBe(false);
    expect(overlaps(out.nodes.a!, out.nodes.p2!)).toBe(false);
  });

  it("still positions every node", () => {
    let ws = createWorkspace({ diagramKind: "flowchart" });
    ws = applyOperations(ws, [
      { op: "CREATE_NODE", id: "pinned", nodeType: "note", label: "n" },
      { op: "MOVE_NODE", id: "pinned", position: { x: 0, y: 0 } },
      { op: "CREATE_NODE", id: "a", nodeType: "service", label: "A" },
      { op: "CREATE_NODE", id: "b", nodeType: "service", label: "B" },
    ]);
    const out = laidOut(ws);
    for (const n of Object.values(out.nodes)) {
      expect(n.position).toBeDefined();
      expect(n.size).toBeDefined();
    }
  });
});

describe("avoidPinned moves the block, not individual nodes", () => {
  it("does not create new overlaps among the displaced nodes", () => {
    let ws = createWorkspace({ diagramKind: "flowchart" });
    // Two pinned notes sitting where a generated row would land.
    ws = applyOperations(ws, [
      { op: "CREATE_NODE", id: "p1", nodeType: "note", label: "p1" },
      { op: "MOVE_NODE", id: "p1", position: { x: -80, y: 0 } },
      { op: "CREATE_NODE", id: "p2", nodeType: "note", label: "p2" },
      { op: "MOVE_NODE", id: "p2", position: { x: 100, y: 0 } },
    ]);
    // A generated graph whose rows would collide with them.
    const gen: Operation[] = [
      { op: "CREATE_NODE", id: "gw", nodeType: "gateway", label: "API Gateway" },
      { op: "CREATE_NODE", id: "svc", nodeType: "service", label: "Order Service" },
      { op: "CREATE_NODE", id: "db", nodeType: "database", label: "Orders DB" },
      { op: "CONNECT_NODES", source: "gw", target: "svc", relationship: "routes to" },
      { op: "CONNECT_NODES", source: "svc", target: "db", relationship: "reads/writes" },
    ];
    const out = laidOut(applyOperations(ws, gen));
    const ids = Object.keys(out.nodes);
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        expect(overlaps(out.nodes[ids[i]!]!, out.nodes[ids[j]!]!)).toBe(false);
      }
    }
  });

  it("preserves the relative arrangement the layout computed", () => {
    let ws = createWorkspace({ diagramKind: "flowchart" });
    ws = applyOperations(ws, [
      { op: "CREATE_NODE", id: "pinned", nodeType: "note", label: "n" },
      { op: "MOVE_NODE", id: "pinned", position: { x: 0, y: 0 } },
      { op: "CREATE_NODE", id: "a", nodeType: "service", label: "A" },
      { op: "CREATE_NODE", id: "b", nodeType: "service", label: "B" },
      { op: "CONNECT_NODES", source: "a", target: "b", relationship: "calls" },
    ]);
    const out = laidOut(ws);
    // a stays above b, and the horizontal offset between them is unchanged.
    expect(out.nodes.a!.position!.y).toBeLessThan(out.nodes.b!.position!.y);
    const layout = computeLayout(ws, { direction: "vertical" });
    const dxBefore = layout.b!.position.x - layout.a!.position.x;
    const dxAfter = out.nodes.b!.position!.x - out.nodes.a!.position!.x;
    expect(dxAfter).toBe(dxBefore);
  });
});
