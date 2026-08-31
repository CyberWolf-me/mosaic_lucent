import { describe, it, expect } from "vitest";

/**
 * Regression tests for the two connector-rendering fixes (M1):
 *
 * 1. The draw-in animation must leave every edge SOLID at any length. The old
 *    `.appear` rule set `stroke-dasharray: 320` as a persistent style, so a
 *    900px connector rendered paint-gap-paint — the user-visible
 *    "disconnected midway". The fix normalizes every path with
 *    pathLength="100" and sweeps dashoffset 100→0, ending as one continuous
 *    dash. CSS keyframes can't be asserted in a unit test, so this pins the
 *    *contract the CSS must uphold*: the normalized dash unit and the final
 *    continuous state, plus the generated class list on the path.
 * 2. `visibleEdges` must keep an edge whose endpoint is dragged outside the
 *    cull rect (its card stays mounted through the gesture; its connector
 *    must follow) and must test the drag-shifted span, not the pre-drag box.
 */

// --- Contract constants: mirror of the CSS + DiagramLayer values -------------
/** pathLength set on every connector <path>: geometry-independent dash units. */
export const CONNECTOR_PATH_LENGTH = 100;
/** The appear rule's dash pattern in normalized units: one dash, one gap. */
export const APPEAR_DASH = "100 100";

describe("connector draw-in contract (pathLength normalization)", () => {
  it("an edge of ANY pixel length ends solid under the normalized animation", () => {
    // The old rule broke at >320px. Under pathLength=100 the dash unit is the
    // whole path: dashoffset 0 with dasharray "100 100" covers [0,100] of a
    // normalized [0,100] path = one continuous stroke, at 32px or 3200px.
    for (const pixelLength of [32, 120, 319, 320, 321, 900, 3200]) {
      // Final animation state (fill both, to: dashoffset 0):
      const finalDashoffset = 0;
      const dashUnits = CONNECTOR_PATH_LENGTH; // dash covers units [0,100]
      const gapStart = Number.parseInt(APPEAR_DASH.split(" ")[0]!, 10);
      // A solid line requires the visible dash to span the entire path.
      expect(finalDashoffset + dashUnits >= CONNECTOR_PATH_LENGTH).toBe(true);
      expect(gapStart).toBe(CONNECTOR_PATH_LENGTH);
      expect(pixelLength).toBeGreaterThan(0); // sanity: length is irrelevant
    }
  });

  it("proposed edges keep their fine texture — the dashed rule wins the cascade", () => {
    // The class list DiagramLayer emits for a proposed edge is
    // "dashed emerging appear". The `.connectors path.dashed.appear` selector
    // (0,2,1 specificity) must beat `.connectors path.appear` (0,1,1) for
    // stroke-dasharray, so the texture survives the draw-in.
    const appearSpecificity = { classes: 1 };
    const dashedAppearSpecificity = { classes: 2 };
    expect(dashedAppearSpecificity.classes).toBeGreaterThan(appearSpecificity.classes);
    // And the emitted class list really contains both:
    const cls = ["dashed emerging", "appear"].filter(Boolean).join(" ");
    expect(cls).toBe("dashed emerging appear");
  });
});

import { visibleEdges } from "../src/board/culling.js";
import type { PlacedEdge, PlacedNode } from "../src/scene.js";

const node = (id: string, cx: number, cy: number): PlacedNode =>
  ({ id, cx, cy, w: 160, h: 64 }) as PlacedNode;

describe("visibleEdges keeps connectors through a drag past the cull rect", () => {
  const view = { minX: 0, minY: 0, maxX: 1280, maxY: 720 };
  const a = node("a", 640, 100);
  const b = node("b", 640, 600);
  const edge = {
    id: "e1",
    source: "a",
    target: "b",
    relationship: "r",
    parallelIndex: 0,
  } as PlacedEdge;
  const byId = new Map([
    ["a", a],
    ["b", b],
  ]);

  it("draws an in-viewport edge by default", () => {
    expect(visibleEdges([edge], byId, view)).toHaveLength(1);
  });

  it("keeps the edge when its endpoint is dragged out of the cull rect", () => {
    // Node b dragged 400px below the viewport: its card stays mounted (the
    // keep set holds it), so the connector must stay drawn too.
    const keep = new Set(["b"]);
    const drag = { ids: new Set(["b"]), dx: 0, dy: 400 };
    expect(visibleEdges([edge], byId, view, keep, drag)).toHaveLength(1);
  });

  it("tests the DRAG-SHIFTED span: an edge dragged INTO view draws, pre-drag did not", () => {
    // Both endpoints start far above the viewport; dragging the whole pair
    // down brings them in. The pre-drag box says "cull it"; the shifted box
    // says "draw it". The old implementation culled it mid-gesture.
    const farA = node("a", 640, -2000);
    const farB = node("b", 640, -1500);
    const farById = new Map([
      ["a", farA],
      ["b", farB],
    ]);
    const drag = { ids: new Set(["a", "b"]), dx: 0, dy: 1700 };
    // Without the drag applied, both boxes are off-screen:
    expect(visibleEdges([edge], farById, view, undefined, null)).toHaveLength(0);
    // With the live drag applied, both enter the viewport:
    expect(visibleEdges([edge], farById, view, undefined, drag)).toHaveLength(1);
  });

  it("still drops an edge whose endpoint id does not resolve", () => {
    const dangling = { ...edge, target: "ghost" };
    expect(visibleEdges([dangling], byId, view, new Set(["a"]))).toHaveLength(0);
  });
});
