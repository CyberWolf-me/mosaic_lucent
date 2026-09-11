/**
 * The visual-benchmark runner — prints the baseline table the 2026-09 review
 * asked for: every layout strategy × the 20→500 node ladder, measured on the
 * deterministic synthetic boards (benchmarkBoards.ts) with the same metrics
 * the tests pin (visualBenchmark.ts).
 *
 * Run: npx tsx scripts/visual-benchmark.ts [--json]
 *
 * What the numbers are FOR (from the review, taken as the working rule):
 * - crossings / overlaps / per-node edge length are the readability
 *   proxies — they regress-guard layout work and give the ELK question a
 *   decision procedure ("the benchmark should decide").
 * - layoutMs is advisory: excellent interaction latency never excuses an
 *   unreadable board.
 * - 10-second comprehension and manual-cleanup time live in the live eval
 *   protocol, not here; this is the mechanical half of the story.
 */

import { BOARD_FACTORIES } from "../packages/core/src/benchmarkBoards.js";
import { applyLayout, applyRoutes, computeLayoutWithRoutes } from "../packages/core/src/layout.js";
import { measureVisualMetrics } from "../packages/core/src/visualBenchmark.js";

const SCALES = [20, 40, 80, 150, 300, 500];

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
      const { layout, routes } = computeLayoutWithRoutes(built);
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
      edgePerNode: Number((m.edgeLengthPerNode).toFixed(3)),
      layoutMs: Number(median((r) => r.layoutMs).toFixed(1)),
    });
  }
}

if (asJson) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  const header = [
    "board".padEnd(34),
    "nodes".padStart(5),
    "edges".padStart(5),
    "cross".padStart(6),
    "ovlp".padStart(4),
    "eMean".padStart(6),
    "eP95".padStart(6),
    "e/n".padStart(6),
    "ms".padStart(7),
  ].join("");
  console.log("Lucent visual benchmark — deterministic baseline (median of 3)\n");
  console.log(header);
  console.log("-".repeat(header.length));
  for (const r of rows) {
    console.log(
      [
        r.board.padEnd(34),
        String(r.nodes).padStart(5),
        String(r.edges).padStart(5),
        String(r.crossings).padStart(6),
        String(r.nodeOverlaps).padStart(4),
        String(r.edgeMean).padStart(6),
        String(r.edgeP95).padStart(6),
        r.edgePerNode.toFixed(3).padStart(6),
        r.layoutMs.toFixed(1).padStart(7),
      ].join(""),
    );
  }
  console.log(
    "\ncross=edge crossings  ovlp=node overlaps  eMean/eP95=edge length (px)  e/n=per-node mean  ms=layout compute",
  );
}
