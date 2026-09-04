# 0026 — Intelligence is a projection

- Status: Accepted
- Date: 2026-09-04

## Context

Every stage since C2 deferred the same item: "Decision/Action/Risk views —
C6's projections over statementNodes()." ADR 0021 promised them ("C6's
views become projections over statementNodes() — the same data the chips
and the HUD editor read, with no migration when they arrive"); C5 added
"a Topics view or recommendation inbox (C6's projections)" with the
generic Recommendation shape documented in ADR 0025 as C6+. docs/05's
meeting-intelligence panel is the product north star: DECISIONS | OPEN
QUESTIONS, ACTIONS with owners, RISKS — every row traceable to its source.

The C6 recon confirmed the architecture is already paid for: the client
holds the complete statement-bearing workspace for shared boards
(fetchBoard/adoptBoard installs it; catchUp op-replay or wholesale resync
converges a fresh viewer — statements ride the same ops) and local boards
trivially, so the view needs zero routes, fetches, or stores. BoardView
(the Kanban) reads `issueNodes` only and is blind to statements, so the
Intelligence Actions section overlaps it only where a node carries both
layers — meaning-lifecycle vs work-tracking, preserved by design.

The owner's decisions: one sectioned view (not six rail slots — all six
kinds are projections of the same statement model; the rail keeps its four
surface verbs); all six kinds first-class with per-kind glyphs, open
prominent and settled dimmed; the recommendation inbox with Merge/Keep —
closing C5's loop (detection → recommendation → human decision → validated
operation), with a change-aware ephemeral Keep and a previewed Merge; the
time lens explicitly out.

## Decision

**The spec sentence**: *Intelligence is a projection of the current
semantic workspace; it does not create new truth, mutate state without
approval, or replace History as the source for temporal analysis.*

1. **One view, six sections.** The fixed order — decisions, proposals,
   questions, actions, requirements, risks — every kind first-class (the
   freeze rule's complete vocabulary; hiding requirements or proposals
   would invent an arbitrary "semantic state the Intelligence view
   acknowledges" tier). Sections are collapsible with always-visible
   counts; open statements render prominent, settled ones
   (resolved/rejected/superseded) dimmed below — the lifecycle visible,
   never deleted.
2. **The uniform evidence contract.** Every row offers the same two roads
   back to canonical truth: the label reveals the node (?reveal — the
   canvas selection), the ✦ jumps to the meeting at the exact turn
   (?meeting + ?turn, the C3 coordinates), hidden when a statement has no
   provenance. Rows show the authored topic as-authored and the issue
   assignee when the node also carries work tracking — the Board bridge
   made visible, not duplicated.
3. **The inbox is ADR 0025's first Recommendation consumer.**
   `possibleDuplicateTopics` (C5) surfaces with its evidence — statement
   counts per side, meetings of origin (rule 4). **Merge** is previewed
   (exactly which statements will update, "nothing will be deleted"),
   then confirmed; the confirmed batch is UPDATE_STATEMENT ops through
   `applyManual` — the same validator, the same undo, the same history as
   any human edit. Only the explicit click ever applies a recommendation;
   detection is automatic, application never is (the C5 invariant, held
   end to end). **Keep** is change-aware ephemeral: suppression keyed on
   the pair's fingerprints (both authored keys + both statement counts),
   so an unchanged pair stays dismissed for the session and any statement
   change re-arms the question — no persistence, no nagging, and durable
   dismissal remains the future engine's problem.
4. **The surface division C6 completes**: Board → what it looks like,
   Meeting → what was said, History → what happened when, Intelligence →
   what is true now, ⌘K → find, Ask → explain.

**Deliberately not built**: the time lens ("only what changed since the
last meeting" — temporal projection over statement events is a future
stage on the C1/C3 history/meeting infrastructure; Intelligence does not
replace History); durable dismissals or a persisted inbox (ADR 0023's
rule); the general recommendation engine (contradictions, stale objects,
ownership conflicts remain future detectors); per-kind status machines
(the C2 decision stands); any REST/MCP intelligence route or server-side
grouping (pure client-side — revisit only if workspaces outgrow the
client); editing statements from the view (rows jump to the HUD; the view
reads, the HUD edits — no second editor); a "create a plan from today's
meeting" bridge (docs/05's projection is future; the assignee display is
its seam).

## Consequences

- `statementNodes()` has its first UI consumer, and `possibleDuplicateTopics`
  its first real one — the C2/C5 seams did their jobs: no migration, no
  new store, the views arrived as projections exactly as promised.
- The view is identical for shared and local boards — the first
  full-featured surface with no two-mode split (HistoryView fetches
  because the log and transcripts are server-only artifacts; statements
  are workspace state).
- Merges converge through the ordinary op pipeline, so peers see them as
  sequenced entries, undo covers them, and the C5 fold's idempotence
  means a merged board stays merged.
- The inbox recomputes from the workspace on every render — there is no
  cached recommendation state to drift. The cost is the detector's scan,
  bounded by the board's statement count.
- The suppression key's change-awareness means a dismissed pair silently
  returns when either side changes — the user is re-asked exactly when
  the board changed, which is the design, and worth knowing when it
  happens.
