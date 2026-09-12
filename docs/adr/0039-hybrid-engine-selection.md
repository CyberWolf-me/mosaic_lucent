# ADR 0039: The hybrid engine selection (Stage V, Phase 3)

Date: 2026-09-12
Status: accepted — **provisional on the human-half pass** (see the condition
clause; this ADR is superseded, not edited, if that pass fails)

## Context

The Phase 2 ELK comparison
(`docs/eval-results/2026-09-12-elk-comparison.md`) answered the mechanical
half of the Phase 3 bar from `docs/18-structured-visual-engine.md`:

- ELK's layered engine beats the hand-written one on **every flat graph
  family** — dense 4,350 vs 8,396 crossings at 500 nodes (48% better),
  adversarial 56% better, long-edge 0 vs 18 with 37× shorter mean edges,
  and zero edges through foreign node boxes where ours cuts 128–948.
- It **loses outright** on swimlane (118,300 crossings — no swimlane
  algorithm), mind maps (1,810 vs our 0), and mixed-region boards
  (6,456 vs our 2) — the shapes our hand-written engines hold at zero.
- The cost is 20–400× (0.87 s at layered-500, 68 s on the force mind map) —
  main-thread ELK is outside the interactive budget; a worker path is
  mandatory for any production use.
- The human-half pass (10-second comprehension, cleanup, preference) is
  **pending**; per doc 18's pre-stated bar, the gate cannot fully open
  without it.

ADR 0038's clause 4 requires adoption to be earned by measurement and never
by reputation; doc 17's freeze requires user evidence for new engineering.
The product owner has directed that implementation proceed now, with the
human-half passes batched at the end — this ADR records that decision with
its condition made explicit.

## Decision

**Result B — the hybrid selection:**

1. **ELK serves the flat graph families**: whole-board layout and region
   relayouts for boards and regions whose diagram kind is `flowchart`,
   `architecture`, or `journey`.
2. **The hand-written engines keep everything else**: `mindmap` (radial),
   `decisiontree`/`orgchart` (tidy-tree), `process` (swimlane), and any
   mixed-region board — where the comparison shows them at or near zero
   crossings and ELK degrades badly.
3. **All production use flows through the Phase 1 boundary** behind an async
   layout service with kind-based routing and **fallback to the built-in
   engine on any engine failure** — the failure-behavior clause of doc 18
   Phase 4 (retain geometry, degrade visibly, never a blank canvas).
4. **`elkjs` is version-pinned**; a bump is a deliberate act with the
   benchmark re-run as its gate (ADR 0038 clause 4).

**The condition clause:** this selection is provisional. If the human-half
pass — run before the Phase 8 final acceptance — fails ELK's output against
the built-in engine's on the same fixtures, this ADR is superseded by one
that records that failure, and the built-in engine's path (which remains the
fallback at every level) becomes permanent. The fallback architecture makes
reversal a configuration change, not a surgery.

## Consequences

- The web app gains an async layout seam: the layout service routes by kind,
  and the app's synchronous commit path keeps working unchanged until the
  integration step (a UI-flow change requiring live browser verification)
  lands.
- The Phase 4 worker requirement is real, not conditional: ELK's cost makes
  the worker the only interactive-budget path. The service's async seam is
  worker-ready; worker wiring lands with the app integration.
- The renderer-model question (ELK's border-anchored routes vs Lucent's
  centre-anchored `Edge.route`) is deferred to that integration step as a
  deliberate decision, with the comparison's caveat on record.
- Pinned-position support in the ELK adapter arrives with the region
  relayout path, matching ADR 0015's semantics (outside nodes restated;
  `applyLayout` continues to honor pinned members).
- The swimlane/radial/tree/mixed engines are untouched — no behavior change
  where ELK did not win.
