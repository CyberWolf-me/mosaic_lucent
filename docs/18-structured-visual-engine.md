# 18. Structured Visual Engine — the phased plan

> **Status (2026-09-12):** this document operationalizes the 2026-09
> visual-engineering advisory ("Stage V — Structured Visual Engine") into
> nine evidence-gated phases, written against what the repo actually has.
> The advisory's baseline phase is already half-shipped, and several later
> items are further along than the advisory assumed. Phases 0–2 are
> measurement and are legal under the docs/17 freeze today; every build
> phase opens only through its gate.
>
> **Progress:** Phase 0's mechanical half is complete (fixtures, metrics,
> movement harness, one engine defect found and fixed: radial rings sized by
> depth, not population) — see
> [`eval-results/2026-09-12-visual-baseline-phase0.md`](./eval-results/2026-09-12-visual-baseline-phase0.md).
> The human-half live pass is pending. Phase 1 is complete: the
> `DiagramLayoutEngine` boundary lives in
> `packages/core/src/layoutEngine.ts` with the built-in engine behind it
> (`CURRENT_LAYOUT_ENGINE` in `layout.ts`), runner and pins go through it,
> and the ladder output is byte-identical (modulo timing). Phase 2 is
> complete: the ELK candidate ran the identical ladder behind the boundary —
> it wins every flat graph family (48% fewer crossings on dense, routes that
> clear every node box) and loses outright on swimlane, radial, and
> mixed-region boards, at 20–400× the compute cost; no adoption decision is
> made — see
> [`eval-results/2026-09-12-elk-comparison.md`](./eval-results/2026-09-12-elk-comparison.md).
> Phase 3 (the gate) awaits the human-half pass.

## Why this document exists

The advisory's thesis: Lucent's problem is no longer "make the nodes
connect" — it is **generate professional structured diagrams, not merely
graphs**. Its correction to our earlier stance is accepted and recorded:

> Don't adopt ELK because it is famous. Adopt it because it wins Lucent's
> benchmark. "Don't add ELK" was never the right rule; "don't replace the
> engine until the benchmark proves the replacement is better" is.

What makes this the right moment is that the measurement apparatus the
advisory demands already exists, and it has already decided one question:

- [`packages/core/src/visualBenchmark.ts`](../packages/core/src/visualBenchmark.ts)
  — crossings, node overlaps, edge-length mean/p95/per-node, offscreen
  entries, layout ms. Pure geometry over a laid-out workspace: no DOM, the
  same vocabulary in vitest, CI, and the live browser pass.
- [`packages/core/src/benchmarkBoards.ts`](../packages/core/src/benchmarkBoards.ts)
  — four deterministic generators shaped like each strategy's real workload
  (layered DAG with skip + return edges; radial mind map with cross-links;
  ternary tree; swimlanes with handoffs). Pure functions of (n, seed): a
  metric change is a layout change, never a fixture roll.
- [`scripts/visual-benchmark.ts`](../scripts/visual-benchmark.ts) — the
  20/40/80/150/300/500 ladder, median-of-3.
- [`docs/eval-results/2026-09-11-visual-benchmark-baseline.md`](./eval-results/2026-09-11-visual-benchmark-baseline.md)
  — the baseline, plus the same-day V5 resolution: cycle-safe layering, the
  wrap gate, and routed long edges (`Edge.route` bend points) took the
  layered ladder from ~12.9 crossings per edge at 500 nodes to ~1.07, with
  edge lengths down 4–26×. Radial, tree, and swimlane hold zero crossings
  at every scale.

The baseline report closes by naming the exact next experiment the advisory
proposes: the remaining mechanical gap is **barycenter ordering quality on
dense rows** — precisely what a serious layered engine claims to solve. The
benchmark exists; the decision has its procedure. This document gives that
procedure phases, gates, and acceptance criteria.

## The rule (ADR 0038)

Everything below operates inside one boundary decision, recorded as
[ADR 0038](./adr/0038-diagram-engines-own-geometry.md):

> **Lucent owns semantic state. A diagram engine owns representation-specific
> geometry and interaction, behind a boundary Lucent defines. No engine
> becomes canonical workspace state, and no engine may bypass the validated
> operation protocol.**

