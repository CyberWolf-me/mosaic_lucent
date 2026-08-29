import { describe, it, expect } from "vitest";
import {
  applyOperations,
  computeLayout,
  createWorkspace,
  measureNode,
  type DiagramKind,
  type Workspace,
} from "../src/index.js";

/**
 * Measured node sizes per layout strategy (M0.5).
 *
 * `measureNode` estimates how much room a label needs. Before this milestone
 * only the layered strategy called it, so mind maps, decision trees, org
 * charts and process maps sized every node at the default and long labels
 * clipped. These tests pin, for each strategy: the size a long label gets is
 * the measured one, and two long-labelled siblings do not overlap.
 */

const DEFAULT = { width: 160, height: 64 };
const LONG = "A deliberately long node label that needs more than the default width";
const SHORT = "OK";

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function boxOf(layout: ReturnType<typeof computeLayout>, id: string): Box {
  const entry = layout[id];
  if (!entry) throw new Error(`no layout entry for ${id}`);
  return {
    x: entry.position.x,
    y: entry.position.y,
    w: entry.size.width,
    h: entry.size.height,
  };
}

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

describe("radial layout (mind maps) uses measured sizes", () => {
  function mindmap(): Workspace {
    return applyOperations(createWorkspace({ diagramKind: "mindmap" }), [
      { op: "CREATE_NODE", id: "centre", nodeType: "topic", label: "Centre" },
      { op: "CREATE_NODE", id: "long1", nodeType: "topic", label: LONG },
      { op: "CREATE_NODE", id: "long2", nodeType: "topic", label: LONG },
      { op: "CREATE_NODE", id: "short", nodeType: "topic", label: SHORT },
      { op: "CONNECT_NODES", source: "centre", target: "long1", relationship: "branch" },
      { op: "CONNECT_NODES", source: "centre", target: "long2", relationship: "branch" },
      { op: "CONNECT_NODES", source: "centre", target: "short", relationship: "branch" },
    ]);
  }

  it("gives a long-labelled node the measured width, not the default", () => {
    const layout = computeLayout(mindmap());
    const expected = measureNode(LONG, DEFAULT);
    expect(boxOf(layout, "long1").w).toBe(expected.width);
    expect(boxOf(layout, "long1").w).toBeGreaterThan(DEFAULT.width);
  });

  it("keeps a short label at the default width", () => {
    const layout = computeLayout(mindmap());
    expect(boxOf(layout, "short").w).toBe(DEFAULT.width);
  });

  it("does not overlap two long-labelled siblings on the same ring", () => {
    const layout = computeLayout(mindmap());
    expect(overlaps(boxOf(layout, "long1"), boxOf(layout, "long2"))).toBe(false);
  });

  it("keeps the centre node centred on its own measured size", () => {
    const layout = computeLayout(mindmap());
    const centre = boxOf(layout, "centre");
    expect(centre.x).toBe(-centre.w / 2);
    expect(centre.y).toBe(-centre.h / 2);
  });
});

describe("tree layout (decision trees, org charts) uses measured sizes", () => {
  function tree(kind: DiagramKind): Workspace {
    return applyOperations(createWorkspace({ diagramKind: kind }), [
      { op: "CREATE_NODE", id: "root", nodeType: "decision", label: "Root" },
      { op: "CREATE_NODE", id: "leafA", nodeType: "step", label: LONG },
      { op: "CREATE_NODE", id: "leafB", nodeType: "step", label: LONG },
      { op: "CONNECT_NODES", source: "root", target: "leafA", relationship: "yes" },
      { op: "CONNECT_NODES", source: "root", target: "leafB", relationship: "no" },
    ]);
  }

  it("gives a long-labelled leaf the measured width", () => {
    const layout = computeLayout(tree("decisiontree"));
    expect(boxOf(layout, "leafA").w).toBe(measureNode(LONG, DEFAULT).width);
  });

  it("does not overlap two long-labelled leaves", () => {
    const layout = computeLayout(tree("decisiontree"));
    expect(overlaps(boxOf(layout, "leafA"), boxOf(layout, "leafB"))).toBe(false);
  });

  it("still centres the parent between its children", () => {
    const layout = computeLayout(tree("decisiontree"));
    const a = boxOf(layout, "leafA");
    const b = boxOf(layout, "leafB");
    const root = boxOf(layout, "root");
    const childSpanCentre = (a.x + a.w / 2 + (b.x + b.w / 2)) / 2;
    expect(root.x + root.w / 2).toBeCloseTo(childSpanCentre, 0);
  });

  it("applies the same sizing to an org chart", () => {
    const layout = computeLayout(tree("orgchart"));
    expect(boxOf(layout, "leafA").w).toBe(measureNode(LONG, DEFAULT).width);
    expect(overlaps(boxOf(layout, "leafA"), boxOf(layout, "leafB"))).toBe(false);
  });

  it("places a detached long-labelled node without overlapping the tree", () => {
    const ws = applyOperations(tree("decisiontree"), [
      { op: "CREATE_NODE", id: "orphan", nodeType: "step", label: LONG },
    ]);
    const layout = computeLayout(ws);
    const orphan = boxOf(layout, "orphan");
    for (const id of ["root", "leafA", "leafB"]) {
      expect(overlaps(orphan, boxOf(layout, id)), `orphan overlaps ${id}`).toBe(false);
    }
  });
});

