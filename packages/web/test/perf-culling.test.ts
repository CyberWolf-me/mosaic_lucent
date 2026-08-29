import { describe, it, expect } from "vitest";
import { applyOperations, createWorkspace, type Operation } from "@lucent/core";
import {
  CULL_MARGIN,
  CULL_MIN_OBJECTS,
  boundsWithDrag,
  cullRect,
  diagramScene,
  groupRegions,
  nodeBounds,
  overlaps,
  visibleEdges,
  visibleGroups,
  visibleNodes,
  visibleShapes,
} from "../src/board/culling.js";
import type { PlacedNode } from "../src/scene.js";
import { marqueeHits } from "../src/board/geometry.js";

/**
 * Perf budget for the large-board render path (M3). The canvas used to mount
 * every node, edge and shape on every frame; this suite pins the two properties
 * that make culling safe to keep:
 *
 *  1. it engages above the threshold and bounds the mounted element count by the
 *     viewport rather than by the board size, and
 *  2. it changes *only* what is mounted — bounds, group boxes, connector anchors
 *     and marquee hit-testing still see the whole workspace.
 *
 * The assertions are counts and algorithmic identities, not wall-clock times,
 * so a slow or noisy CI box cannot flake them. The one timing assertion at the
 * end is deliberately ~two orders of magnitude above what the work costs, and
 * says so.
 */

const CELL_W = 320;
const CELL_H = 220;
const COLS = 40;
/** The viewport the fixtures are culled against: a laptop canvas at 100%. */
const VIEW = { x: 0, y: 0, width: 1440, height: 900 };

/** `count` nodes on a wide grid, each wired to its right-hand neighbour. */
function gridBoard(count: number, opts: { groupRows?: boolean } = {}) {
  const ops: Operation[] = [];
  for (let i = 0; i < count; i++) {
    const id = `n${i}`;
    ops.push({ op: "CREATE_NODE", id, nodeType: "service", label: `Service ${i}` });
    ops.push({
      op: "MOVE_NODE",
      id,
      position: { x: (i % COLS) * CELL_W, y: Math.floor(i / COLS) * CELL_H },
    });
  }
  for (let i = 0; i + 1 < count; i++) {
    // Skip the row wrap so no edge spans the whole board by accident; the
    // long-edge case is exercised explicitly below.
    if ((i + 1) % COLS === 0) continue;
    ops.push({ op: "CONNECT_NODES", source: `n${i}`, target: `n${i + 1}`, relationship: "calls" });
  }
  if (opts.groupRows) {
    for (let r = 0; r * COLS < count; r++) {
      const children: string[] = [];
      for (let c = 0; c < COLS && r * COLS + c < count; c++) children.push(`n${r * COLS + c}`);
      ops.push({ op: "CREATE_GROUP", id: `g${r}`, label: `Row ${r}`, children });
    }
  }
  return applyOperations(createWorkspace(), ops);
}

/** ~1000 objects: half semantic nodes, half manual shapes, same grid. */
function mixedBoard(nodes: number, shapes: number) {
  let ws = gridBoard(nodes);
  const ops: Operation[] = [];
  for (let i = 0; i < shapes; i++) {
    ops.push({
      op: "CREATE_SHAPE",
      id: `s${i}`,
      kind: i % 3 === 0 ? "sticky" : i % 3 === 1 ? "rect" : "ellipse",
      position: { x: (i % COLS) * CELL_W + 40, y: Math.floor(i / COLS) * CELL_H + 90 },
      size: { width: 180, height: 100 },
    });
  }
  ws = applyOperations(ws, ops);
  return ws;
}

/** Independent restatement of the overlap test, so the filter is checked
 *  against the rule rather than against itself. */
const boxVisible = (
  r: { minX: number; minY: number; maxX: number; maxY: number },
  x: number,
  y: number,
  w: number,
  h: number,
) => x < r.maxX && x + w > r.minX && y < r.maxY && y + h > r.minY;