Standing rules inherited unchanged: the AI never supplies coordinates for
the semantic graph (the layout engine owns position/size); every AI action
stays reversible; major operations stay behind human approval;
`@lucent/core` stays framework-agnostic. The advisory's own formulation —
**AI says WHAT, the engine decides WHERE, the renderer decides HOW IT
LOOKS** — is a restatement of doctrine we already enforce, now extended to
cover external engines.

## Where the advisory meets the repo

The advisory numbered its items V0–V30. Several are already built or well
started; the phases below reference them as "source V-xx".

| Advisory item | Status in Lucent | Where |
| --- | --- | --- |
| V0 benchmark corpus + baseline | **Mostly done** | `visualBenchmark.ts`, `benchmarkBoards.ts`, `scripts/visual-benchmark.ts`, the 2026-09-11 baseline report |
| V1 layout adapter boundary | Not started; seams exist | `computeLayout` / `computeLayoutWithRoutes`; `relayoutRegion*` (ADR 0015) |
| V2–V3 ELK PoC + comparison | Not started; procedure ready | the baseline report's closing names this exact experiment |
| V4 adoption decision | Gate, not built | Phase 3 below |
| V5 web worker | Not started; compute is ≤17 ms at 500 nodes | conditional on a candidate engine's measured cost |
| V6 incremental layout | Seam exists; engine-specific policy not | `relayoutRegionWithRoutes`; node pinning via MOVE_NODE |
| V7 diagram intent | Partial | `SET_GROUP_KIND` / `CREATE_DIAGRAM` / `TRANSFORM_DIAGRAM` carry family; no direction / primary-flow hints yet |
| V8 relationship hierarchy | **Derivation done** | `edgeTiers.ts` — primary / secondary / quiet, deterministic |
| V9 density + semantic zoom | Partial | region lenses (ADR 0014); the tier-driven zoom policy is stated in `edgeTiers.ts` — verify renderer consumption |
| V10 routing styles | Partial | orthogonal corridor routing for long edges shipped (`Edge.route`); per-family choice not |
| V11–V16 BPMN | Not started | Option A (derived projection) is the default |
| V17 unified lenses | **Exists for graph families** | ADR 0014, the lens workstream |
| V18–V19 AI chooses the family | Partial | `CREATE_DIAGRAM` / `TRANSFORM_DIAGRAM` are already validated operations |
| V20–V30 hardening items | Distributed | folded into Phases 5–8 below |

The checklist's "Not built (recorded in ADR 0015): … ELK/dagre" line is
superseded by this document's gate procedure: ELK is no longer excluded —
it is *conditional*, on the benchmark and on ADR 0038's clauses.

## The metric vocabulary

Every decision in every phase argues from two halves, and a decision wants
both:

- **Mechanical** (deterministic, owned by `visualBenchmark.ts`): crossings,
  node overlaps, edge-length mean/p95/per-node, offscreen entries, layout
  ms. Layout time is recorded and never the success criterion. Phase 0
  adds: edge bends per edge, a label-overlap estimate, cluster cohesion
  (intra-region vs cross-region edge-length ratio), viewport coverage, and
  movement-after-edit for the incremental test.
- **Human** (live eval protocol, `docs/eval-results/`): 10-second
  comprehension, manual-cleanup time, preference — plus render time and
  interaction latency, which need a DOM and belong to the live pass, never
  to the deterministic harness.

Each phase's outcome is recorded under `docs/eval-results/` in the style of
the 2026-09-11 baseline report: the numbers, the decision, and what was
deliberately not measured.

## The phases

The advisory condensed its 30 items into eight milestones; this plan keeps
nine phases, because the baseline (its V0) is a milestone of its own and is
already half-finished.

### Phase 0 — Complete the baseline (measurement; legal under the freeze now)

**Goal:** finish the corpus the advisory demands, so the ELK comparison and
every later phase argue from complete numbers.

1. Extend `benchmarkBoards.ts` with the missing workloads: an adversarial
   board (cycles + multi-parent + diamonds), a dense board (150–300 nodes,
   300–600 edges), a mixed multi-region board (several kind-regions on one
   board — ADR 0014's real shape), and a long-edge ladder (the deliberate
   far-target case).
2. Extend `visualBenchmark.ts` with the five new metrics listed above.
3. Run the human-half live pass on the same fixtures — 10-second
   comprehension, manual cleanup, preference, render/interaction latency —
   and record it.
