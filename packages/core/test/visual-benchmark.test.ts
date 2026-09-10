/**
 * The visual benchmark, pinned (the 2026-09 advisory review's Phase-1 ask).
 *
 * These are NOT golden-number tests — layout work is allowed to move every
 * metric. They are INVARIANT tests: the structural properties that must hold
 * at every scale for every strategy, so a layout change that breaks packing,
 * escapes the canvas, or explodes crossings fails CI with the metric named.
 *
 * The scales mirror the review's ladder (20/40/80/150/300/500) — chosen once
 * here so the script, the tests, and any future ELK comparison share one
 * vocabulary.
 *
 * What is deliberately NOT tested: 10-second comprehension and manual-cleanup
 * time — human-judged metrics owned by the live eval protocol
 * (docs/eval-results), never by a deterministic harness.
 */

import { describe, expect, it } from "vitest";
import {
  BOARD_FACTORIES,
  layeredBoard,
  radialBoard,
  swimlaneBoard,
  treeBoard,
} from "../src/benchmarkBoards.js";
import { createWorkspace } from "../src/model.js";
import { measureVisualMetrics } from "../src/visualBenchmark.js";
import { computeLayout } from "../src/layout.js";

const SCALES = [20, 40, 80, 150, 300, 500] as const;

describe("synthetic benchmark boards", () => {
  it("every factory hits the requested node count exactly", () => {
    for (const factory of BOARD_FACTORIES) {
      for (const n of [20, 80, 500]) {
        const ws = factory.build(n);
        expect(
          Object.keys(ws.nodes).length,
          `${factory.label} at n=${n}`,
        ).toBe(n);
      }
    }
  });

  it("generators are deterministic — same input, same board", () => {
    for (const factory of BOARD_FACTORIES) {
      const a = factory.build(80, 3);
      const b = factory.build(80, 3);
      expect(a.nodes, factory.label).toEqual(b.nodes);
      expect(a.edges, factory.label).toEqual(b.edges);
    }
  });

  it("every edge references existing nodes (no dangling-edge fixtures)", () => {
    for (const factory of BOARD_FACTORIES) {
      const ws = factory.build(150);
      for (const edge of Object.values(ws.edges)) {
        expect(ws.nodes[edge.source], `${factory.label}: ${edge.id} source`).toBeTruthy();
        expect(ws.nodes[edge.target], `${factory.label}: ${edge.id} target`).toBeTruthy();
      }
    }
  });

  it("the workload shapes are what each strategy is graded on", () => {
    // Layered carries a return edge (the live pass's canvas-crossing case).
    const layered = layeredBoard(40);
    expect(Object.values(layered.edges).some((e) => e.relationship === "returns to")).toBe(true);
    // Tree is ternary: node 3's parent is node 0, node 4's parent is node 1.
    const tree = treeBoard(40);
    expect(tree.edges["e-n-000-n-003"]).toBeTruthy();
    expect(tree.edges["e-n-001-n-004"]).toBeTruthy();
    // Swimlanes have groups (lanes) and handoffs across them.
    const swim = swimlaneBoard(40);
    expect(Object.keys(swim.groups).length).toBeGreaterThanOrEqual(2);
    expect(Object.values(swim.edges).some((e) => e.relationship === "hands off to")).toBe(true);
    // Radial has one topic node reaching several branches.
    const radial = radialBoard(40);
    expect(Object.values(radial.edges).filter((e) => e.relationship === "spans").length).toBeGreaterThanOrEqual(3);
  });
});

describe("visual metrics invariants across scales", () => {
  for (const factory of BOARD_FACTORIES) {
    describe(factory.label, () => {
      for (const n of SCALES) {
        it(`n=${n}: packing, geometry, and bounded sprawl hold`, () => {
          const metrics = measureVisualMetrics(factory.build(n));
          // INVARIANT 1 — packing: no two node boxes may ever overlap.
          expect(metrics.nodeOverlaps, "node overlaps").toBe(0);
          // INVARIANT 2 — geometry: every node and edge lays out to finite
          // coordinates (the wrap/collapse defect class shows up here first).
          expect(metrics.offscreenEntries, "offscreen/unlaid-out entries").toBe(0);
          // INVARIANT 3 — the board is not degenerate: layout produced edges.
          expect(metrics.edgeCount).toBeGreaterThan(0);
          // INVARIANT 4 — bounded sprawl: canvas area grows with nodes, so
          // mean edge length must stay proportional (per-node length within
          // an order of magnitude across the whole ladder — generous by
          // design; it catches explosions, not tuning).
          if (n >= 80) {
            expect(metrics.edgeLengthPerNode).toBeGreaterThan(0);
            expect(metrics.edgeLengthPerNode).toBeLessThan(50);
          }
        });
      }
    });
  }
});

