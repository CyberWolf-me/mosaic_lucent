# 0029 — The execution graph: typed edges, cycle rejection, derived truth

- Status: Accepted
- Date: 2026-09-05

## Context

Stage D3 turns the flat set of executable actions into an execution graph.
The owner's milestone: only `depends_on`, `blocks`, `related_to`; derived
blocking without manually creating downstream statuses ("Design blocked →
Implementation, QA, Release all blocked"); AI may propose a dependency but
the relationship passes through the operation validator; the acceptance
gate — a 10-task graph with 6 dependencies, 2 blockers, and 1 cycle
attempt → 6 valid, 2 propagated, 1 rejected.

ADR 0027 deferred dependencies to D3 with a recorded outline. The count
reconciled here: the written list names eight (direction, cardinality,
cycles, rendering, deletion, undo, edge-vs-metadata, blocker propagation);
the informal numbering said eleven — the three implied questions were
blocker-vs-at-risk semantics, where the computation lives, and whether any
of it persists. All eleven are answered below.

The recon's decisive findings: `Edge.relationship` is free-form in every
layer (op schema, load schema, summary, digest — `depends_on` already
round-trips end to end, zero schema change); the validator's supersession
cycle check (`statementOf` + `supersedesReaches`) is the exact mechanism a
dependency cycle check mirrors; the layout engine survives cycles (Kahn,
seen-bounded) but only the validator can reject them; DELETE_NODE's
inverse already restores edges as CONNECT_NODES (deletion/undo inherit
free); and ADR 0027's "no derivation" rule governs WRITE-TIME field
derivation while its own "overdue is rendered, never persisted" clause
blesses read-time projection — the `isOverdue` precedent.

The owner approved the plan 9.7/10 with four clarifications, all folded
in: blocked-but-overdue upstream CONTRIBUTES to at-risk (trouble
compounds — excluding it would quiet the risk chain at the worst moment);
`at_risk` is an analytical signal, never a status; dependency edges are
general node relationships while propagation walks executable nodes only;
and three extra tests (diamond, blocked-recovery, overdue-recovery).

## Decision

**The manual/derived split is D3's core.** Manual state is `issue.status`
— the human's execution call, independently editable (ADR 0027, held:
the D1 pins pass untouched). Derived state is `blockedBy[]`/`atRiskBy[]`
— computed project truth, from `derivedExecution(workspace, now)`, a pure
core function. Never merged: a node may legitimately be
`status=completed, blockedBy=[]`, or `status=in_progress,
blockedBy=["design"]`, or `status=open, atRiskBy=["research"]`. No op
ever writes derived state; no derived value ever aliases onto
`status`/`statusCategory` (the generate summary→workspace rebuild is the
named trap — it reads manual status only, guarded by the D1 test suite).

**The eleven questions, answered:**

1. **Direction**: `depends_on` is canonical — `A depends_on B` = A waits
   on B. `blocks` is the same edge viewed from upstream
   (`A blocks B` ≡ `B depends_on A`); `dependsOnGraph` normalizes both
   into ONE adjacency so a cycle cannot hide across spellings.
   `related_to` carries no dependency semantics — never propagates,
   never participates in cycle rejection.
2. **Cardinality**: unbounded. The walk is `seen`-bounded (hang-safe by
   construction, the layout engine's Kahn precedent).
3. **Cycles**: rejected at the authoritative validator — a
   `dependsOnOf` adjacency maintained THROUGH THE BATCH (the
   `statementOf` precedent), so a cycle formed entirely within one
   AI-generated batch is caught, and the error names the cycle.
   DISCONNECT removes from the simulated adjacency — unblocking is
   always valid.
4. **Where stored**: on edges, which are workspace state riding the op
   log — no new store, no migration, no second persistence model.
5. **Edge-vs-metadata**: edges. `supersedes` (statement metadata) is
   replacement semantics; `parentId` is work-item hierarchy; the
   dependency graph is a third relation with its own vocabulary, and
   edges — with their deterministic `edgeId` triples, inverse support,
   and delete-cleanup — are the machinery built to carry it.
6. **Rendering**: subtle. Dependency edges render with a quiet dash
   (`edge-dep`), fainter than structural edges — the connector-density
   restraint; the meaning lives in the arrow's label. Never
   permanently high-salience.
7. **Deletion**: inherited — DELETE_NODE drops touching edges.
8. **Undo**: inherited — the inverse restores edges as CONNECT_NODES
   ops; the dependency vocabulary round-trips through it unchanged.
9. **Blocker propagation**: computed-on-read. `blockedBy` = transitive
   upstream with manual status `blocked` or themselves derived-blocked;
   walking EXECUTABLE nodes only (statement kind action + issue fields
   — a plain node in the chain forwards nothing; edges are general,
   propagation is executable-only).
10. **Blocker-vs-at-risk**: two distinct signals, never overloaded.
    `blockedBy`: something upstream PREVENTS this work. `atRiskBy`: an
    upstream item is overdue-unfinished — past due AND not
    completed/cancelled, BLOCKED NOT EXCLUDED (the review's settled
    clarification). At-risk is an analytical signal, never a status.
11. **Whether anything derived persists**: nothing, ever. Recovery is
    re-computation — upstream unblocks or a deadline moves, and the
    derived state disappears because it was never stored. Pinned by the
    blocked-recovery and overdue-recovery tests.

**The teaching**: visual-agent v8 gains the dependency vocabulary with the
direction-explicit example ("Engineering can't start until design is
approved" → Implementation depends_on Design approval, the WAITING work is
the source, the PREREQUISITE is the target — never the reverse, named as
the exact thing models flip). The validator remains the authority
regardless of teaching. Golden case `dependency-edge-from-ordering` pins
the direction and forbids the flip and the blocks-view.

**Deliberately not built**: cross-board dependencies (edges are
intra-board by construction); a dependency-editing UI (ops are the
interface — the HUD may come later on evidence); Gantt/timeline
rendering; auto-unblocking and automatic status transitions (upstream
completing never writes downstream status — the derived line disappears,
and a human or the AI changes the actual state, visibly); blocked
notifications/reminders; SLA/lead-time analytics; persisted anything.

## Consequences

- The derived truth is one pure function every surface already reads:
  the Board badge, the Intelligence lines, the MCP summary, and the Ask
  digest all consume `derivedExecution` from the workspace they already
  hold — no fetches, no routes, no stores (the ADR 0026 projection
  doctrine, extended to execution).
- The Board column stays the human's arrangement — derived informs, never
  refiles. The Intelligence view is the rich surface (the multi-line
  blocked-by/at-risk detail); the Board is the compact one (the badge).
- The layout engine consumes dependency edges like any edge, so a
  dependency chain lays out in order for free — no dependency-specific
  layout exists or is needed.
- D9's blocker reasoning ("what's blocking us?") now has structured data
  on both sides: the Ask digest's `[blocked by: …]` brackets and MCP's
  `derivedBlockers` — the deterministic system computes truth; the AI
  explains it.
- The cycle rule composes with the plan gate: a plan may sequence its
  actions with depends_on (PLAN_SAFE_OPS admits CONNECT_NODES), and a
  cyclic plan is refused at validation — the repair round cannot smuggle
  one through, because the adjacency is batch-simulated.
