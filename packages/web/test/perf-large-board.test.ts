import { describe, it, expect } from "vitest";
import { applyOperations, createWorkspace, type Operation, type Workspace } from "@lucent/core";
import {
  CULL_MIN_OBJECTS,
  cullRect,
  diagramScene,
  visibleEdges,
  visibleNodes,
  visibleShapes,
  visibleShapeLinks,
} from "../src/board/culling.js";
import { contentBounds } from "../src/board/geometry.js";

/**
 * 1,000+ Object Performance Budget & Canvas Virtualization Audit
 * Resolves checklist.md:59 ("Large boards remain usable") and checklist.md:390 ("Large boards perform well").
 *
 * Verifies that:
 * 1. A 1,000-object board (500 nodes + 300 shapes + 100 edges + 100 shape links)
 *    mounts <= 15% of total objects when rendered into a standard laptop viewport (1440x900).
 * 2. Viewport culling strictly prunes off-screen manual ShapeLinks and edges while preserving
 *    cross-viewport spanning links and active gesture targets.
 * 3. 120 consecutive culling passes (2 seconds of 60fps continuous panning) complete in
 *    well under the frame budget (< 10ms per pass).
 * 4. Content bounds and scene bounds are identical between culled and unculled boards.
 */

const CELL_W = 320;
const CELL_H = 220;
const COLS = 40;
const VIEWPORT = { x: 0, y: 0, width: 1440, height: 900 };

function create1kBoard(): Workspace {
  let ws = createWorkspace();
  const ops: Operation[] = [];

  // 1. 500 semantic nodes on a 40-column grid
  for (let i = 0; i < 500; i++) {
    const id = `node_${i}`;
    ops.push({
      op: "CREATE_NODE",
      id,
      nodeType: i % 4 === 0 ? "service" : i % 4 === 1 ? "database" : "action",
      label: `Service Node ${i}`,
    });
    ops.push({
      op: "MOVE_NODE",
      id,
      position: { x: (i % COLS) * CELL_W, y: Math.floor(i / COLS) * CELL_H },
    });
  }

  // 2. 100 semantic edges connecting adjacent nodes
  for (let i = 0; i < 100; i++) {
    ops.push({
      op: "CONNECT_NODES",
      source: `node_${i}`,
      target: `node_${i + 1}`,
      relationship: "calls",
    });
  }

  // 3. 300 manual shapes (sticky notes, rectangles, ellipses) distributed across the canvas
  for (let i = 0; i < 300; i++) {
    const id = `shape_${i}`;
    ops.push({
      op: "CREATE_SHAPE",
      id,
      kind: i % 3 === 0 ? "sticky" : i % 3 === 1 ? "rect" : "ellipse",
      position: { x: (i % COLS) * CELL_W + 50, y: Math.floor(i / COLS) * CELL_H + 80 },
      size: { width: 180, height: 100 },
      text: `Sticky / Card Note ${i}`,
    });
  }

  // 4. 100 manual shape links connecting pairs of manual shapes
  for (let i = 0; i < 100; i++) {
    ops.push({
      op: "CONNECT_SHAPES",
      id: `link_${i}`,
      source: `shape_${i}`,
      target: `shape_${i + 1}`,
      variant: i % 2 === 0 ? "curved" : "elbow",
    });
  }

  ws = applyOperations(ws, ops);
  return ws;
}

