# ADR 0038: Diagram engines own geometry; Lucent owns meaning

Date: 2026-09-12
Status: accepted

## Context

The 2026-09 visual-engineering advisory ("Stage V") proposes adopting serious
external engines for representation-specific work: `elkjs` for graph geometry
and routing, `bpmn-js` for a BPMN 2.0 lens. Both are proven at their jobs.
Both are also stateful systems with their own internal models, and either
could quietly become a second source of truth — or an editing path that
bypasses the operation protocol.

Existing doctrine already constrains parts of this: ADR 0005 (AI emits
validated operations, never pixels or free text), ADR 0014 (diagram kinds are
rendering lenses over one model), ADR 0015 (relayout is scoped and spatially
additive), and the visual benchmark's founding rule — the benchmark decides
(`docs/eval-results/2026-09-11-visual-benchmark-baseline.md`). None of them
yet says what an external engine is *allowed to be*. The phased plan that
operates inside this decision is `docs/18-structured-visual-engine.md`.

## Decision

**Lucent owns semantic state. A diagram engine owns representation-specific
geometry and interaction, behind a boundary Lucent defines. No engine becomes
canonical workspace state, and no engine may bypass the validated operation
protocol.**

Four clauses, concretely:

1. **One canonical state.** The workspace (nodes, edges, groups, shapes,
   wireframes) is the only truth. Engine outputs — positions, routes, BPMN
   XML, BPMN models — are derived projections: recomputable, persistable only
   as derived fields (the `Edge.route` precedent), never part of the AI
   operation contract.
2. **Engines are geometry services, not state owners.** A layout engine
   receives a semantic snapshot plus constraints and returns geometry. It
   never mutates the workspace, never stores truth, and its types never leak
   past its adapter module.
3. **All writes are operations.** Anything that changes the canvas —
   including a future bpmn-js editing bridge — produces validated Lucent
   operations (ADR 0005) that flow through the same reducer, history, op
   log, and broadcast as every other change.
4. **Adoption is earned by measurement, and licenses are checked before
   code.** An engine is adopted only when it wins the visual benchmark on
   identical fixtures — mechanical metrics *and* the human-half pass — never
   for reputation. License obligations are reviewed before integration
   ships: ELK is EPL-2.0; bpmn-js's license requires the bpmn.io watermark
   in rendered diagrams to remain visible and unobscured.

## Consequences

- `@lucent/core` stays framework-agnostic and dependency-light: the layout
  boundary interface lives in core; `elkjs`/`bpmn-js` are dependencies of
  `@lucent/web` (harness-only where they never ship), imported solely inside
  their adapter modules.
- The layout-engine boundary (doc 18, Phase 1) precedes any ELK code; the
  ELK comparison runs through it, so both engines argue from one contract.
- BPMN, if built, is a lens over a process region (ADR 0014's mechanism) and
  a derived projection — Option A — never a parallel document or a second
  editing state ahead of the read-only lens.
- Engine versions are pinned, and geometry-regression fixtures guard
  upgrades: a dependency bump must never silently rearrange existing boards.
- The checklist's "Not built (recorded in ADR 0015): … ELK/dagre" line is
  superseded by this gate procedure: ELK is no longer excluded, it is
  *conditional* — on the benchmark, and on these clauses.