describe("swimlane layout (process maps) uses measured sizes", () => {
  function process(): Workspace {
    return applyOperations(createWorkspace({ diagramKind: "process" }), [
      { op: "CREATE_GROUP", id: "sales", label: "Sales", children: [] },
      { op: "CREATE_GROUP", id: "ops", label: "Ops", children: [] },
      { op: "CREATE_NODE", id: "wide", nodeType: "step", label: LONG, groupId: "sales" },
      { op: "CREATE_NODE", id: "next", nodeType: "step", label: SHORT, groupId: "sales" },
      { op: "CREATE_NODE", id: "handoff", nodeType: "step", label: LONG, groupId: "ops" },
      { op: "CONNECT_NODES", source: "wide", target: "next", relationship: "then" },
      { op: "CONNECT_NODES", source: "next", target: "handoff", relationship: "then" },
    ]);
  }

  it("gives a long-labelled step the measured width", () => {
    const layout = computeLayout(process());
    expect(boxOf(layout, "wide").w).toBe(measureNode(LONG, DEFAULT).width);
  });

  it("advances the next column past the widest node in the previous one", () => {
    const layout = computeLayout(process());
    const wide = boxOf(layout, "wide");
    const next = boxOf(layout, "next");
    // "next" is at flow depth 1, so its column must start beyond "wide".
    expect(next.x).toBeGreaterThanOrEqual(wide.x + wide.w);
  });

  it("does not overlap nodes in different lanes at the same depth", () => {
    const ws = applyOperations(createWorkspace({ diagramKind: "process" }), [
      { op: "CREATE_GROUP", id: "a", label: "A", children: [] },
      { op: "CREATE_GROUP", id: "b", label: "B", children: [] },
      { op: "CREATE_NODE", id: "n1", nodeType: "step", label: LONG, groupId: "a" },
      { op: "CREATE_NODE", id: "n2", nodeType: "step", label: LONG, groupId: "b" },
    ]);
    const layout = computeLayout(ws);
    expect(overlaps(boxOf(layout, "n1"), boxOf(layout, "n2"))).toBe(false);
  });

  it("does not overlap two long nodes sharing one lane and depth", () => {
    const ws = applyOperations(createWorkspace({ diagramKind: "process" }), [
      { op: "CREATE_GROUP", id: "a", label: "A", children: [] },
      { op: "CREATE_NODE", id: "n1", nodeType: "step", label: LONG, groupId: "a" },
      { op: "CREATE_NODE", id: "n2", nodeType: "step", label: LONG, groupId: "a" },
    ]);
    const layout = computeLayout(ws);
    expect(overlaps(boxOf(layout, "n1"), boxOf(layout, "n2"))).toBe(false);
  });
});

describe("layered layout still measures (regression guard)", () => {
  it("gives a long-labelled flowchart node the measured width", () => {
    const ws = applyOperations(createWorkspace({ diagramKind: "flowchart" }), [
      { op: "CREATE_NODE", id: "a", nodeType: "step", label: LONG },
      { op: "CREATE_NODE", id: "b", nodeType: "step", label: LONG },
      { op: "CONNECT_NODES", source: "a", target: "b", relationship: "next" },
    ]);
    const layout = computeLayout(ws);
    expect(boxOf(layout, "a").w).toBe(measureNode(LONG, DEFAULT).width);
    expect(overlaps(boxOf(layout, "a"), boxOf(layout, "b"))).toBe(false);
  });
});
