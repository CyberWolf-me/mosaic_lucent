import { describe, it, expect } from "vitest";
import { applyOperations, applyLayout, computeLayout, createWorkspace } from "../src/index.js";

/**
 * A mind map laid out top-down as layers misrepresents its structure: the whole
 * point is a centre with branches radiating out. `TRANSFORM_DIAGRAM to mindmap`
 * used to change only the frame caption because the layout engine never branched
 * on diagramKind.
 */

function mindMap() {
  return applyOperations(createWorkspace({ diagramKind: "mindmap" }), [
    { op: "CREATE_NODE", id: "core", nodeType: "idea", label: "Central idea" },
    { op: "CREATE_NODE", id: "a", nodeType: "idea", label: "A" },
    { op: "CREATE_NODE", id: "b", nodeType: "idea", label: "B" },
    { op: "CREATE_NODE", id: "c", nodeType: "idea", label: "C" },
    { op: "CREATE_NODE", id: "a1", nodeType: "idea", label: "A1" },
    { op: "CONNECT_NODES", source: "core", target: "a", relationship: "branch" },
    { op: "CONNECT_NODES", source: "core", target: "b", relationship: "branch" },
    { op: "CONNECT_NODES", source: "core", target: "c", relationship: "branch" },
    { op: "CONNECT_NODES", source: "a", target: "a1", relationship: "branch" },
  ]);
}

// Center distance reads the ACTUAL laid-out size — hardcoding the base 64px
// height broke when the layout began reserving the NodeCard's sub/chip rows
// (the center then sat 7.5px off per node, angle-dependent).
const dist = (
  box: { position: { x: number; y: number }; size: { width: number; height: number } } | undefined,
) =>
  box
    ? Math.hypot(box.position.x + box.size.width / 2, box.position.y + box.size.height / 2)
    : Number.NaN;

describe("radial layout for mind maps", () => {
  it("is selected automatically for a mindmap workspace", () => {
    const layout = computeLayout(mindMap());
    // The hub sits at the origin; a layered layout would place it at y=0 with
    // every child stacked directly below on one axis.
    expect(dist(layout.core)).toBeCloseTo(0, 5);
  });

  it("puts the most-connected node at the centre", () => {
    const layout = computeLayout(mindMap());
    const centre = dist(layout.core);
    for (const id of ["a", "b", "c", "a1"]) {
      expect(dist(layout[id]), id).toBeGreaterThan(centre);
    }
  });

  it("places first-ring branches on a common radius, spread apart", () => {
    const layout = computeLayout(mindMap());
    const ra = dist(layout.a);
    const rb = dist(layout.b);
    const rc = dist(layout.c);
    // "Common radius" modulo integer position rounding (half-pixel sizes make
    // the rounded centers wobble by up to ~1px — 0.92 observed after the
    // sub-row reservation added odd heights).
    expect(Math.abs(rb - ra)).toBeLessThan(1.5);
    expect(Math.abs(rc - ra)).toBeLessThan(1.5);
    // Distinct positions, not stacked on top of each other.
    const set = new Set([
      JSON.stringify(layout.a?.position),
      JSON.stringify(layout.b?.position),
      JSON.stringify(layout.c?.position),
    ]);
    expect(set.size).toBe(3);
  });

  it("puts a deeper node on an outer ring", () => {
    const layout = computeLayout(mindMap());
    expect(dist(layout.a1)).toBeGreaterThan(dist(layout.a));
  });

  it("is deterministic", () => {
    const a = computeLayout(mindMap());
    const b = computeLayout(mindMap());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("still uses layered layout for a flowchart", () => {
    const ws = applyOperations(createWorkspace({ diagramKind: "flowchart" }), [
      { op: "CREATE_NODE", id: "x", nodeType: "step", label: "X" },
      { op: "CREATE_NODE", id: "y", nodeType: "step", label: "Y" },
      { op: "CONNECT_NODES", source: "x", target: "y", relationship: "next" },
    ]);
    const layout = computeLayout(ws);
    // Layered vertical: same x, increasing y.
    expect(layout.x?.position.x).toBe(layout.y?.position.x);
    expect(layout.y?.position.y).toBeGreaterThan(layout.x!.position.y);
  });

  it("honours an explicit strategy override", () => {
    const layered = computeLayout(mindMap(), { strategy: "layered" });
    // Layered puts the root at y=0 rather than centred on the origin.
    expect(layered.core?.position.y).toBe(0);
  });

  it("places disconnected nodes instead of piling them at the origin", () => {
    const ws = applyOperations(mindMap(), [
      { op: "CREATE_NODE", id: "lonely", nodeType: "idea", label: "Lonely" },
    ]);
    const layout = computeLayout(ws);
    expect(dist(layout.lonely)).toBeGreaterThan(0);
  });

  it("keeps a pinned node where the user dragged it", () => {
    let ws = applyOperations(mindMap(), [
      { op: "MOVE_NODE", id: "b", position: { x: 900, y: -400 } },
    ]);
    ws = applyLayout(ws, computeLayout(ws));
    expect(ws.nodes.b?.position).toEqual({ x: 900, y: -400 });
  });
});
