import { describe, it, expect } from "vitest";
import {
  applyLayout,
  applyOperations,
  computeLayout,
  createWorkspace,
  type DiagramKind,
  type Workspace,
} from "../src/index.js";

/**
 * Decision trees, process maps, and org charts each need geometry the layered
 * pass cannot express. A layered layout puts every same-depth node in one wide
 * row regardless of parent, so branches interleave; a process map needs lanes,
 * not columns of anonymous steps.
 */

const W = 160;
const H = 64;

/** A two-level branching tree: root → (yes, no); yes → (a, b). */
function tree(kind: DiagramKind) {
  return applyOperations(createWorkspace({ diagramKind: kind }), [
    { op: "CREATE_NODE", id: "root", nodeType: "decision", label: "Signed in?" },
    { op: "CREATE_NODE", id: "yes", nodeType: "step", label: "Dashboard" },
    { op: "CREATE_NODE", id: "no", nodeType: "step", label: "Login" },
    { op: "CREATE_NODE", id: "a", nodeType: "step", label: "Widgets" },
    { op: "CREATE_NODE", id: "b", nodeType: "step", label: "Reports" },
    { op: "CONNECT_NODES", source: "root", target: "yes", relationship: "yes" },
    { op: "CONNECT_NODES", source: "root", target: "no", relationship: "no" },
    { op: "CONNECT_NODES", source: "yes", target: "a", relationship: "next" },
    { op: "CONNECT_NODES", source: "yes", target: "b", relationship: "next" },
  ]);
}

const centreX = (ws: Workspace, layout: ReturnType<typeof computeLayout>, id: string) =>
  (layout[id]?.position.x ?? Number.NaN) + W / 2;

describe("tree layout — decision trees", () => {
  const layout = computeLayout(tree("decisiontree"));

  it("is chosen automatically for a decision tree", () => {
    // A layered layout would place `a` and `b` on the same row as `no`
    // (both depth 2 vs depth 1) — here depth follows the tree, and siblings
    // sit side by side under their own parent.
    expect(layout.root?.position.y).toBe(0);
    expect(layout.yes?.position.y).toBe(layout.no?.position.y);
    expect(layout.a?.position.y).toBe(layout.b?.position.y);
    expect(layout.a!.position.y).toBeGreaterThan(layout.yes!.position.y);
  });

  it("centres a parent over the span of its own children", () => {
    const kids = [
      centreX(tree("decisiontree"), layout, "a"),
      centreX(tree("decisiontree"), layout, "b"),
    ];
    const expected = (kids[0]! + kids[1]!) / 2;
    expect(centreX(tree("decisiontree"), layout, "yes")).toBeCloseTo(expected, 0);
  });

  it("centres the root over all of its descendants", () => {
    const left = centreX(tree("decisiontree"), layout, "yes");
    const right = centreX(tree("decisiontree"), layout, "no");
    const root = centreX(tree("decisiontree"), layout, "root");
    expect(root).toBeGreaterThan(Math.min(left, right) - 1);
    expect(root).toBeLessThan(Math.max(left, right) + 1);
  });

  it("never overlaps two leaves", () => {
    const leaves = ["a", "b", "no"].map((id) => layout[id]!.position);
    for (let i = 0; i < leaves.length; i++) {
      for (let j = i + 1; j < leaves.length; j++) {
        const overlapX = Math.abs(leaves[i]!.x - leaves[j]!.x) < W;
        const overlapY = Math.abs(leaves[i]!.y - leaves[j]!.y) < H;
        expect(overlapX && overlapY, `${i} overlaps ${j}`).toBe(false);
      }
    }
  });

  it("is deterministic", () => {
    expect(JSON.stringify(computeLayout(tree("decisiontree")))).toBe(
      JSON.stringify(computeLayout(tree("decisiontree"))),
    );
  });

  it("positions every node", () => {
    expect(Object.keys(layout).sort()).toEqual(["a", "b", "no", "root", "yes"]);
  });
});

