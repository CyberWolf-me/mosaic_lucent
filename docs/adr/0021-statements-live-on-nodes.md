# 0021 — Statements live on nodes as operations

- Status: Accepted
- Date: 2026-09-04

## Context

Stage C1 made the board's history queryable; the Stage C document's C2 batch
asked the next question: what does the history *mean*? A board could say
"Alex changed pricing at 10:12" but not "the team decided $15/month" —
meaning lived in labels ("Proposal: …", "Rejected: X" were string
conventions in the extraction prompt) and in the meeting transcript, with no
structured lifecycle anywhere.

Two designs were available. A Knowledge collection — statements as rows in
a new store, referenced from nodes — or a field on nodes, set by validated
operations, the way work tracking already works (`SET_ISSUE`/`UPDATE_ISSUE`).
The C1 review had already refused the first direction: a second semantic
layer means two sources of truth ("is this fact a node or knowledge? which
is canonical? what does deleting one do?"), and Lucent's established answer
is that one object owns its meaning.

## Decision

**A statement is a field on a node, set by operations — the mirror of the
issue layer for meaning instead of work tracking.**

- `StatementFields { kind, status, topic?, supersedes?, provenance? }` on
  `Node`, with `SET_STATEMENT` (attach/replace/clear) and `UPDATE_STATEMENT`
  (lifecycle patch; `kind` is deliberately not patchable — kind is identity,
  a change of kind is a new statement, visible as its own revision).
- **Six kinds, a closed set**: decision, proposal, question, action,
  requirement, risk. The freeze rule: a new kind requires evidence of a
  distinct LIFECYCLE, not merely a new label. `fact` and `constraint`
  (docs/05's wider taxonomy) stay transcript context until a kind earns
  independent behavior — added now, they would be decoration.
- **Four shared statuses** (open/resolved/rejected/superseded), not per-kind
  state machines: the nuance lives in the label and the op log records the
  story. Decisions are born `resolved` — an undecided "decision" is a
  proposal.
- **Supersession is visible by reducer side effect**: a statement listing
  node B in `supersedes` flips B to `superseded` (its kind, topic, and
  evidence preserved) — "a rejection supersedes visibly" becomes data
  instead of a `Rejected: X` label. The validator keeps the graph honest:
  targets must exist, carry statements (with in-batch simulation), never
  self, never cycle (A→B→C→A refused), and repair orders a statement after
  its target's setter when the model emits them backwards.
- **Identity survives visual change**: relabels, type changes, and transforms
  never touch the statement or provenance — asserted by round-trip test.
  The statement is what the node *is*; the label is its current caption.

Because the contract is operations, everything the platform already
guarantees applies on day one: the model's tool schema derives the new ops
automatically (ADR 0005's promise kept — one union, zero edits to the
derivation), MCP agents see statements in `get_board`, validation rejects
bad batches at every boundary, undo restores every superseded target's prior
statement, and statements shared through the op log land on every peer.

**Two senses of "proposal", documented on purpose**: the statement *kind*
(a hedged idea the meeting surfaced — "maybe we could…") and the Stage B3
review-gate *proposal* (a batch of operations awaiting human approval) are
different objects sharing a word. The gate is a workflow state; the kind is
a meaning. The UI says "pending review" for the former and "proposal" for
the latter where they could collide.

## Consequences

- C6's views (Decisions, Actions, Risks, Questions) become projections over
  `statementNodes()` — the same data the chips and the HUD editor read,
  with no migration when they arrive.
- C5's topic identity work keys on `topic` (a plain kebab-case string in
  C2), which was designed as the seam: entity resolution enriches the key
  later without changing the op.
- A node carries at most one statement — a decision that was once a
  proposal is the same node with a changed kind (a new statement), not two
  nodes. Multi-statement nodes would reintroduce the two-sources problem
  one level down; nothing in C2's scope needs them.
- The golden set pins the born-resolved, supersession, and
  proposal-never-a-decision shapes, so the offline gate watches the
  doctrine as data rather than as prompt prose.