describe("cull threshold", () => {
  it("does no work at all below the object threshold", () => {
    const ws = gridBoard(120);
    const scene = diagramScene(ws);
    const view = cullRect(VIEW, scene.nodes.length + scene.edges.length);
    expect(view).toBeNull();
    // Reference identity, not just equal length: below the threshold the arrays
    // are handed straight through, so there is no scan and no allocation.
    expect(visibleNodes(scene.nodes, view)).toBe(scene.nodes);
    expect(visibleEdges(scene.edges, scene.byId, view)).toBe(scene.edges);
    expect(visibleGroups(scene.groups, view)).toBe(scene.groups);
    const shapes = Object.values(ws.shapes);
    expect(visibleShapes(shapes, view)).toBe(shapes);
  });

  it("declines to cull when the camera is unknown or degenerate", () => {
    expect(cullRect(null, 5000)).toBeNull();
    expect(cullRect(undefined, 5000)).toBeNull();
    expect(cullRect({ x: 0, y: 0, width: 0, height: 900 }, 5000)).toBeNull();
    expect(cullRect({ x: 0, y: 0, width: 1440, height: 0 }, 5000)).toBeNull();
  });

  it("engages exactly at the documented threshold", () => {
    expect(cullRect(VIEW, CULL_MIN_OBJECTS - 1)).toBeNull();
    expect(cullRect(VIEW, CULL_MIN_OBJECTS)).not.toBeNull();
  });

  it("keeps a margin of half a viewport on every side", () => {
    const r = cullRect(VIEW, 5000)!;
    expect(r.minX).toBe(VIEW.x - VIEW.width * CULL_MARGIN);
    expect(r.maxY).toBe(VIEW.y + VIEW.height + VIEW.height * CULL_MARGIN);
  });
});

describe("a >500-node board mounts a viewport's worth of elements", () => {
  const ws = gridBoard(600, { groupRows: true });
  const scene = diagramScene(ws);
  const view = cullRect(VIEW, scene.nodes.length + scene.edges.length)!;

  it("has the fixture it claims to have", () => {
    expect(scene.nodes.length).toBe(600);
    expect(scene.edges.length).toBeGreaterThan(500);
    expect(view).not.toBeNull();
  });

  it("draws a small fraction of the nodes, and exactly the right ones", () => {
    const drawn = visibleNodes(scene.nodes, view);
    const expected = scene.nodes.filter((n) =>
      boxVisible(view, n.cx - n.w / 2, n.cy - n.h / 2, n.w, n.h),
    );
    expect(drawn.map((n) => n.id)).toEqual(expected.map((n) => n.id));
    // The bound that matters: mounted elements scale with the *camera*, not the
    // board. The cull rect is 2x2 viewports = 2880x1800, and a grid cell is
    // 320x220, so no camera position can see more than ~10x10 cards.
    expect(drawn.length).toBeLessThanOrEqual(100);
    expect(drawn.length).toBeGreaterThan(0);
    expect(drawn.length).toBeLessThan(scene.nodes.length / 4);
  });

  it("preserves z-order among the survivors", () => {
    const drawn = visibleNodes(scene.nodes, view).map((n) => n.id);
    const order = scene.nodes.map((n) => n.id);
    // Filtering must not reorder: later siblings still paint over earlier ones.
    expect(drawn).toEqual(order.filter((id) => drawn.includes(id)));
  });

  it("still draws each visible node's connectors", () => {
    const drawn = new Set(visibleNodes(scene.nodes, view).map((n) => n.id));
    const drawnEdges = visibleEdges(scene.edges, scene.byId, view);
    // Every edge touching a mounted card is mounted too, so no card is left
    // with a connector stub hanging off it.
    for (const e of scene.edges) {
      if (drawn.has(e.source) || drawn.has(e.target)) {
        expect(drawnEdges.some((d) => d.id === e.id)).toBe(true);
      }
    }
    expect(drawnEdges.length).toBeLessThan(scene.edges.length / 4);
  });

  it("mounts a selected node that is far off-camera", () => {
    const far = scene.nodes[scene.nodes.length - 1]!;
    expect(visibleNodes(scene.nodes, view).some((n) => n.id === far.id)).toBe(false);
    const keep = new Set([far.id]);
    expect(visibleNodes(scene.nodes, view, keep).some((n) => n.id === far.id)).toBe(true);
  });
});

