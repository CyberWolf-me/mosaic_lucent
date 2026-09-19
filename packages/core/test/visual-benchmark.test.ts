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
  adversarialBoard,
  denseBoard,
  layeredBoard,
  longEdgeBoard,
  mixedRegionBoard,
  radialBoard,
  swimlaneBoard,
  treeBoard,
} from "../src/benchmarkBoards.js";
import { createWorkspace } from "../src/model.js";
import { measureMovementAfterEdit, measureVisualMetrics } from "../src/visualBenchmark.js";
import {
  applyLayout,
  applyRoutes,
  computeLayout,
  computeLayoutWithRoutes,
  relayoutRegionWithRoutes,
  CURRENT_LAYOUT_ENGINE,
} from "../src/layout.js";
import { setLayoutOverride, type DiagramLayoutEngine } from "../src/layoutEngine.js";

const SCALES = [20, 40, 80, 150, 300, 500] as const;

describe("synthetic benchmark boards", () => {
  it("every factory hits the requested node count exactly", () => {
    for (const factory of BOARD_FACTORIES) {
      for (const n of [20, 80, 500]) {
        const ws = factory.build(n);
        expect(Object.keys(ws.nodes).length, `${factory.label} at n=${n}`).toBe(n);
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
    expect(
      Object.values(radial.edges).filter((e) => e.relationship === "spans").length,
    ).toBeGreaterThanOrEqual(3);
    // Dense carries ~2.2–2.5× edges per node (the fan-in stress).
    const dense = denseBoard(150);
    expect(Object.keys(dense.edges).length).toBeGreaterThanOrEqual(2 * 150);
    // Adversarial carries cycles (back edges) AND diamonds — the V5 defect
    // class and the ordering pass's coin flips, on one board.
    const adversarial = adversarialBoard(150);
    expect(
      Object.values(adversarial.edges).filter((e) => e.relationship === "falls back to").length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      Object.values(adversarial.edges).filter((e) => e.relationship === "merges into").length,
    ).toBeGreaterThanOrEqual(2);
    // Long edges: skips span a quarter, a half, and three quarters of the
    // depth — asserted via the layer metadata the generator stamps.
    const longEdge = longEdgeBoard(100);
    const layerOf = (nid: string) => longEdge.nodes[nid]!.metadata!.layer as number;
    const spans = Object.values(longEdge.edges)
      .filter((e) => e.relationship === "bypasses")
      .map((e) => Math.abs(layerOf(e.target) - layerOf(e.source)));
    expect(Math.max(...spans)).toBeGreaterThanOrEqual(10);
    expect(new Set(spans).size).toBeGreaterThanOrEqual(3);
    // Mixed regions: two kind-regions plus ungrouped board flow (ADR 0014).
    const mixed = mixedRegionBoard(80);
    expect(mixed.groups["region-mind"]!.kind).toBe("mindmap");
    expect(mixed.groups["region-tree"]!.kind).toBe("decisiontree");
    const ungrouped = Object.values(mixed.nodes).filter((n) => !n.groupId);
    expect(ungrouped.length).toBeGreaterThanOrEqual(3);
    // …and at least one cross-region edge, so cohesion has a cross set.
    const withRegion = (nid: string) => Boolean(mixed.nodes[nid]!.groupId);
    expect(
      Object.values(mixed.edges).some((e) => withRegion(e.source) !== withRegion(e.target)),
    ).toBe(true);
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

describe("phase 0 metrics on hand-built geometry", () => {
  const box = (x: number, y: number) => ({
    position: { x, y },
    size: { width: 10, height: 10 },
  });

  function fourNodeBoard() {
    const ws = createWorkspace();
    for (const id of ["a", "b", "c", "d"]) {
      ws.nodes[id] = { id, nodeType: "x", label: id };
    }
    return ws;
  }

  it("an edge through a foreign node box counts; a clean edge does not", () => {
    const ws = fourNodeBoard();
    // a → b runs left to right THROUGH c, which sits on the line between them.
    ws.edges.e1 = { id: "e1", source: "a", target: "b", relationship: "r" };
    ws.nodes.c = { ...ws.nodes.c!, label: "c" };
    const through = measureVisualMetrics(
      ws,
      {},
      {
        a: box(0, 0),
        b: box(100, 0),
        c: box(50, 0),
        d: box(0, 100),
      },
    );
    expect(through.edgesThroughNodes).toBe(1);
    // Same board, c out of the way: zero.
    const clean = measureVisualMetrics(
      ws,
      {},
      {
        a: box(0, 0),
        b: box(100, 0),
        c: box(50, 50),
        d: box(0, 100),
      },
    );
    expect(clean.edgesThroughNodes).toBe(0);
  });

  it("bends count route waypoints; unrouted edges bend zero", () => {
    const ws = fourNodeBoard();
    ws.edges.e1 = { id: "e1", source: "a", target: "b", relationship: "r" };
    ws.edges.e2 = {
      id: "e2",
      source: "c",
      target: "d",
      relationship: "r",
      route: [
        { x: 50, y: 200 },
        { x: 60, y: 200 },
      ],
    };
    // Polyline pinned as the controlled variable: under the board kind's own
    // policy (flowchart → ortho) each diagonal approach segment squares into
    // an elbow and the mean rises to 2 — that drawn-truth behavior is what
    // the routing-styles tests pin; THIS test pins the raw waypoint count.
    const metrics = measureVisualMetrics(
      ws,
      {},
      {
        a: box(0, 0),
        b: box(100, 0),
        c: box(0, 100),
        d: box(100, 100),
      },
      "polyline",
    );
    expect(metrics.edgeBendsMean).toBeCloseTo(1, 5); // (0 + 2) / 2 edges
  });

  it("viewport coverage is node area over bounding box", () => {
    const ws = fourNodeBoard();
    const metrics = measureVisualMetrics(
      ws,
      {},
      {
        a: box(0, 0),
        b: box(90, 0),
        c: box(0, 90),
        d: box(90, 90),
      },
    );
    // Four 10×10 boxes in a 100×100 bbox → 400/10000.
    expect(metrics.viewportCoverage).toBeCloseTo(0.04, 5);
  });

  it("cohesion: intra-region edges shorter than cross-region edges yield < 1", () => {
    const ws = createWorkspace();
    ws.groups.g1 = { id: "g1", label: "G1", children: ["a", "b"] };
    ws.nodes.a = { id: "a", nodeType: "x", label: "a", groupId: "g1" };
    ws.nodes.b = { id: "b", nodeType: "x", label: "b", groupId: "g1" };
    ws.nodes.c = { id: "c", nodeType: "x", label: "c" };
    ws.edges.intra = { id: "intra", source: "a", target: "b", relationship: "r" };
    ws.edges.cross = { id: "cross", source: "b", target: "c", relationship: "r" };
    const metrics = measureVisualMetrics(
      ws,
      {},
      {
        a: box(0, 0),
        b: box(10, 0),
        c: box(1000, 0),
      },
    );
    expect(metrics.cohesionRatio).toBeCloseTo(10 / 990, 5);
  });

  it("cohesion is null when no edge touches a group", () => {
    const ws = fourNodeBoard();
    ws.edges.e1 = { id: "e1", source: "a", target: "b", relationship: "r" };
    const metrics = measureVisualMetrics(
      ws,
      {},
      {
        a: box(0, 0),
        b: box(100, 0),
        c: box(0, 100),
        d: box(100, 100),
      },
    );
    expect(metrics.cohesionRatio).toBeNull();
  });
});

describe("movement after edit (spatial additivity, Phase 0)", () => {
  it("the region-scoped path moves nothing outside the region", () => {
    // The app's commit invariant (ADR 0015): an addition relayouts the
    // anchor's group; every node outside restates its position.
    const m = measureMovementAfterEdit(mixedRegionBoard(120));
    expect(m.regionScoped).toBeTruthy();
    expect(m.regionScoped!.movedOutsideRegion).toBe(0);
  });

  it("full relayout accounts for every pre-existing node", () => {
    for (const factory of BOARD_FACTORIES) {
      const m = measureMovementAfterEdit(factory.build(80));
      expect(m.fullRelayout.movedCount + m.fullRelayout.identicalCount).toBe(m.nodeCount);
    }
  });

  it("the swimlane board is region-scoped too (lanes are groups)", () => {
    const m = measureMovementAfterEdit(swimlaneBoard(100));
    expect(m.regionScoped).toBeTruthy();
    expect(m.regionScoped!.movedOutsideRegion).toBe(0);
  });
});

describe("the layout-engine boundary (Phase 1)", () => {
  it("CURRENT_LAYOUT_ENGINE reproduces computeLayoutWithRoutes exactly", () => {
    for (const factory of BOARD_FACTORIES) {
      const built = factory.build(150);
      const throughBoundary = CURRENT_LAYOUT_ENGINE.layout({ workspace: built, options: {} });
      const direct = computeLayoutWithRoutes(built);
      expect(throughBoundary.layout, factory.label).toEqual(direct.layout);
      expect(throughBoundary.routes, factory.label).toEqual(direct.routes);
    }
  });

  it("relayoutRegion through the boundary matches the implementation", () => {
    const built = mixedRegionBoard(80);
    // Stamp positions first (the engine's region seam reads current geometry).
    const stamped = applyRoutes(
      applyLayout(built, computeLayout(built)),
      computeLayoutWithRoutes(built).routes,
    );
    const throughBoundary = CURRENT_LAYOUT_ENGINE.relayoutRegion!(stamped, "region-mind");
    const direct = relayoutRegionWithRoutes(stamped, "region-mind");
    expect(throughBoundary).toEqual(direct);
  });

  it("a registered override engine serves supported requests; clearing restores the default", () => {
    const built = layeredBoard(40);
    const sentinel = {
      layout: { "x-fake": { position: { x: 1, y: 2 }, size: { width: 3, height: 4 } } },
      routes: {},
    };
    const fake: DiagramLayoutEngine = {
      id: "test-override",
      supports: (req) => req.workspace.id === built.id,
      layout: () => sentinel as unknown as ReturnType<DiagramLayoutEngine["layout"]>,
    };
    try {
      setLayoutOverride(fake);
      const { layout } = computeLayoutWithRoutes(built);
      expect(layout).toEqual(sentinel.layout);
    } finally {
      setLayoutOverride(null);
    }
    // The default path is restored — the real engine answers again.
    const restored = computeLayoutWithRoutes(built);
    expect(restored.layout["n-000"]).toBeTruthy();
    expect(Object.keys(restored.layout).length).toBe(40);
  });

  it("an override that does not support a request is skipped, not fatal", () => {
    const built = layeredBoard(40);
    const refusing: DiagramLayoutEngine = {
      id: "test-refusing",
      supports: () => false,
      layout: () => {
        throw new Error("must never be called");
      },
    };
    try {
      setLayoutOverride(refusing);
      const { layout } = computeLayoutWithRoutes(built);
      expect(Object.keys(layout).length).toBe(40);
    } finally {
      setLayoutOverride(null);
    }
  });
});
