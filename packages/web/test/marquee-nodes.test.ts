import { describe, it, expect } from "vitest";
import type { Node, Shape } from "@lucent/core";

/**
 * Marquee hit-testing used to consider shapes only, so a drag across a generated
 * diagram selected nothing and there was no way to move several nodes together.
 * This mirrors the intersection logic in MarqueeLayer so the geometry is guarded
 * without a DOM.
 */
function hitTest(
  box: { minX: number; minY: number; maxX: number; maxY: number },
  shapes: Shape[],
  nodes: Node[],
) {
  const hitShapes = new Set<string>();
  for (const s of shapes) {
    const sr = s.position.x + s.size.width;
    const sb = s.position.y + s.size.height;
    if (s.position.x < box.maxX && sr > box.minX && s.position.y < box.maxY && sb > box.minY) {
      hitShapes.add(s.id);
    }
  }
  const hitNodes = new Set<string>();
  for (const n of nodes) {
    if (!n.position) continue;
    const nr = n.position.x + (n.size?.width ?? 160);
    const nb = n.position.y + (n.size?.height ?? 64);
    if (n.position.x < box.maxX && nr > box.minX && n.position.y < box.maxY && nb > box.minY) {
      hitNodes.add(n.id);
    }
  }
  return { shapes: hitShapes, nodes: hitNodes };
}

const node = (id: string, x: number, y: number): Node => ({
  id,
  nodeType: "service",
  label: id,
  position: { x, y },
  size: { width: 160, height: 64 },
});

const shape = (id: string, x: number, y: number): Shape => ({
  id,
  kind: "rect",
  position: { x, y },
  size: { width: 100, height: 60 },
});

describe("marquee selection", () => {
  it("selects every node whose box intersects the marquee", () => {
    const nodes = [node("a", 0, 0), node("b", 200, 0), node("c", 900, 900)];
    const hit = hitTest({ minX: -10, minY: -10, maxX: 400, maxY: 200 }, [], nodes);
    expect([...hit.nodes].sort()).toEqual(["a", "b"]);
  });

  it("selects nodes and shapes together", () => {
    const hit = hitTest(
      { minX: 0, minY: 0, maxX: 500, maxY: 500 },
      [shape("s1", 300, 300)],
      [node("n1", 10, 10)],
    );
    expect([...hit.nodes]).toEqual(["n1"]);
    expect([...hit.shapes]).toEqual(["s1"]);
  });

  it("ignores nodes fully outside the marquee", () => {
    const hit = hitTest({ minX: 0, minY: 0, maxX: 50, maxY: 50 }, [], [node("far", 500, 500)]);
    expect(hit.nodes.size).toBe(0);
  });

  it("counts a partial overlap as a hit", () => {
    // Node spans 100..260; marquee ends at 150 — overlapping, so selected.
    const hit = hitTest({ minX: 0, minY: 0, maxX: 150, maxY: 150 }, [], [node("edge", 100, 100)]);
    expect([...hit.nodes]).toEqual(["edge"]);
  });

  it("skips nodes with no position (never laid out)", () => {
    const orphan: Node = { id: "orphan", nodeType: "note", label: "orphan" };
    const hit = hitTest({ minX: -1e6, minY: -1e6, maxX: 1e6, maxY: 1e6 }, [], [orphan]);
    expect(hit.nodes.size).toBe(0);
  });

  it("falls back to default node size when size is absent", () => {
    const sized: Node = { id: "d", nodeType: "note", label: "d", position: { x: 0, y: 0 } };
    // Default 160x64 means x=100 is inside the box.
    const hit = hitTest({ minX: 100, minY: 10, maxX: 120, maxY: 20 }, [], [sized]);
    expect([...hit.nodes]).toEqual(["d"]);
  });
});
