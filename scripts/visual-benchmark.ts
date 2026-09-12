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

// Routing-style sweep (doc 18, Phase 5, advisory V10): measure the identical
// ladder under each FORCED route style, so the per-family table is decided
// from numbers rather than taste. The layout is FIXED per board (computed
// once, passed into the metric); the swept style rides the metric's own
// routeStyleFor lookup by measuring a clone whose diagramKind maps to the
// swept style — a kind whose policy is the style, never a kind that would
// change the layout itself (layout is pre-supplied either way). Prints
// style × board × scale and exits. Defined here, invoked after engine
// selection + warm-up below.
const routingArg = args.find((a) => a.startsWith("--routing"));
async function runRoutingSweep(): Promise<void> {
  const { routeStyleFor } = await import("../packages/core/src/routing.js");
  const styles = ["polyline", "ortho", "spline"] as const;
  const ROUTING_SCALES = [150, 300, 500];
  // A kind per style: each maps to that style in the policy table, and none
  // changes geometry here (the layout arrives pre-computed).
  const KIND_WITH_POLICY = {
    polyline: "flowchart",
    ortho: "process",
    spline: "architecture",
  } as const;
  const header = [
    "board".padEnd(36),
    "style".padStart(9),
    "nodes".padStart(5),
    "cross".padStart(7),
    "bend".padStart(6),
    "thru".padStart(5),
    "eMean".padStart(7),
    "policy".padStart(9),
  ].join("");
  console.log(`Routing-style sweep — engine: ${engine.id} (layout fixed; the DRAWN style varies)\n`);
  console.log(header);
  console.log("-".repeat(header.length));
  for (const factory of BOARD_FACTORIES) {
    for (const n of ROUTING_SCALES) {
      const built = factory.build(n);
      const { layout, routes } = await engine.layout({ workspace: built, options: {} });
      const routed = applyRoutes(applyLayout(built, layout), routes);
      for (const style of styles) {
        const stamped = { ...routed, diagramKind: KIND_WITH_POLICY[style] as typeof routed.diagramKind };
        const m = measureVisualMetrics(stamped, {}, layout);
        console.log(
          [
            factory.label.padEnd(36),
            style.padStart(9),
            String(m.nodeCount).padStart(5),
            String(m.crossings).padStart(7),
            m.edgeBendsMean.toFixed(2).padStart(6),
            String(m.edgesThroughNodes).padStart(5),
            String(Math.round(m.edgeLengthMean)).padStart(7),
            routeStyleFor(factory.kind).padStart(9),
          ].join(""),
        );
      }
    }
  }
  process.exit(0);
}

// Engine selection (Phase 2): `--engine=elk` runs the identical ladder
// through the ELK candidate behind the Phase 1 boundary. Everything else
// runs the built-in engine. NOTE: an elk run resolves @lucent/core to
// source, so invoke with `npx tsx --conditions=development` — the default
// resolution would read stale dist/.
let engine: import("../packages/core/src/layoutEngine.js").DiagramLayoutEngine =
  CURRENT_LAYOUT_ENGINE;
const engineArg = args.find((a) => a.startsWith("--engine="));
if (engineArg) {
  const id = engineArg.split("=")[1];
  if (id === "elk") {
    ({ ELK_LAYOUT_ENGINE: engine } = await import(
      "../packages/web/src/diagram/elk/elkLayoutEngine.js"
    ));
  } else {
    console.error(`unknown engine "${id}" (supported: elk)`);
    process.exit(1);
  }
}

// Warm-up: JIT-compile the layout path once so the first measurement isn't
// polluted by interpreter startup (the runner reports steady-state numbers).
// The selected engine gets its own warm-up call — ELK's first layout pays
// worker/ELK init, which would poison every small-board median.
measureVisualMetrics(BOARD_FACTORIES[0].build(20));
await engine.layout({ workspace: BOARD_FACTORIES[0].build(20), options: {} });

if (routingArg) await runRoutingSweep();

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
    // Through the Phase 1 boundary: the engine interface, not the
    // implementation's entry point — the selected engine is the only thing
    // that changes between runs.
    const runs = [];
    for (let i = 0; i < 3; i++) {
      const built = factory.build(n);
      // Time the ENGINE call itself: measureVisualMetrics receives the
      // pre-supplied layout (so it measures the engine's geometry, not a
      // recompute) and therefore cannot time the layout anymore.
      const t0 = performance.now();
      const { layout, routes } = await engine.layout({ workspace: built, options: {} });
      const engineMs = performance.now() - t0;
      const routed = applyRoutes(applyLayout(built, layout), routes);
      // Measure THE ENGINE'S geometry: without passing `layout` here the
      // measurement would recompute with the built-in engine — invisible for
      // the self-consistent default, garbage for any candidate engine.
      const metrics = measureVisualMetrics(routed, {}, layout);
      runs.push({ metrics, engineMs });
    }
    const median = (pick: (m: (typeof runs)[number]["metrics"]) => number) =>
      runs.map((r) => pick(r.metrics)).sort((a, b) => a - b)[1];
    const m = runs[0]!.metrics;
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
      layoutMs: Number([...runs.map((r) => r.engineMs)].sort((a, b) => a - b)[1]!.toFixed(1)),
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

// Movement is measured through the core's SYNC relayout paths; it is only
// meaningful for the built-in engine. An async candidate's incremental
// behavior is the Phase 4 policy, not a Phase 2 column.
const movementRows: MovementRow[] = [];
if (engine === CURRENT_LAYOUT_ENGINE) {
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
}

if (asJson) {
  console.log(JSON.stringify({ engine: engine.id, rows, movementRows }, null, 2));
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
  console.log(`Lucent visual benchmark — engine: ${engine.id} (median of 3)\n`);
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
  if (engine === CURRENT_LAYOUT_ENGINE) {
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
  } else {
    console.log(
      "\nMovement after edit: not comparable for async engines through the sync harness" +
        " — the incremental policy is Phase 4 work (doc 18).",
    );
  }
}
