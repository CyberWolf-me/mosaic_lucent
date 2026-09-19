# Visual benchmark — Phase 0 completion (2026-09-12, doc 18)

> **Status: Phase 0 of `docs/18-structured-visual-engine.md` — the mechanical
> half is complete.** The corpus now covers the advisory's harder workloads,
> the metric set is extended, and the spatial-additivity baseline is on
> record. The human half (10-second comprehension, manual cleanup, preference,
> render latency) remains a live-eval-protocol item and is explicitly pending.
> One engine defect was found by the new fixtures and fixed same-day, in the
> 2026-09-11 pattern: the benchmark decides.

## What Phase 0 added

- **Fixtures** (`packages/core/src/benchmarkBoards.ts`), all pure functions of
  (n, seed), node-count-exact:
  - `denseBoard` — layered architecture with fan-in 2–3, skip edges, and
    same-layer peers; ≈2.2–2.5 edges per node at every scale.
  - `adversarialBoard` — repeated diamonds, triple fan-ins, and a back edge
    every third layer (each a cycle the DFS layering must survive).
  - `longEdgeBoard` — constant row width 4 keeps the deep-chain wrap gate
    off, so skip edges must span ¼, ½, and ¾ of the board's depth.
  - `mixedRegionBoard` — ADR 0014's real shape: a mind-map region (40%), a
    decision-tree region (30%), ungrouped board flow (30%), one cross-region
    edge.
- **Metrics** (`packages/core/src/visualBenchmark.ts`):
  `edgeBendsMean`, `edgesThroughNodes` (edges whose drawn polyline enters a
  node box other than their endpoints — the mechanical stand-in for the
  "objects collide with content" readability class), `viewportCoverage`
  (node area ÷ layout bounding box), `cohesionRatio` (intra- vs cross-region
  edge length; null when the board has no groups).
