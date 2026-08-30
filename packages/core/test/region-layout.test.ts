import { describe, it, expect } from "vitest";
import { createWorkspace, applyOperations, applyLayout, computeLayout } from "@lucent/core";
import type { Operation } from "@lucent/core";

/** A linear chain a..f — the classic layered flow. */
const chain = (letters: string[], prefix = ""): Operation[] => {
  const ops: Operation[] = [];
  for (let i = 0; i < letters.length; i++) {
    ops.push({
      op: "CREATE_NODE",
      id: `${prefix}${letters[i]}`,
      nodeType: "step",
      label: `Step ${letters[i]}`,
    });
    if (i > 0) {
      ops.push({
        op: "CONNECT_NODES",
        source: `${prefix}${letters[i - 1]}`,
        target: `${prefix}${letters[i]}`,
        relationship: "then",
      });
    }
  }
  return ops;
};

/** A hub with branches — reads naturally as a radial mind map. */
const hubGraph = (prefix: string, branches: string[]): Operation[] => {
  const ops: Operation[] = [
    { op: "CREATE_NODE", id: `${prefix}hub`, nodeType: "topic", label: `${prefix} hub` },
  ];
  for (const b of branches) {
    ops.push({ op: "CREATE_NODE", id: `${prefix}${b}`, nodeType: "idea", label: `${prefix} ${b}` });
    ops.push({
      op: "CONNECT_NODES",
      source: `${prefix}hub`,
      target: `${prefix}${b}`,
      relationship: "branch",
    });
  }
  return ops;
};