describe("tree layout — org charts", () => {
  it("uses the tree strategy for an org chart too", () => {
    const layout = computeLayout(tree("orgchart"));
    expect(layout.yes?.position.y).toBe(layout.no?.position.y);
    expect(layout.a!.position.y).toBeGreaterThan(layout.yes!.position.y);
  });

  it("handles a single reporting line without gaps", () => {
    const ws = applyOperations(createWorkspace({ diagramKind: "orgchart" }), [
      { op: "CREATE_NODE", id: "ceo", nodeType: "actor", label: "CEO" },
      { op: "CREATE_NODE", id: "vp", nodeType: "actor", label: "VP" },
      { op: "CREATE_NODE", id: "ic", nodeType: "actor", label: "Engineer" },
      { op: "CONNECT_NODES", source: "ceo", target: "vp", relationship: "manages" },
      { op: "CONNECT_NODES", source: "vp", target: "ic", relationship: "manages" },
    ]);
    const layout = computeLayout(ws);
    // A pure chain stacks vertically with each level directly beneath.
    expect(layout.ceo?.position.x).toBe(layout.vp?.position.x);
    expect(layout.vp?.position.x).toBe(layout.ic?.position.x);
    expect(layout.ic!.position.y).toBeGreaterThan(layout.vp!.position.y);
  });

  it("lays out multiple roots side by side", () => {
    const ws = applyOperations(createWorkspace({ diagramKind: "orgchart" }), [
      { op: "CREATE_NODE", id: "r1", nodeType: "actor", label: "Founder A" },
      { op: "CREATE_NODE", id: "r2", nodeType: "actor", label: "Founder B" },
    ]);
    const layout = computeLayout(ws);
    expect(layout.r1?.position.y).toBe(0);
    expect(layout.r2?.position.y).toBe(0);
    expect(layout.r1?.position.x).not.toBe(layout.r2?.position.x);
  });

  it("survives a cycle without hanging or dropping nodes", () => {
    const ws = applyOperations(createWorkspace({ diagramKind: "orgchart" }), [
      { op: "CREATE_NODE", id: "a", nodeType: "actor", label: "A" },
      { op: "CREATE_NODE", id: "b", nodeType: "actor", label: "B" },
      { op: "CONNECT_NODES", source: "a", target: "b", relationship: "manages" },
      { op: "CONNECT_NODES", source: "b", target: "a", relationship: "manages" },
    ]);
    const layout = computeLayout(ws);
    expect(Object.keys(layout).sort()).toEqual(["a", "b"]);
  });

  it("places a detached node instead of dropping it", () => {
    const ws = applyOperations(tree("orgchart"), [
      { op: "CREATE_NODE", id: "lonely", nodeType: "actor", label: "Contractor" },
    ]);
    const layout = computeLayout(ws);
    expect(layout.lonely).toBeDefined();
  });
});