- **Movement after edit** (`measureMovementAfterEdit`): one probe node
  attached to the highest-degree node, then two relayout paths measured —
  the full-board worst case, and the app's actual region-scoped commit path
  (ADR 0015). This is the harness the Phase 4 acceptance test ("100 nodes +
  1 → ≥98 pixel-identical") will run on.
- **Runner** (`scripts/visual-benchmark.ts`): the four new columns plus a
  movement table. Same ladder, same seeds, median-of-3.
- **Pins**: 32 new tests (65 total in `visual-benchmark.test.ts`): generator
  determinism and count-exactness cover the new factories; the through-node,
  bends, coverage, and cohesion metrics are verified on hand-built geometry;
  the region-scoped movement invariant is pinned at 0 moved-outside for the
  region boards.

## The Phase 0 finding: radial rings sized by depth, not population

`mixedRegionBoard` at n≥150 failed the zero-overlap pin (12 → 82 → 251
overlaps at 150/300/500). The cause was in the engine, not the fixture:
`radialLayout` computed each ring's radius from its **depth** only
(`ring * (ringGap + widest/2)`), so a ring holding 66 branches got the same
radius formula as one holding 6 — nodes overlapped around the circumference.
`radialBoard` never caught this because its branches chain deep (few nodes
per ring) instead of fanning wide.

Fix, same day: each ring's radius is now the max of three terms — the depth
formula (unchanged for existing shapes), a **population constraint**
(Σ measured node widths + a node gap each, ÷ 2π), and a **monotonicity
floor** (a crowded inner ring pushes the next ring out rather than letting
it collapse back inside). `radialBoard`, `treeBoard`, and `swimlaneBoard`
outputs are unchanged at every scale; only genuinely wide rings move. Full
suite green (2,547 tests across six workspaces).

## The baseline (median of 3, 2026-09-12)

Mechanical ladder (established columns per the 2026-09-11 vocabulary, new
columns in the four right-most before ms):

| board                          | nodes  | edges  | cross    | ovlp | thru | eMean    | eP95       | bend | cov       | coh       | ms      |
| ------------------------------ | ------ | ------ | -------- | ---- | ---- | -------- | ---------- | ---- | --------- | --------- | ------- |
| layered (flowchart/arch)       | 20     | 24     | 36       | 0    | 4    | 345      | 941        | 0.75 | 0.23      | —         | 1.7     |
| layered                        | 40     | 55     | 24       | 0    | 14   | 225      | 314        | 1.05 | 0.19      | —         | 6.0     |
| layered                        | 80     | 124    | 119      | 0    | 21   | 298      | 461        | 0.22 | 0.33      | —         | 4.7     |
| layered                        | 150    | 239    | 240      | 0    | 40   | 320      | 655        | 0.20 | 0.31      | —         | 8.1     |
| layered                        | 300    | 512    | 571      | 0    | 84   | 323      | 655        | 0.20 | 0.31      | —         | 14.5    |
| layered                        | 500    | 844    | 902      | 0    | 128  | 318      | 655        | 0.19 | 0.31      | —         | 22.4    |
| dense (fan-in 2–3)             | 20     | 41     | 66       | 0    | 21   | 252      | 370        | 0.98 | 0.20      | —         | 1.5     |
| dense                          | 40     | 88     | **988**  | 0    | 50   | 526      | 1708       | 1.07 | 0.23      | —         | 5.0     |
| dense                          | 80     | 195    | 696      | 0    | 116  | 281      | 411        | 1.20 | 0.17      | —         | 11.6    |
| dense                          | 150    | 374    | 1340     | 0    | 217  | 281      | 461        | 1.15 | 0.16      | —         | 22.1    |
| dense                          | 300    | 791    | 4431     | 0    | 485  | 336      | 655        | 1.21 | 0.16      | —         | 45.5    |
| dense                          | 500    | 1338   | **8396** | 0    | 948  | 369      | 755        | 1.20 | 0.16      | —         | 77.9    |
| adversarial (diamonds+cycles)  | 20     | 29     | 66       | 0    | 8    | 353      | 1090       | 0.72 | 0.27      | —         | 0.6     |
| adversarial                    | 40     | 69     | 125      | 0    | 23   | 246      | 461        | 0.99 | 0.19      | —         | 3.8     |
| adversarial                    | 80     | 140    | 239      | 0    | 47   | 281      | 557        | 0.64 | 0.22      | —         | 3.9     |
| adversarial                    | 150    | 273    | 620      | 0    | 97   | 251      | 461        | 1.26 | 0.17      | —         | 16.6    |
| adversarial                    | 300    | 520    | 1341     | 0    | 174  | 248      | 461        | 1.52 | 0.16      | —         | 59.4    |
| adversarial                    | 500    | 877    | 2377     | 0    | 308  | 333      | 655        | 0.60 | 0.24      | —         | 39.1    |
| long-edge (deep spine)         | 20     | 8      | 4        | 0    | 3    | 534      | 1522       | 0.38 | 0.11      | —         | 0.4     |
| long-edge                      | 40     | 16     | 2        | 0    | 6    | 743      | 2297       | 0.56 | 0.05      | —         | 1.0     |
| long-edge                      | 80     | 30     | 4        | 0    | 11   | 1292     | 4892       | 0.60 | 0.02      | —         | 1.6     |
| long-edge                      | 150    | 57     | 21       | 0    | 14   | 1465     | 8842       | 0.75 | 0.01      | —         | 4.4     |
| long-edge                      | 300    | 113    | 10       | 0    | 42   | 3241     | 16849      | 0.65 | 0.01      | —         | 9.1     |
| long-edge                      | 500    | 188    | 18       | 0    | 67   | 4147     | 27353      | 0.65 | 0.00      | —         | 18.3    |
| mixed regions (mind+tree+flow) | 20     | 18     | 0        | 0    | 1    | 485      | 2617       | 0.00 | 0.05      | 0.15      | 0.4     |
| mixed regions                  | 40     | 38     | 0        | 0    | 1    | 453      | 737        | 0.00 | 0.03      | 0.08      | 1.0     |
| mixed regions                  | 80     | 78     | 2        | 0    | 1    | 461      | 719        | 0.00 | 0.02      | 0.04      | 1.7     |
| mixed regions                  | 150    | 148    | 1        | 0    | 1    | 519      | 719        | 0.00 | 0.01      | 0.03      | 2.1     |
| mixed regions                  | 300    | 298    | 1        | 0    | 1    | 631      | 1324       | 0.00 | 0.01      | 0.02      | 4.3     |
| mixed regions                  | 500    | 498    | 2        | 0    | 1    | 756      | 2218       | 0.00 | 0.00      | 0.01      | 7.4     |
| radial (mind map)              | 20→500 | 19–499 | 0        | 0    | 0    | 457–504  | 381–2116   | 0.00 | 0.00–0.01 | —         | 0.1–1.3 |
| tree (decision/org)            | 20→500 | 19–499 | 0        | 0    | 0    | 342–613  | 805–1883   | 0.00 | 0.07–0.14 | —         | 0.1–2.1 |
| swimlane (process)             | 20→500 | 21–627 | 0        | 0    | 0–2  | 405–3111 | 1140–21281 | 0.00 | 0.05–0.18 | 0.02–0.24 | 0.2–2.5 |

Movement after edit (probe node → highest-degree anchor):

| board         | nodes | full moved | full identical | full max dx | region out | region in |
| ------------- | ----- | ---------- | -------------- | ----------- | ---------- | --------- |
| layered       | 100   | 10         | 90             | 104px       | n/a        | n/a       |
| layered       | 200   | 15         | 185            | 104px       | n/a        | n/a       |
| dense         | 100   | 4          | 96             | 104px       | n/a        | n/a       |
| dense         | 200   | **83**     | 117            | 624px       | n/a        | n/a       |
| adversarial   | 100   | 12         | 88             | 208px       | n/a        | n/a       |
| adversarial   | 200   | 16         | 184            | 208px       | n/a        | n/a       |
| long-edge     | 100   | 19         | 81             | 624px       | n/a        | n/a       |
| long-edge     | 200   | 31         | 169            | 832px       | n/a        | n/a       |
| mixed regions | 100   | 70         | 30             | 189px       | **0**      | 40        |
| mixed regions | 200   | 140        | 60             | 189px       | **0**      | 80        |
| radial        | 100   | 5          | 95             | 277px       | n/a        | n/a       |
| radial        | 200   | 5          | 195            | 277px       | n/a        | n/a       |
| tree          | 100   | 61         | 39             | 520px       | n/a        | n/a       |
| tree          | 200   | 82         | 118            | 1274px      | n/a        | n/a       |
| swimlane      | 100   | 0          | 100            | 0px         | **0**      | 0         |
| swimlane      | 200   | 0          | 200            | 0px         | **0**      | 0         |

## What the baseline says

1. **Density is the layered engine's exposed flank.** The plain layered
   ladder holds ~1 crossing per edge at 500 nodes (the V5 resolution's
   number), but fan-in 2–3 with same-layer peers explodes it: 988 crossings
   at just 40 nodes, 8,396 at 500 — ~6.3 crossings per edge. The barycenter
   ordering pass degrades faster than linearly as fan-in rises. **This is
   precisely the workload an alternative layered engine claims to win, and
   the number the ELK comparison (doc 18, Phase 2) must beat.**
2. **Routes exist but corridors don't clear the cards.** Even with routing
   applied, 948 of dense-500's 1,338 edges pass through a foreign node box,
   and 128 of layered-500's do. The bend count shows corridors are being
   built (~1.2 bends/edge on dense); they just aren't avoiding nodes. A
   routing pass that treats node boxes as obstacles is an open, measured
   gap — orthogonal to which engine ranks the rows.
3. **The region-scoped commit path is exactly as additive as ADR 0015
   claims.** `region out = 0` on every region board at every scale — by
   construction, and now pinned in tests. The inside-the-region movement is
   real but bounded (40–80 members when the mind region gains one node —
   the radial re-ring). Whole-board relayout, the worst case, moves up to
   83 of 200 nodes (dense) — the number a whole-graph engine would impose
   on every commit, and the reason the incremental policy (doc 18, Phase 4)
   is non-negotiable.
4. **Long edges route well when the wrap gate stays off**: 18 crossings at
   500 nodes across spans up to 27k px — the corridor routing does its job
   on the deep spine. Coverage is inherently low on such boards (0.00–0.05:
   a spine is mostly empty canvas), which is honest, not a defect.
5. **Mixed-region boards are near-perfect**: ≤2 crossings at every scale,
   regions packed as a band, board flow intact. ADR 0014's partition path
   scales.

## Deliberately not measured here

10-second comprehension, manual-cleanup time, preference, and render/
interaction latency — human/DOM instruments owned by the live eval protocol.
The next live pass should score the new workloads (especially dense-40,
whose 988 crossings are the worst mechanical readability number on record)
against these tables.

## What this is FOR

- The ELK comparison (Phase 2) runs **these exact fixtures** through a
  candidate engine behind the Phase 1 boundary and compares this exact
  table, movement table included.
- Any layout change now regresses against eight columns, not four, and
  against a pinned spatial-additivity invariant.
- The engine-selection bar (doc 18, Phase 3) now has its reference numbers:
  beat ~6.3 crossings/edge on dense, ~1.07 on layered at 500, zero overlaps
  everywhere, region out = 0, without paying the 83/200-movement cost.