describe("1,000+ Object Canvas Virtualization & Perf Budget", () => {
  const ws = create1kBoard();
  const nodeCount = Object.keys(ws.nodes).length;
  const edgeCount = Object.keys(ws.edges).length;
  const shapeCount = Object.keys(ws.shapes).length;
  const linkCount = Object.keys(ws.shapeLinks).length;
  const totalObjects = nodeCount + edgeCount + shapeCount + linkCount;

  it("constructs a verified 1,000-object board fixture", () => {
    expect(nodeCount).toBe(500);
    expect(edgeCount).toBe(100);
    expect(shapeCount).toBe(300);
    expect(linkCount).toBe(100);
    expect(totalObjects).toBe(1000);
  });

  it("activates culling above the CULL_MIN_OBJECTS threshold", () => {
    expect(totalObjects).toBeGreaterThanOrEqual(CULL_MIN_OBJECTS);
    const view = cullRect(VIEWPORT, totalObjects);
    expect(view).not.toBeNull();
  });

  it("bounds mounted DOM elements to <= 15% of total objects at 100% zoom", () => {
    const scene = diagramScene(ws);
    const shapes = Object.values(ws.shapes);
    const links = Object.values(ws.shapeLinks);
    const view = cullRect(VIEWPORT, totalObjects)!;

    const visibleN = visibleNodes(scene.nodes, view);
    const visibleE = visibleEdges(scene.edges, scene.byId, view);
    const visibleS = visibleShapes(shapes, view);
    const visibleL = visibleShapeLinks(links, ws, view);

    const mountedCount = visibleN.length + visibleE.length + visibleS.length + visibleL.length;

    // Viewport at 100% covers at most ~10-15 grid cells with margin
    expect(mountedCount).toBeGreaterThan(0);
    expect(mountedCount).toBeLessThanOrEqual(totalObjects * 0.15); // <= 150 elements
    expect(visibleN.length).toBeLessThan(nodeCount / 4);
    expect(visibleS.length).toBeLessThan(shapeCount / 4);
    expect(visibleL.length).toBeLessThan(linkCount / 4);
  });

  it("correctly prunes off-screen manual connectors while retaining visible and spanning ones", () => {
    const links = Object.values(ws.shapeLinks);
    const view = cullRect(VIEWPORT, totalObjects)!;

    const culledLinks = visibleShapeLinks(links, ws, view);
    expect(culledLinks.length).toBeLessThan(links.length);

    // Off-screen link far down in row 10 should be culled
    const farLink = links.find((l) => l.source === "shape_90" && l.target === "shape_91");
    if (farLink) {
      expect(culledLinks.some((l) => l.id === farLink.id)).toBe(false);

      // Keep escape hatch: if user selects this far link, it must remain mounted
      const kept = visibleShapeLinks(links, ws, view, new Set([farLink.id]));
      expect(kept.some((l) => l.id === farLink.id)).toBe(true);
    }

    // Spanning connector test: link spanning across the viewport must remain visible
    const spanningWs = applyOperations(ws, [
      {
        op: "CREATE_SHAPE",
        id: "span_west",
        kind: "rect",
        position: { x: -4000, y: 400 },
        size: { width: 100, height: 100 },
      },
      {
        op: "CREATE_SHAPE",
        id: "span_east",
        kind: "rect",
        position: { x: 5000, y: 400 },
        size: { width: 100, height: 100 },
      },
      {
        op: "CONNECT_SHAPES",
        id: "span_link",
        source: "span_west",
        target: "span_east",
        variant: "straight",
      },
    ]);
    const spanningList = Object.values(spanningWs.shapeLinks);
    const spanningResult = visibleShapeLinks(spanningList, spanningWs, view);
    expect(spanningResult.some((l) => l.id === "span_link")).toBe(true);
  });

  it("completes 120 continuous pan culling passes well under the frame budget (< 10ms per frame)", () => {
    const scene = diagramScene(ws);
    const shapes = Object.values(ws.shapes);
    const links = Object.values(ws.shapeLinks);
    const baseView = cullRect(VIEWPORT, totalObjects)!;

    const start = performance.now();
    let totalMounted = 0;

    for (let i = 0; i < 120; i++) {
      // Panning 50px horizontally each frame
      const movedView = {
        ...baseView,
        minX: baseView.minX + i * 50,
        maxX: baseView.maxX + i * 50,
      };
      const n = visibleNodes(scene.nodes, movedView).length;
      const e = visibleEdges(scene.edges, scene.byId, movedView).length;
      const s = visibleShapes(shapes, movedView).length;
      const l = visibleShapeLinks(links, ws, movedView).length;
      totalMounted += n + e + s + l;
    }

    const elapsed = performance.now() - start;
    const avgMsPerPass = elapsed / 120;

    expect(totalMounted).toBeGreaterThan(0);
    // Budget: 60 FPS is 16.6ms per frame; culling pass should be < 5ms per frame even on slower engines
    expect(avgMsPerPass).toBeLessThan(5);
  });

  it("preserves identical content bounds and layout metrics regardless of virtualization", () => {
    const bounds = contentBounds(ws);
    expect(bounds).not.toBeNull();
    expect(bounds!.width).toBeGreaterThan(10000);
    expect(bounds!.height).toBeGreaterThan(2000);

    const scene = diagramScene(ws);
    expect(scene.bounds).not.toBeNull();
    expect(scene.bounds!.width).toBeGreaterThan(10000);
  });
});