describe("swimlane layout — process maps", () => {
  /** Two lanes (Sales, Ops) with a flow crossing between them. */
  function processMap() {
    return applyOperations(createWorkspace({ diagramKind: "process" }), [
      { op: "CREATE_GROUP", id: "sales", label: "Sales", children: [] },
      { op: "CREATE_GROUP", id: "ops", label: "Ops", children: [] },
      { op: "CREATE_NODE", id: "lead", nodeType: "step", label: "Capture lead", groupId: "sales" },
      { op: "CREATE_NODE", id: "quote", nodeType: "step", label: "Send quote", groupId: "sales" },
      { op: "CREATE_NODE", id: "fulfil", nodeType: "step", label: "Fulfil order", groupId: "ops" },
      { op: "CREATE_NODE", id: "ship", nodeType: "step", label: "Ship", groupId: "ops" },
      { op: "CONNECT_NODES", source: "lead", target: "quote", relationship: "next" },
      { op: "CONNECT_NODES", source: "quote", target: "fulfil", relationship: "handoff" },
      { op: "CONNECT_NODES", source: "fulfil", target: "ship", relationship: "next" },
    ]);
  }

  const layout = computeLayout(processMap());

  it("is chosen automatically for a process map", () => {
    // Same lane => same y; different lane => different y.
    expect(layout.lead?.position.y).toBe(layout.quote?.position.y);
    expect(layout.fulfil?.position.y).toBe(layout.ship?.position.y);
    expect(layout.lead?.position.y).not.toBe(layout.fulfil?.position.y);
  });

  it("advances flow left to right by depth", () => {
    expect(layout.quote!.position.x).toBeGreaterThan(layout.lead!.position.x);
    expect(layout.fulfil!.position.x).toBeGreaterThan(layout.quote!.position.x);
    expect(layout.ship!.position.x).toBeGreaterThan(layout.fulfil!.position.x);
  });

  it("keeps a handoff moving forward across lanes", () => {
    // The Ops work starts to the right of the Sales step that hands off to it,
    // which is the whole point of a process map reading left to right.
    expect(layout.fulfil!.position.x).toBeGreaterThan(layout.quote!.position.x);
  });

  it("gives ungrouped nodes their own trailing lane", () => {
    const ws = applyOperations(processMap(), [
      { op: "CREATE_NODE", id: "audit", nodeType: "step", label: "Audit" },
    ]);
    const l = computeLayout(ws);
    const lanes = new Set([l.lead!.position.y, l.fulfil!.position.y, l.audit!.position.y]);
    expect(lanes.size).toBe(3);
  });

  it("offsets two steps that share a lane and a depth", () => {
    const ws = applyOperations(createWorkspace({ diagramKind: "process" }), [
      { op: "CREATE_GROUP", id: "g", label: "Team", children: [] },
      { op: "CREATE_NODE", id: "a", nodeType: "step", label: "A", groupId: "g" },
      { op: "CREATE_NODE", id: "b", nodeType: "step", label: "B", groupId: "g" },
    ]);
    const l = computeLayout(ws);
    // Both are depth 0 in the same lane, so they must not stack on top of each other.
    expect(l.a?.position.x).toBe(l.b?.position.x);
    expect(l.a?.position.y).not.toBe(l.b?.position.y);
  });

  it("is deterministic", () => {
    expect(JSON.stringify(computeLayout(processMap()))).toBe(
      JSON.stringify(computeLayout(processMap())),
    );
  });
});

describe("strategy selection", () => {
  it("keeps layered layout for the original kinds", () => {
    for (const kind of ["flowchart", "architecture", "journey"] as const) {
      const ws = applyOperations(createWorkspace({ diagramKind: kind }), [
        { op: "CREATE_NODE", id: "x", nodeType: "step", label: "X" },
        { op: "CREATE_NODE", id: "y", nodeType: "step", label: "Y" },
        { op: "CONNECT_NODES", source: "x", target: "y", relationship: "next" },
      ]);
      const l = computeLayout(ws);
      // Layered vertical: same x, y increasing.
      expect(l.x?.position.x, kind).toBe(l.y?.position.x);
      expect(l.y!.position.y, kind).toBeGreaterThan(l.x!.position.y);
    }
  });

  it("honours an explicit strategy override for any kind", () => {
    const asTree = computeLayout(tree("flowchart"), { strategy: "tree" });
    expect(asTree.yes?.position.y).toBe(asTree.no?.position.y);

    const asLayered = computeLayout(tree("decisiontree"), { strategy: "layered" });
    // Layered collapses `no` and the deeper leaves onto rows by depth alone.
    expect(asLayered.root?.position.y).toBe(0);
  });

  it("respects a pinned node in every new strategy", () => {
    for (const kind of ["decisiontree", "orgchart", "process"] as const) {
      let ws = applyOperations(tree(kind), [
        { op: "MOVE_NODE", id: "no", position: { x: 999, y: -400 } },
      ]);
      ws = applyLayout(ws, computeLayout(ws));
      expect(ws.nodes.no?.position, kind).toEqual({ x: 999, y: -400 });
    }
  });

  it("returns an empty result for an empty board", () => {
    for (const kind of ["decisiontree", "process", "orgchart"] as const) {
      expect(computeLayout(createWorkspace({ diagramKind: kind }))).toEqual({});
    }
  });
});