describe("culling is render-only: geometry still sees the whole board", () => {
  const ws = gridBoard(600, { groupRows: true });
  const scene = diagramScene(ws);
  const view = cullRect(VIEW, scene.nodes.length + scene.edges.length)!;

  it("draws an edge whose endpoints are both off-screen but which crosses it", () => {
    const crossing = applyOperations(ws, [
      { op: "CREATE_NODE", id: "west", nodeType: "service", label: "West" },
      { op: "MOVE_NODE", id: "west", position: { x: -6000, y: 400 } },
      { op: "CREATE_NODE", id: "east", nodeType: "service", label: "East" },
      { op: "MOVE_NODE", id: "east", position: { x: 9000, y: 400 } },
      { op: "CONNECT_NODES", source: "west", target: "east", relationship: "calls" },
      { op: "CREATE_NODE", id: "far", nodeType: "service", label: "Far" },
      { op: "MOVE_NODE", id: "far", position: { x: -9000, y: -9000 } },
      { op: "CONNECT_NODES", source: "far", target: "west", relationship: "calls" },
    ]);
    const s2 = diagramScene(crossing);
    const v2 = cullRect(VIEW, s2.nodes.length + s2.edges.length)!;
    const shown = new Set(visibleNodes(s2.nodes, v2).map((n) => n.id));
    expect(shown.has("west")).toBe(false);
    expect(shown.has("east")).toBe(false);
    const drawnEdges = visibleEdges(s2.edges, s2.byId, v2);
    const spanning = s2.edges.find((e) => e.source === "west" && e.target === "east")!;
    expect(drawnEdges.some((e) => e.id === spanning.id)).toBe(true);
    // ...while an edge entirely outside the region is still dropped.
    const outside = s2.edges.find((e) => e.source === "far" && e.target === "west")!;
    expect(drawnEdges.some((e) => e.id === outside.id)).toBe(false);
  });

  it("measures the frame over every node, not the visible ones", () => {
    const all = nodeBounds(scene.nodes)!;
    const visible = nodeBounds(visibleNodes(scene.nodes, view))!;
    expect(all.width).toBeGreaterThan(visible.width * 3);
    // The render path passes scene.bounds (whole board) to the frame, so the
    // frame does not shrink as the camera moves.
    expect(scene.bounds).toEqual(all);
  });

  it("measures group boxes over all members even when most are culled", () => {
    const row0 = scene.groups.find((g) => g.id === "g0")!;
    // Row 0 spans 40 cards; only the leftmost few are on camera.
    expect(row0.width).toBeGreaterThan(COLS * CELL_W - CELL_W);
    expect(visibleGroups(scene.groups, view).some((g) => g.id === "g0")).toBe(true);
    // Recomputing during a drag must go through the same all-members scan.
    const dragged = groupRegions(ws, (id) => scene.byId.get(id));
    expect(dragged.find((g) => g.id === "g0")!.width).toBe(row0.width);
  });

  it("resolves connector anchors for culled nodes", () => {
    // byId is the whole board: an edge kept because it crosses the viewport can
    // only be routed if its off-screen endpoints are still resolvable.
    expect(scene.byId.size).toBe(scene.nodes.length);
    const last = scene.nodes[scene.nodes.length - 1]!;
    expect(scene.byId.get(last.id)).toBe(last);
  });
});

