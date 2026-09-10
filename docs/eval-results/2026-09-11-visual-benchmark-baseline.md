# Visual benchmark — deterministic baseline (2026-09-11, branch persist-test-measure)

The 2026-09 advisory review's Phase-1/V4 ask, answered the repo's way: a
permanent, deterministic layout benchmark that turns "the canvas is the
biggest product gap" into numbers a layout change can be judged by.

- **Harness**: `packages/core/src/visualBenchmark.ts` — pure geometry over a
  laid-out workspace (crossings, node overlaps, edge-length mean/p95,
  per-node length, offscreen entries, layout ms). No DOM; the same
  vocabulary serves vitest, CI, and the live browser pass.
- **Fixtures**: `packages/core/src/benchmarkBoards.ts` — four deterministic
  generators shaped like each strategy's real workload (layered DAG with
  skip + return edges; radial mind map with cross-links; ternary tree;
  swimlanes with handoffs). Pure functions of (n, seed): a metric change is
  a layout change, never a fixture roll.
- **Pins**: `packages/core/test/visual-benchmark.test.ts` (33 tests) —
  invariants (zero overlaps, zero offscreen, bounded sprawl), metric
  correctness on hand-built geometry (shared endpoints are not crossings),
  determinism. Not golden numbers: layout work may move metrics; the pins
  fail only on structural breaks.
- **Runner**: `npx tsx scripts/visual-benchmark.ts [--json]` — the ladder
  20/40/80/150/300/500 × four kinds, median-of-3.

## The baseline (median of 3, 2026-09-11)

| board | nodes | edges | crossings | overlaps | eMean | eP95 | e/n | layout ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| layered (flowchart/arch) | 20 | 24 | **25** | 0 | 524 | 1199 | 26.2 | 0.5 |
| layered | 40 | 55 | **139** | 0 | 578 | 1398 | 14.5 | 0.8 |
| layered | 80 | 124 | **425** | 0 | 2140 | 4373 | 26.7 | 0.9 |
| layered | 150 | 239 | **1563** | 0 | 863 | 2529 | 5.8 | 3.3 |
| layered | 300 | 512 | **2950** | 0 | 8342 | 2444 | 27.8 | 2.3 |
| layered | 500 | 844 | **10871** | 0 | 1321 | 3352 | 2.6 | 6.9 |
| radial (mind map) | 20→500 | 19–499 | 0 | 0 | 361–398 | 300–666 | 0.8–18.6 | 0.1–0.7 |
| tree (decision/org) | 20→500 | 19–499 | 0 | 0 | 342–613 | 805–1883 | 1.2–17.1 | 0.1–0.7 |
| swimlane (process) | 20→500 | 21–627 | 0 | 0 | 405–3111 | 1140–21281 | 6.2–20.2 | 0.1–0.9 |

(Radial/tree/swimlane rows condensed: every scale held **0 crossings and
0 overlaps** — full table via the runner.)

## What the baseline says

1. **The layered engine is the only strategy that crosses edges, and it
   explodes with scale** — 25 crossings at 20 nodes to 10,871 at 500. This
   is the mechanical signature of the live pass's V2 finding (T1/T3
   flowchart wrap, return edges crossing the canvas). Radial, tree, and
   swimlane hold zero crossings across the entire ladder. **The layered
   ordering pass is the P0 visual defect.**
2. Packing and geometry are sound everywhere: **zero node overlaps and
   zero offscreen entries at every scale** for all four strategies — the
   wrap/collapse class does not come from computeLayout itself.
3. Layout compute is not a factor at any scale (≤7 ms at 500 nodes) —
   consistent with the live pass's 2–8 ms interaction numbers. Speed was
   never the problem; crossing density is.
4. Layered eMean spikes (2140 at 80 nodes, 8342 at 300) line up with the
   deep-chain wrap path engaging — rows of wrapped layers mean long
   cross-row edges. The wrap fixes the pole defect but trades it for
   crossings; both facts are now on record.

## Deliberately not measured here

10-second comprehension and manual-cleanup time are human-judged metrics
owned by the live eval protocol (`docs/eval-results`), never by a
deterministic harness. This module owns the mechanical half; the next live
pass scores the human half against this baseline.

## What this is FOR

- Every layout change now has a before/after table (`scripts/visual-benchmark.ts`).
- The ELK question (review V5) is answered by running the same fixtures
  through a candidate engine and comparing this exact table — "the
  benchmark should decide," now with the benchmark existing.
- The 2026-09-11 follow-up (same day): the layered crossings fix lands
  with this benchmark as its acceptance gate.