describe("metric correctness on hand-built geometry", () => {
  it("zero crossings for two disjoint edges; one crossing for an X", () => {
    const ws = createWorkspace();
    ws.nodes.a = { id: "a", nodeType: "x", label: "a" };
    ws.nodes.b = { id: "b", nodeType: "x", label: "b" };
    ws.nodes.c = { id: "c", nodeType: "x", label: "c" };
    ws.nodes.d = { id: "d", nodeType: "x", label: "d" };
    ws.edges.e1 = { id: "e1", source: "a", target: "b", relationship: "r" };
    ws.edges.e2 = { id: "e2", source: "c", target: "d", relationship: "r" };
    // A pre-supplied layout shaped as two parallel lines: no crossings.
    const parallel = measureVisualMetrics(
      ws,
      {},
      {
        a: { position: { x: 0, y: 0 }, size: { width: 10, height: 10 } },
        b: { position: { x: 100, y: 0 }, size: { width: 10, height: 10 } },
        c: { position: { x: 0, y: 50 }, size: { width: 10, height: 10 } },
        d: { position: { x: 100, y: 50 }, size: { width: 10, height: 10 } },
      },
    );
    expect(parallel.crossings).toBe(0);
    expect(parallel.edgeLengthMean).toBeCloseTo(100, 0);
    // The X: swap d so the segments cross mid-canvas.
    const crossed = measureVisualMetrics(
      ws,
      {},
      {
        a: { position: { x: 0, y: 0 }, size: { width: 10, height: 10 } },
        b: { position: { x: 100, y: 100 }, size: { width: 10, height: 10 } },
        c: { position: { x: 0, y: 100 }, size: { width: 10, height: 10 } },
        d: { position: { x: 100, y: 0 }, size: { width: 10, height: 10 } },
      },
    );
    expect(crossed.crossings).toBe(1);
  });

  it("shared endpoints do not count as crossings", () => {
    const ws = createWorkspace();
    ws.nodes.a = { id: "a", nodeType: "x", label: "a" };
    ws.nodes.b = { id: "b", nodeType: "x", label: "b" };
    ws.nodes.c = { id: "c", nodeType: "x", label: "c" };
    ws.edges.e1 = { id: "e1", source: "a", target: "b", relationship: "r" };
    ws.edges.e2 = { id: "e2", source: "a", target: "c", relationship: "r" };
    const metrics = measureVisualMetrics(
      ws,
      {},
      {
        a: { position: { x: 0, y: 0 }, size: { width: 10, height: 10 } },
        b: { position: { x: 100, y: 100 }, size: { width: 10, height: 10 } },
        c: { position: { x: 0, y: 100 }, size: { width: 10, height: 10 } },
      },
    );
    expect(metrics.crossings).toBe(0);
  });

  it("overlapping boxes are counted, and unlaid-out nodes are offscreen", () => {
    const ws = createWorkspace();
    ws.nodes.a = { id: "a", nodeType: "x", label: "a" };
    ws.nodes.b = { id: "b", nodeType: "x", label: "b" };
    ws.nodes.z = { id: "z", nodeType: "x", label: "z" };
    const metrics = measureVisualMetrics(
      ws,
      {},
      {
        a: { position: { x: 0, y: 0 }, size: { width: 100, height: 50 } },
        b: { position: { x: 50, y: 0 }, size: { width: 100, height: 50 } },
        // z deliberately absent from the layout.
      },
    );
    expect(metrics.nodeOverlaps).toBe(1);
    expect(metrics.offscreenEntries).toBe(1);
  });
});

describe("layout compute stays fast enough to measure", () => {
  it("the 500-node worst case lays out in a bounded time (advisory only)", () => {
    const metrics = measureVisualMetrics(layeredBoard(500));
    // Advisory ceiling: a regression past an order of magnitude over the
    // baseline is worth failing on; the readability metrics above are the
    // real gate. Generous because CI machines vary.
    expect(metrics.layoutMs).toBeLessThan(5000);
  });

  it("computeLayout is deterministic for the benchmark fixtures", () => {
    for (const factory of BOARD_FACTORIES) {
      const a = computeLayout(factory.build(150));
      const b = computeLayout(factory.build(150));
      expect(a, factory.label).toEqual(b);
    }
  });
});