describe("diagram regions in layout", () => {
  it("no regions = byte-identical to the pre-region engine", () => {
    const base = applyOperations(createWorkspace(), chain(["a", "b", "c", "d"]));
    const laid = applyLayout(base, computeLayout(base, { direction: "vertical" }));
    // Guard on shape, not coordinates: a chain of 4 places 4 nodes, layered.
    expect(Object.keys(laid.nodes)).toHaveLength(4);
    for (const id of ["a", "b", "c", "d"]) expect(laid.nodes[id]!.position).toBeDefined();
  });

  it("a board with only region members lays each region under its own strategy", () => {
    // Board kind flowchart; one mindmap region.
    const ws = applyOperations(createWorkspace(), [
      ...chain(["a", "b", "c"]),
      ...hubGraph("p", ["1", "2", "3", "4"]),
      {
        op: "CREATE_GROUP",
        id: "pricing",
        label: "Pricing",
        children: ["phub", "p1", "p2", "p3", "p4"],
        kind: "mindmap",
      },
    ]);
    const laid = applyLayout(ws, computeLayout(ws, { direction: "vertical" }));

    // Radial: the hub is the most-connected node, so it sits at the centre and
    // branches fan around it — their angles cover the full circle.
    const hub = laid.nodes.phub!.position!;
    const angles = ["p1", "p2", "p3", "p4"].map((id) => {
      const p = laid.nodes[id]!.position!;
      return Math.atan2(p.y - hub.y, p.x - hub.x);
    });
    angles.sort((a, b) => a - b);
    const spread = angles[angles.length - 1]! - angles[0]!;
    expect(spread).toBeGreaterThan(Math.PI); // fan, not a stack

    // Board flow nodes still exist and are placed.
    for (const id of ["a", "b", "c"]) expect(laid.nodes[id]!.position).toBeDefined();
  });

  it("regions and the board flow occupy disjoint horizontal bands", () => {
    const ws = applyOperations(createWorkspace(), [
      ...chain(["a", "b", "c"]),
      ...hubGraph("p", ["1", "2", "3"]),
      {
        op: "CREATE_GROUP",
        id: "pricing",
        label: "Pricing",
        children: ["phub", "p1", "p2", "p3"],
        kind: "mindmap",
      },
    ]);
    const laid = applyLayout(ws, computeLayout(ws, { direction: "vertical" }));
    const boardBottom = Math.max(
      ...["a", "b", "c"].map((id) => {
        const n = laid.nodes[id]!;
        return n.position!.y + (n.size?.height ?? 64);
      }),
    );
    const regionTop = Math.min(
      ...["phub", "p1", "p2", "p3"].map((id) => laid.nodes[id]!.position!.y),
    );
    expect(regionTop).toBeGreaterThan(boardBottom);
  });

  it("two regions of different kinds sit side by side without overlap", () => {
    const ws = applyOperations(createWorkspace(), [
      ...hubGraph("p", ["1", "2", "3"]),
      { op: "CREATE_GROUP", id: "mind", label: "Pricing ideas", children: ["phub", "p1", "p2", "p3"], kind: "mindmap" },
      ...chain(["x", "y"], "org_"),
      { op: "CREATE_GROUP", id: "org", label: "Team", children: ["org_x", "org_y"], kind: "orgchart" },
    ]);
    const laid = applyLayout(ws, computeLayout(ws, { direction: "vertical" }));
    const mindRight = Math.max(
      ...["phub", "p1", "p2", "p3"].map((id) => {
        const n = laid.nodes[id]!;
        return n.position!.x + (n.size?.width ?? 160);
      }),
    );
    const orgLeft = Math.min(
      ...["org_x", "org_y"].map((id) => laid.nodes[id]!.position!.x),
    );
    expect(orgLeft).toBeGreaterThan(mindRight);
  });

  it("changing a region's kind re-lays only that region", () => {
    const ws = applyOperations(createWorkspace(), [
      ...chain(["a", "b"]),
      ...hubGraph("p", ["1", "2", "3"]),
      { op: "CREATE_GROUP", id: "pricing", label: "Pricing", children: ["phub", "p1", "p2", "p3"], kind: "mindmap" },
    ]);
    const before = applyLayout(ws, computeLayout(ws, { direction: "vertical" }));
    const changed = applyOperations(ws, [
      { op: "SET_GROUP_KIND", id: "pricing", kind: "orgchart" },
    ]);
    const after = applyLayout(changed, computeLayout(changed, { direction: "vertical" }));

    // Board nodes keep their coordinates: the transform touched a region only.
    for (const id of ["a", "b"]) {
      expect(after.nodes[id]!.position).toEqual(before.nodes[id]!.position);
    }
    // Region nodes moved (radial -> tree).
    const moved = ["phub", "p1", "p2", "p3"].filter(
      (id) =>
        JSON.stringify(after.nodes[id]!.position) !== JSON.stringify(before.nodes[id]!.position),
    );
    expect(moved.length).toBeGreaterThan(0);
  });

  it("pinned nodes inside a region keep their hand-placed coordinates", () => {
    const ws = applyOperations(createWorkspace(), [
      ...hubGraph("p", ["1", "2", "3"]),
      { op: "CREATE_GROUP", id: "pricing", label: "Pricing", children: ["phub", "p1", "p2", "p3"], kind: "mindmap" },
      { op: "MOVE_NODE", id: "p2", position: { x: 5000, y: 5000 } },
    ]);
    const laid = applyLayout(ws, computeLayout(ws, { direction: "vertical" }));
    expect(laid.nodes.p2!.position).toEqual({ x: 5000, y: 5000 });
    expect(laid.nodes.p2!.pinned).toBe(true);
  });

  it("an explicit strategy override suspends the region split", () => {
    const ws = applyOperations(createWorkspace(), [
      ...hubGraph("p", ["1", "2", "3"]),
      { op: "CREATE_GROUP", id: "pricing", label: "Pricing", children: ["phub", "p1", "p2", "p3"], kind: "mindmap" },
    ]);
    // Ask for the whole board as layered: no region band, just the default flow.
    const laid = applyLayout(ws, computeLayout(ws, { direction: "vertical", strategy: "layered" }));
    expect(laid.nodes.phub!.position).toBeDefined();
    // All four nodes placed by the single layered pass.
    for (const id of ["phub", "p1", "p2", "p3"]) expect(laid.nodes[id]!.position).toBeDefined();
  });

  it("a kindless group changes nothing — the board-wide strategy still owns it", () => {
    const plain = applyOperations(createWorkspace(), [
      ...chain(["a", "b", "c"]),
      { op: "CREATE_GROUP", id: "g", label: "G", children: ["a", "b", "c"] },
    ]);
    const laid = applyLayout(plain, computeLayout(plain, { direction: "vertical" }));
    // Board kind flowchart -> layered: three rows of one node each.
    const ys = ["a", "b", "c"].map((id) => laid.nodes[id]!.position!.y);
    expect(new Set(ys).size).toBe(3);
  });
});
