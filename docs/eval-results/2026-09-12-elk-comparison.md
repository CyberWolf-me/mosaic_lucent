# ELK comparison — Phase 2 (2026-09-12, doc 18)

> **Status: the Phase 2 decision experiment is complete, and the mechanical
> half of the Phase 3 bar is answered: ELK's layered engine beats ours on
> every flat graph family — decisively on dense, the known weak flank — while
> losing outright on swimlane, radial, and mixed-region boards, at 20–400×
> the compute cost. The human-half pass is pending, so per doc 18's own rule
> **no adoption decision is made yet**; this report is the evidence the
> Phase 3 gate will rule on.**

## Method

- Same fixtures, same seeds, same ladder (20/40/80/150/300/500, median of 3)
  as the Phase 0 baseline, run through the Phase 1 `DiagramLayoutEngine`
  boundary: `npx tsx scripts/visual-benchmark.ts [--engine=elk] --json`
  (an ELK run needs `--conditions=development` so `@lucent/core` resolves to
  source).
- Candidate: `elkjs` 0.12 behind the adapter at
  `packages/web/src/diagram/elk/elkLayoutEngine.ts` — ELK types confined to
  the adapter (ADR 0038). Node boxes sized by the same `measureNode` the
  built-in engine uses; groups become ELK compound nodes
  (`INCLUDE_CHILDREN`); algorithm per kind: layered families → `elk.layered`,
  mind map → `elk.force`, trees → `elk.mrtree`, process → `elk.layered` (ELK
  has no swimlane layout).
- Both engines measured identically: node boxes measured, edge polylines
  drawn as anchor → waypoints → anchor, the Phase 0 metric set, engine-call
  timing.

**Two harness defects were found and fixed while building this comparison**
(both are the kind of thing the experiment exists to catch, recorded here
because they change what earlier numbers mean):

1. The runner measured a _recompute_, not the engine's geometry:
   `measureVisualMetrics(routed)` without the pre-supplied layout re-runs the
   built-in engine over the stamped workspace. Invisible for the
   self-consistent default engine (the Phase 0 baseline is unaffected —
   verified against the report's numbers), garbage for any candidate engine.
   The runner now measures the engine's stamped geometry and times the
   engine call itself.
2. ELK compound children report coordinates relative to their parent; the
   adapter now accumulates container offsets, and edge routes carry full
   section paths (start → bends → end) rather than bends alone.

## The comparison (nodes = 500 except where noted)

| board                          | ours cross / thru / eMean / ms | ELK cross / thru / eMean / ms       |
| ------------------------------ | ------------------------------ | ----------------------------------- |
| layered (flowchart/arch)       | 902 / 128 / 318 / 29.6         | **833** / **0** / **230** / 868.8   |
| dense (fan-in 2–3)             | 8396 / 948 / 369 / 58.7        | **4350** / **0** / **335** / 1984.8 |
| adversarial (diamonds+cycles)  | 2377 / 308 / 333 / 16.9        | **1034** / **0** / **201** / 1113.9 |
| long-edge (deep spine)         | 18 / 67 / 4147 / 7.4           | **0** / **0** / **109** / 142.2     |
| mixed regions (mind+tree+flow) | **2** / **1** / **756** / 3.7  | 6456 / 199 / 7963 / 242             |
| radial (mind map)              | **0** / **0** / **501** / 0.7  | 1810 / 106 / 2284 / 67918.6         |
| tree (decision/org)            | 0 / 0 / 613 / 1.6              | 0 / 0 / **127** / 186.3             |
| swimlane (process)             | **0** / 128 / **3111** / 0.9   | 118300 / 396 / 8104 / 1295.9        |

At 150 nodes the shape is the same: layered 240→**156**, dense 1340→**697**,
adversarial 620→**296**, long-edge 21→**0**, tree 0→0; mixed **1**→477,
radial **0**→521, swimlane **0**→7652. At 40 nodes: dense 988→**87** (11×),
layered 24→**14**, adversarial 125→**49**; radial **0**→74, swimlane
**0**→422.

Full tables are regenerable with the two runner commands above (add `--json`
to both).

## What the comparison says

1. **ELK's layered ordering + orthogonal routing beats ours on every flat
   graph family.** The margin is 8% on plain layered at 500 nodes, but it
   grows with difficulty: 48% on dense (our measured weak flank), 56% on
   adversarial, and total on long-edge (0 crossings, mean edge 109 px vs
   our 4147 — ELK compacts the deep spine instead of stretching it).
2. **ELK's routes clear the cards entirely.** Through-node edges: 0 in
   every flat family, against our 128–948 at 500 nodes. On our engine that
   gap was the biggest open readability finding in Phase 0; ELK simply
   doesn't have it. (Tree ties on crossings; ELK additionally compacts the
   board to a quarter of the edge length.)
3. **ELK loses where structure is not a plain graph.** Swimlane is
   catastrophic (118k crossings — lanes as compound containers under
   `elk.layered` with handoff edges is the wrong shape), the mind map's
   force layout crosses what our radial never does, and the mixed-region
   board — ADR 0014's real shape — degrades badly through compound
   handling. Our hand-written engines keep their crowns here, consistent
   with the Phase 0 finding that they hold zero crossings at every scale.
4. **The cost is real but worker-shaped.** ELK is 20–400× slower
   (0.87 s at layered-500; **68 s** on the force mind map at 500). Main-thread
   ELK is outside the interactive budget; the Phase 4 web-worker step is
   therefore not optional if ELK is adopted for graph families. Our engine's
   ≤30 ms at 500 nodes remains the interaction baseline.
5. **A renderer-model caveat, on record:** ELK routes anchor at node
   _borders_; Lucent's renderer draws centre-anchored polylines
   (`Edge.route` between node centres). The comparison measures ELK's
   routes stamped into Lucent's model — which is what adoption would mean
   today. The measured polyline keeps the orthogonal path (full section
   points), and the through-node advantage survives that mapping; a Phase 4
   integration should decide deliberately whether border-anchored drawing
   replaces the centre-anchored model for ELK-laid boards.

## Verdict against the Phase 3 bar

| Bar (doc 18, stated before numbers)                  | Result                                                                                                            |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Materially fewer crossings per edge at 150–500 nodes | **Met for flat graph families** (8–56%, decisive on dense/long-edge); not met for radial, swimlane, mixed regions |
| No overlap regressions                               | **Met** — zero overlaps everywhere for both engines                                                               |
| Layout cost within the interactive budget            | **Not met on the main thread** — 20–400× cost; viable only as the Phase 4 worker path                             |
| The human pass prefers or ties ELK's output          | **Pending** — live-protocol item                                                                                  |

Per doc 18's own rule, this is **Result B's shape, undecided**: ELK for
graph/architecture families, the hand-written engines retained for radial,
tree, swimlane, and mixed-region boards — but the gate does not open until
the human-half pass scores the same fixtures, and until the Phase 4 cost
(worker, incremental policy, pinned-position support, renderer-model
decision) is scoped. Nothing is adopted by this report; the baseline tables
stand as the record any future decision argues against.

## Deliberately not compared here

Incremental behavior (movement after edit) — the sync harness cannot drive
an async engine's relayout; the Phase 4 incremental policy is where an ELK
"100 nodes + 1" test would live. Pinned-position support likewise does not
exist in the adapter (the fixtures carry none).