describe("a ~1000-object mixed board", () => {
  const ws = mixedBoard(500, 500);
  const scene = diagramScene(ws);
  const shapes = Object.values(ws.shapes);
  const objectCount = scene.nodes.length + shapes.length;
  const view = cullRect(VIEW, objectCount)!;

  it("has the fixture it claims to have", () => {
    expect(objectCount).toBe(1000);
    expect(view).not.toBeNull();
  });

  it("mounts a viewport's worth of shapes, and exactly the right ones", () => {
    const drawn = visibleShapes(shapes, view);
    const expected = shapes.filter((s) =>
      boxVisible(view, s.position.x, s.position.y, s.size.width, s.size.height),
    );
    expect(drawn.map((s) => s.id)).toEqual(expected.map((s) => s.id));
    expect(drawn.length).toBeLessThan(shapes.length / 4);
    expect(drawn.length).toBeGreaterThan(0);
  });

  it("keeps the shape under an active gesture mounted", () => {
    const far = shapes[shapes.length - 1]!;
    expect(visibleShapes(shapes, view).some((s) => s.id === far.id)).toBe(false);
    expect(visibleShapes(shapes, view, new Set([far.id])).some((s) => s.id === far.id)).toBe(true);
  });

  it("marquee hit-testing still reaches shapes the renderer culled", () => {
    const far = shapes[shapes.length - 1]!;
    const box = {
      x0: far.position.x - 10,
      y0: far.position.y - 10,
      x1: far.position.x + far.size.width + 10,
      y1: far.position.y + far.size.height + 10,
    };
    // The render list would have dropped it; MarqueeLayer is deliberately given
    // the whole `shapes` array, so a marquee out there still selects it.
    expect(marqueeHits(box, visibleShapes(shapes, view)).has(far.id)).toBe(false);
    expect(marqueeHits(box, shapes).has(far.id)).toBe(true);
  });

  it("grows the frame for a drag without rescanning the board", () => {
    const dragged = scene.nodes[0]!;
    const drag = { ids: new Set([dragged.id]), dx: -4000, dy: 0 };
    const grown = boundsWithDrag(scene.bounds, scene.byId, drag)!;
    expect(grown.x).toBe(dragged.cx - dragged.w / 2 - 4000);
    expect(grown.width).toBeGreaterThan(scene.bounds!.width);
    // No drag: the memoised bounds are returned untouched, not recomputed.
    expect(boundsWithDrag(scene.bounds, scene.byId, null)).toBe(scene.bounds);
    expect(boundsWithDrag(scene.bounds, scene.byId, { ids: new Set(), dx: 5, dy: 5 })).toBe(
      scene.bounds,
    );
  });
});

describe("the cull pass itself is not the bottleneck", () => {
  it("survives a board far larger than the argument limit", () => {
    // Guards the reason nodeBounds is a loop: `Math.min(...nodes.map(...))`
    // throws RangeError somewhere past ~100k arguments, so the old form failed
    // hardest on exactly the boards this work is for.
    const many: PlacedNode[] = [];
    for (let i = 0; i < 200_000; i++) {
      many.push({ id: `n${i}`, cx: i, cy: -i, w: 10, h: 10 } as unknown as PlacedNode);
    }
    const b = nodeBounds(many)!;
    expect(b.x).toBe(-5);
    expect(b.width).toBe(200_009);
  });

  it("culls a 1000-object board 120 times well inside a frame budget", () => {
    const ws = mixedBoard(500, 500);
    const scene = diagramScene(ws);
    const shapes = Object.values(ws.shapes);
    const view = cullRect(VIEW, scene.nodes.length + shapes.length)!;
    const started = performance.now();
    let mounted = 0;
    for (let i = 0; i < 120; i++) {
      // A pan: the camera moves, so every pass re-filters from scratch.
      const moved = { ...view, minX: view.minX + i * 40, maxX: view.maxX + i * 40 };
      mounted =
        visibleNodes(scene.nodes, moved).length +
        visibleEdges(scene.edges, scene.byId, moved).length +
        visibleGroups(scene.groups, moved).length +
        visibleShapes(shapes, moved).length;
    }
    const elapsed = performance.now() - started;
    expect(mounted).toBeGreaterThan(0);
    // 120 passes is two seconds of continuous 60fps panning. The work is four
    // linear scans of ~1500 objects: measured here at 0.1ms a pass, 12ms for all
    // 120 (and 1.6ms to derive the whole scene once). The 2s ceiling is over
    // 150x that, so no amount of CI noise or throttling can flake it, while a
    // regression that reintroduces per-frame layout, a full-board spread scan or
    // an O(n^2) pass would blow straight through it.
    expect(elapsed).toBeLessThan(2000);
  });

  it("overlaps() treats touching edges as not visible", () => {
    const r = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
    expect(overlaps(r, 100, 0, 10, 10)).toBe(false);
    expect(overlaps(r, -10, 0, 10, 10)).toBe(false);
    expect(overlaps(r, 99, 99, 10, 10)).toBe(true);
  });
});
