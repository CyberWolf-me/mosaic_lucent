/**
 * The visual-benchmark runner — prints the baseline table the 2026-09 review
 * asked for: every board workload × the 20→500 node ladder, measured on the
 * deterministic synthetic boards (benchmarkBoards.ts) with the same metrics
 * the tests pin (visualBenchmark.ts). Phase 0 added the density/collision/
 * cohesion columns and the movement-after-edit table (the spatial-additivity
 * baseline the ELK comparison and any future engine must preserve).
 *
 * Run: npx tsx scripts/visual-benchmark.ts [--json]
 *
 * What the numbers are FOR (from the review, taken as the working rule):
 * - crossings / overlaps / per-node edge length / edges-through-nodes are
 *   the readability proxies — they regress-guard layout work and give the
 *   ELK question a decision procedure ("the benchmark should decide").
 * - layoutMs is advisory: excellent interaction latency never excuses an
 *   unreadable board.
 * - 10-second comprehension and manual-cleanup time live in the live eval
 *   protocol, not here; this is the mechanical half of the story.
 */

import { BOARD_FACTORIES } from "../packages/core/src/benchmarkBoards.js";
import { CURRENT_LAYOUT_ENGINE, applyLayout, applyRoutes } from "../packages/core/src/layout.js";
import {
  measureMovementAfterEdit,
  measureVisualMetrics,
} from "../packages/core/src/visualBenchmark.js";

const SCALES = [20, 40, 80, 150, 300, 500];
const MOVEMENT_SCALES = [100, 200];

const args = process.argv.slice(2);
const asJson = args.includes("--json");

// Warm-up: JIT-compile the layout path once so the first measurement isn't
// polluted by interpreter startup (the runner reports steady-state numbers).
measureVisualMetrics(BOARD_FACTORIES[0].build(20));

interface Row {
  board: string;
  nodes: number;
  edges: number;
  crossings: number;
  nodeOverlaps: number;
  edgeMean: number;
  edgeP95: number;
  edgePerNode: number;
  bends: number;
  through: number;
  coverage: number;
  cohesion: number | null;
  layoutMs: number;
}

const rows: Row[] = [];
for (const factory of BOARD_FACTORIES) {
  for (const n of SCALES) {
    // Three deterministic builds, median-of-3 on timing-sensitive numbers,
    // same fixture every time (generators are pure). Each build is routed
    // and stamped exactly as the app does (applyLayout + applyRoutes), so
    // the crossings count the polylines the renderer will actually draw.
    const runs = [0, 1, 2].map(() => {
      const built = factory.build(n);
      // Through the Phase 1 boundary: the engine interface, not the
      // implementation's entry point — the Phase 2 ELK comparison swaps
      // exactly this object and nothing else.
      const { layout, routes } = CURRENT_LAYOUT_ENGINE.layout({
        workspace: built,
        options: {},
      });
      const routed = applyRoutes(applyLayout(built, layout), routes);
      return measureVisualMetrics(routed);
    });
    const median = (pick: (m: (typeof runs)[number]) => number) =>
      runs.map(pick).sort((a, b) => a - b)[1];
    const m = runs[0];
    rows.push({
      board: factory.label,
      nodes: m.nodeCount,
      edges: m.edgeCount,
      crossings: m.crossings,
      nodeOverlaps: m.nodeOverlaps,
      edgeMean: Math.round(median((r) => r.edgeLengthMean)),
      edgeP95: Math.round(median((r) => r.edgeLengthP95)),
      edgePerNode: Number(m.edgeLengthPerNode.toFixed(3)),
      bends: Number(median((r) => r.edgeBendsMean).toFixed(2)),
      through: median((r) => r.edgesThroughNodes),
      coverage: Number(median((r) => r.viewportCoverage).toFixed(2)),
      cohesion: m.cohesionRatio === null ? null : Number(m.cohesionRatio.toFixed(2)),
      layoutMs: Number(median((r) => r.layoutMs).toFixed(1)),
    });
  }
}

interface MovementRow {
  board: string;
  nodes: number;
  anchorGroup: string | null;
  fullMoved: number;
  fullIdentical: number;
  fullMaxDisp: number;
  regionMovedOutside: number | null;
  regionMovedInside: number | null;
}

const movementRows: MovementRow[] = [];
for (const factory of BOARD_FACTORIES) {
  for (const n of MOVEMENT_SCALES) {
    const m = measureMovementAfterEdit(factory.build(n));
    movementRows.push({
      board: factory.label,
      nodes: m.nodeCount,
      anchorGroup: m.regionScoped?.groupId ?? null,
      fullMoved: m.fullRelayout.movedCount,
      fullIdentical: m.fullRelayout.identicalCount,
      fullMaxDisp: m.fullRelayout.maxDisplacement,
      regionMovedOutside: m.regionScoped?.movedOutsideRegion ?? null,
      regionMovedInside: m.regionScoped?.movedInsideRegion ?? null,
    });
  }
}

if (asJson) {
  console.log(JSON.stringify({ rows, movementRows }, null, 2));
} else {
  const header = [
    "board".padEnd(36),
    "nodes".padStart(5),
    "edges".padStart(5),
    "cross".padStart(6),
    "ovlp".padStart(4),
    "thru".padStart(5),
    "eMean".padStart(6),
    "eP95".padStart(6),
    "bend".padStart(5),
    "cov".padStart(5),
    "coh".padStart(5),
    "ms".padStart(6),
  ].join("");
  console.log("Lucent visual benchmark — deterministic baseline (median of 3)\n");
  console.log(header);
  console.log("-".repeat(header.length));
  for (const r of rows) {
    console.log(
      [
        r.board.padEnd(36),
        String(r.nodes).padStart(5),
        String(r.edges).padStart(5),
        String(r.crossings).padStart(6),
        String(r.nodeOverlaps).padStart(4),
        String(r.through).padStart(5),
        String(r.edgeMean).padStart(6),
        String(r.edgeP95).padStart(6),
        r.bends.toFixed(2).padStart(5),
        r.coverage.toFixed(2).padStart(5),
        r.cohesion === null ? "    —" : r.cohesion.toFixed(2).padStart(5),
        r.layoutMs.toFixed(1).padStart(6),
      ].join(""),
    );
  }
  console.log(
    "\ncross=edge crossings  ovlp=node overlaps  thru=edges through foreign node boxes" +
      "\neMean/eP95=edge length (px)  bend=mean bends/edge  cov=node area / bbox area  coh=intra/cross region edge length  ms=layout compute",
  );

  const mHeader = [
    "board".padEnd(36),
    "nodes".padStart(5),
    "full moved".padStart(11),
    "identical".padStart(10),
    "max dx".padStart(8),
    "region out".padStart(11),
    "region in".padStart(10),
  ].join("");
  console.log("\nMovement after edit — one probe node added to the highest-degree node\n");
  console.log(mHeader);
  console.log("-".repeat(mHeader.length));
  for (const r of movementRows) {
    console.log(
      [
        r.board.padEnd(36),
        String(r.nodes).padStart(5),
        String(r.fullMoved).padStart(11),
        String(r.fullIdentical).padStart(10),
        `${r.fullMaxDisp.toFixed(0)}px`.padStart(8),
        r.regionMovedOutside === null ? "       n/a" : String(r.regionMovedOutside).padStart(11),
        r.regionMovedInside === null ? "       n/a" : String(r.regionMovedInside).padStart(10),
      ].join(""),
    );
  }
  console.log(
    "\nfull=whole-board relayout (worst case)  region=the app's scoped path (ADR 0015);" +
      "\nregion out MUST be 0 — outside nodes restate their positions by construction.",
  );
}
