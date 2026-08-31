# ADR 0014: Groups as diagram regions

Date: 2026-08-31
Status: accepted

## Context

A board carries exactly one `diagramKind` — one rendering lens for the whole
semantic graph. Users working on several things at once ("the checkout
flowchart, and a mind map for pricing ideas, and the team org chart") had two
bad options: split into multiple boards, losing the shared context that
multi-diagram boards exist to give, or TRANSFORM_DIAGRAM the whole board and
destroy whichever diagram was already there. The "one model, many
representations" principle was board-global — many representations, but only
ever one at a time.

## Decision

**A `Group` may carry an optional `kind: DiagramKind`. When set, the group is
a _diagram region_: its members are laid out by that kind's strategy, in a
sub-workspace, packed as a band alongside the board's other regions and the
board-wide flow. `SET_GROUP_KIND { id, kind | null }` changes or dissolves a
region — by voice, text, or right-click — without touching anything else.**

Design choices and why:

- **Extend `Group`, not a new "section" entity.** Groups already have
  membership (`children` + `Node.groupId`), render as regions, drive swimlane
  geometry, reach the AI summary, and invert in history. A parallel entity
  would duplicate all five for no new capability.
- **`kind` is optional; unset groups are exactly what they were.** Old boards
  parse unchanged, swimlanes keep working (a process map's lane groups never
  carry a kind), and `computeLayout` partitions only when a kind-group with
  members exists. Boards without regions run byte-identical code paths.
- **The kind stays a rendering lens, never content.** Region membership is
  ordinary group membership; SET*GROUP_KIND changes no node, edge, or label.
  This amends "one model, many representations" to \_many simultaneous*
  representations — the model is still one, and TRANSFORM_DIAGRAM still
  re-renders the board lens.
- **An explicit `strategy` option suspends the region split.** A caller asking
  for "the whole board as a tree" means the whole board.

## Consequences

- The 7-literal `DiagramKind` enum now has one more restatement (the optional
  group field in `operations.ts` / `workspaceSchema.ts` / server
  `summarySchema.ts`). We accept the duplication rather than churn the stable
  AI contract with a shared constant; the drift guards (tool-schema tests,
  golden evals) catch a desynchronized copy.
- `computeLayout` partitions before strategy dispatch: regions → sub-workspace
  per region (own kind) → pack regions in a band with `REGION_GAP` gutters,
  board flow above with `REGION_STRIP_GAP`. Pinned nodes keep their
  hand-placed coordinates per `applyLayout`'s existing contract.
- The AI sees each group's kind in the summary ("g: label (N members)
  [diagram kind: mindmap]"), and prompt v3 teaches: add a different kind via
  CREATE_GROUP + kind; change one region via SET_GROUP_KIND; TRANSFORM_DIAGRAM
  is whole-board only.
- MCP agents get `SET_GROUP_KIND` automatically — the tool schema derives
  from the same Zod union (ADR 0005's drift-guard).
- Known limit, stated: converting a populated region to a far-geometry kind
  (chain → radial) can produce an ugly first layout. The layout engine owns
  geometry, so it self-heals on the next commit — the same behaviour
  whole-board TRANSFORM already has.