4. Re-run the full ladder and commit the updated baseline table.

**Acceptance:** the baseline table exists at every size with every metric,
mechanical and human, committed under `docs/eval-results/`.

**Source:** advisory V0.

### Phase 1 — The layout-engine boundary (core-only, zero behavior change)

**Goal:** one contract that both the current engine and any candidate
implement, so the comparison is apples-to-apples and later swaps are
configuration, not surgery. This phase is the experiment's apparatus: the
freeze's "architecture would be cleaner" objection does not apply, because
without the boundary the ELK comparison would patch call sites instead of
engines.

1. New `packages/core/src/layoutEngine.ts`:

```ts
interface DiagramLayoutEngine {
  readonly id: string;
  supports(request: DiagramLayoutRequest): boolean;
  layout(request: DiagramLayoutRequest): DiagramLayoutResult;
}
```

   The request carries the semantic snapshot (nodes, edges, groups), pinned
   positions, direction, spacing, and diagram family. The result carries
   node positions and sizes, edge routes (the `Edge.route` precedent), and
   diagnostics. **The interface owns geometry and nothing else** — it never
   mutates the workspace, never touches Lucent state, and returns geometry.
2. `CurrentLayoutEngine` implements the boundary over `computeLayout` /
   `computeLayoutWithRoutes`; the existing public API stays.
3. The benchmark runner, the pins, and the region relayout path
   (`relayoutRegion*`) go through the boundary.

**Acceptance:** `npx tsx scripts/visual-benchmark.ts` produces
byte-identical output before and after; typecheck and the full suite green;
no engine-specific types anywhere outside the boundary module.

**Source:** advisory V1.

### Phase 2 — The ELK comparison (the decision experiment)

**Goal:** answer "is ELK better for Lucent's graph workloads?" with the
benchmark, on the record.

1. Add `elkjs` as a `@lucent/web` dependency; the adapter lives at
   `packages/web/src/diagram/elk/` from day one — that is also where it
   would run in production, since layout executes where the canvas runs.
   The benchmark runner imports the adapter from there. `@lucent/core`
   never gains the dependency and never sees an ELK type (ADR 0038).
2. Implement `ElkLayoutEngine` behind the Phase 1 boundary. Mapping: Node →
   ELK child, Edge → ELK edge, Group → ELK compound node, ELK bend points →
   `Edge.route`. One adapter file; ELK types do not leave it.
3. Run the identical ladder — same fixtures, same seeds, same metrics —
   plus the human-half pass on both engines' outputs.

**Acceptance:** one comparison report under `docs/eval-results/` with the
same table columns as the baseline, both engines side by side, and a stated
per-family verdict: where ELK wins, where it loses, by how much.

**Source:** advisory V2, V3.

### Phase 3 — The adoption decision (gate)

**Goal:** decide, on evidence, and record the decision. The three outcomes
and their consequences:

| Result | Meaning | What happens |
| --- | --- | --- |
| **A — significantly better** | wins the layered ladder materially, ties or wins elsewhere, human pass agrees | ELK becomes the primary graph-layout engine behind the boundary; Phase 4 opens |
| **B — better for some families** | e.g. layered/architecture only | hybrid: ELK for those families; the hand-written engine keeps radial, tree, and swimlane, which already hold zero crossings at every scale |
| **C — not enough** | the current engine keeps the crown | keep the hand-written engine; Phases 4+ close; revisit only when a new failure class is on record |

The bar, stated **before** the numbers exist so the goalposts cannot move:
materially fewer crossings per edge at 150–500 nodes (the known barycenter
gap), no overlap regressions anywhere, layout cost within the interactive
budget, and the human pass preferring ELK's output or tying.

Freeze compatibility: this is exactly docs/17's rule that measurement never
stops and building is evidence-gated. Nothing in Phase 3 spends the
freeze's credibility — it spends fixtures.

**Source:** advisory V4.

### Phase 4 — Production integration (only on adoption)

Ordered tasks, each with its own acceptance:

1. **Incremental policy — the Lucent-specific layer.** The candidate
   engine's constraint facilities integrated with the
   `relayoutRegionWithRoutes` seam: new operation → determine affected
   region → construct affected subgraph → layout that subgraph → merge into
   existing geometry. Pinned and user-moved nodes never move.
   **Acceptance (the advisory's most important test):** generate a
   100-node architecture, add one node — the new node moves, a small
   affected neighborhood may move, **≥98 existing nodes are
   pixel-identical**. Repeat.
2. **Web worker, conditional on measurement.** Current compute is ≤17 ms at
   500 nodes; a worker earns its complexity only if the adopted engine's
   cost breaches the interactive budget (main-thread blocks > 50 ms at
   benchmark scales). If needed: worker-based execution so the UI never
   freezes during layout. If not needed: record why and skip.
3. **Failure behavior.** Engine failure retains the previous geometry and
   shows "Layout couldn't be updated" with retry — never a blank canvas.
   The same reliability standard the provider layer is held to.
4. **Version pinning + geometry regression.** Pin the engine's version;
   golden geometry fixtures on representative boards; an upgrade must
   regenerate goldens deliberately — a dependency bump must never silently
   rearrange existing boards.

**Source:** advisory V5, V6, V27, V28.

### Phase 5 — Intent, density, and routing (graph families)

**Goal:** stop treating every node and every edge as equivalent; let
structure drive representation. Independent of the ELK verdict — these are
engine-agnostic layers over the boundary.

1. **Intent hints.** Validated operation fields for direction, primary
   flow, and emphasis. The AI says WHAT; the engine decides WHERE.
   Coordinates stay out of the semantic graph's operations — unchanged
   doctrine, now with a positive form: the AI may state intent, never
   position.
2. **Relationship hierarchy at scale.** `edgeTiers.ts` already derives
   primary / secondary / quiet deterministically and for free (no AI
   input, no model change). Verify the renderer's zoom-dependent
   consumption and complete it where missing: overview scale shows primary
   structure; secondary and quiet edges subdue. This — not smaller
   connectors — is the answer to "too many connectors, nothing is visible."
3. **Density policy.** The five bands as renderer behavior driven by groups
   and tiers — semantic hierarchy, not pixel thresholds: 1–30 full detail;
   30–80 stronger grouping; 80–150 regions visually dominant; 150–300
   overview representation; 300+ semantic overview with progressive
   disclosure.
4. **Routing per family.** Orthogonal / polyline / spline chosen per
   diagram family from the benchmark, never forced globally.

**Acceptance:** family fixtures at each density band meet the readability
metrics; intent hints change layout deterministically; no AI-emitted
operation carries a coordinate.

**Source:** advisory V7, V8, V9, V10, V20, V22.

### Phase 6 — The BPMN lens, read-only (license-gated)

**Entry gate — licenses before code.** ELK is EPL-2.0 (relevant only if
adopted in Phase 3/4). bpmn-js is MIT **with a condition: the bpmn.io
watermark in rendered diagrams must remain visible and unobscured.** In a
commercial Lucent UI that is a product decision, not a footnote. Review it
first; if the watermark is unacceptable, BPMN stops here and this phase
records that decision.

**Goal:** prove Lucent can speak a true structured visual language —
without introducing a second editing state.

1. **Define the supported subset explicitly:** StartEvent, EndEvent, Task,
   Gateway, SequenceFlow, Pool, Lane — with an equally explicit deferred
   list (timer/message/signal events, event sub-processes, compensation,
   choreography, conversation). No "Lucent supports BPMN" claim beyond the
   subset.
2. **Build the BPMN adapter:** a process region's workspace → BPMN 2.0
   model/XML. **Option A — derived projection:** the workspace stays the
   only canonical state; XML is recomputable output, like `Edge.route`. A
   native BPMN canonical model (Option B) exists only if users genuinely
   need semantics that cannot survive round-tripping — and the burden of
   proof sits with Option B.
3. **Ship the read-only bpmn-js viewer lens** over a process region
   (ADR 0014's lens mechanism). It proves mapping, visual quality, BPMN
   correctness, rendering performance, and user value — with no editing
   path and therefore no second state to reconcile.

**Acceptance:** a process region renders correctly in the BPMN lens for the
subset; the workspace remains the only editable truth; the subset
definition ships in `docs/`.

**Source:** advisory V11, V13, V15, V16 — plus the license review (V29),
pulled forward because it gates whether this phase may ship at all.

### Phase 7 — The BPMN editing bridge (only after the read-only lens proves out)

**Goal:** enable editing without an unvalidated back door.

1. **Every write is an operation.** bpmn-js modeler events → BPMN adapter →
   **Lucent operations** → validator → workspace → the BPMN projection
   re-renders. Nothing writes bpmn-js internal state directly; every user
   change lands as an auditable operation (ADR 0005) riding the same
   history, undo, op log, and broadcast as every other change (ADR 0001).
2. **Multiplayer verification.** Two clients: an edit in the BPMN lens
   propagates through the server op log — never through engine-internal
   state "magically synchronizing."
3. **AI generation.** "Create a BPMN process for customer onboarding"
   emits the same validated operations that produce real BPMN semantics —
   conversation → semantic process → BPMN lens. No free-text XML anywhere,
   and no "rectangles and arrows pretending to be BPMN."
4. **Round-trip.** BPMN 2.0 XML → Lucent for the supported subset
   (import), and Lucent → XML (export), stable across the round trip.

**Acceptance:** every modeler edit appears as an operation in the log;
two-client consistency holds; the subset round-trips.

**Source:** advisory V12, V14, V18, V19, V24, V25 (BPMN half).

### Phase 8 — Unified lenses and final acceptance

**Goal:** one workspace, many representations, one interaction model — and
the proof.

1. **The lens picker** offers BPMN beside the graph families; every lens is
   a representation of the same workspace (ADR 0014's promise, extended to
   its conclusion). This addresses the UX audit's "too many destinations"
   concern the advisory cites.
2. **Cross-engine interaction consistency:** selection, zoom, pan, undo,
   redo, copy, navigation, AI prompt, provenance, comments behave
   identically regardless of which engine produced the geometry. The
   diagram engine is an implementation detail; the Lucent interaction
   model is not.
3. **Visual diff for major transformations:** added / removed / moved /
   connected, before → after, reviewable before acceptance — the human
   gate made visual.
4. **Export verification:** SVG / PNG / PDF / JSON with engine-generated
   geometry; BPMN 2.0 XML for the supported subset.
5. **Production performance thresholds** recorded — simple < 100 ms,
   medium < 500 ms, large < 2 s layout, very large progressive/background;
   targets to tune, never assumed guarantees.
6. **Final acceptance — the advisory's scripted conversation** (the
   subscription-product launch: sign-up, verification, plan choice,
   Stripe payment, access; Sarah owns marketing; engineering finishes the
   payment service before QA) produces, from one conversation: the
   architecture lens (graph engine), the process lens, the BPMN lens
   (bpmn-js), the intelligence summary (decision / actions / risk), and
   the execution view — all representations of one underlying
   understanding.

**Acceptance:** the scripted conversation passes under the standard eval
protocol; the consistency checklist is signed off.

**Source:** advisory V17, V18, V19, V21, V23, V26, V30.

## What we are explicitly not doing

- Not adopting ELK for its reputation — only through the Phase 3 gate.
- Not replacing radial, tree, or swimlane engines that hold zero crossings
  at every scale without evidence they lost.
- Not giving bpmn-js — or any engine — a write path that bypasses validated
  operations.
- Not creating a second source of truth: no native BPMN canonical state
  (Option A first; Option B only on proven round-trip failure).
- Not letting `@lucent/core` take ELK or bpmn-js dependencies, or any
  engine's types leak past its adapter.
- Not starting BPMN before the license answer, or its editing bridge before
  its read-only lens.

## Sequencing

| Phase | Depends on | Opens how |
| --- | --- | --- |
| 0 — baseline completion | — | legal now (freeze clause: benchmarks and measurement) |
| 1 — layout boundary | 0's metrics pinned | legal now (the experiment's apparatus) |
| 2 — ELK comparison | 1 | legal now (measurement) |
| 3 — adoption decision | 2 | evidence gate |
| 4 — integration | 3 = Result A or B | build opens on the gate |
| 5 — intent / density / routing | 0's metrics; independent of the ELK verdict | build opens on the gate |
| 6 — BPMN read-only | license review; benefits from Phase 5's density work | build opens on the gate |
| 7 — BPMN editing bridge | 6 | build opens on the gate |
| 8 — lenses + final acceptance | the outcomes of 3–7 | final gate |

Phases 5 and 6 do not wait on the ELK verdict: intent, tiers, and density
are engine-agnostic and partly exist already. Their completion is warranted
by the same readability evidence regardless of which engine produces the
geometry.
