# 0019 — History depth is a query boundary, never a deletion

- Status: Accepted
- Date: 2026-09-03

## Context

`history.depth` (Free 25 / Pro 500 / Team and Enterprise unlimited) has been
sold in the billing surface since M4.1 — displayed, never enforced: the
billing pane reported it, and nothing else read it. Stage C1 makes history
first-class (the timeline API and Ask), which forces the question the
entitlement had been quietly deferring: what does a "25-revision" plan mean
for a board with 30 revisions on disk?

Two implementations were on the table. Delete-to-limit (prune the op log to
the plan's depth, the way `pruneLog` already compacts below the snapshot
floor), or window-on-read (store everything above the snapshot floor, bound
what each caller may read). The reviewer's framing settled it: an entitlement
that shows the user 25 revisions and secretly keeps 10,000 is not a limit, it
is a lie with a UI — and a user who upgrades must see the older history
they were sold, immediately, not find it deleted as part of enforcing the
tier they were leaving.

## Decision

**The entitlement is enforced at the read boundary and nowhere else.**
`historyWindow()` computes the visible window from three numbers — the
board's head seq, the plan's depth, and the newest snapshot's seq (the log's
floor, per ADR 0010) — and both read paths use it: `GET
/api/boards/:id/history` for the timeline, and the ask route for the model's
context. Nothing is ever deleted to enforce a plan. `pruneLog` remains what
it was before C1: the snapshot-compaction mechanism, called by nobody new.

Three load-bearing properties, each locked by a test:

1. **The window is exact, not approximate.** The log is dense above the
   snapshot floor (prefix pruning only), so "the latest N revisions" is the
   seq range `[head-N+1, head]`, and `hasMore` is true exactly when older
   entries exist above the floor — never a guess, never a claim about
   compacted-away history the floor already accounts for.
2. **The window bounds everything Ask sees, not just the history list.** The
   meeting digest is filtered to meetings whose `startedAt` is at/after the
   oldest visible revision's timestamp: a meeting's content only reaches the
   board through revisions, so a Free caller who cannot see revisions 1–5
   cannot see the meeting that produced them either. Without this, Ask would
   be the first feature that *leaked* entitlements rather than enforcing
   them.
3. **Truncation is disclosed, never silent.** The response carries
   `historyDepth`, `limit`, `hasMore`, `latestSeq`; the historian prompt tells
   the model to state the window when a question could reach further back;
   the history view renders the depth banner; a citation outside the window
   is dropped by the same validation that drops invented citations.

The response ceiling for unlimited plans (`MAX_HISTORY_WINDOW`, 2000) is a
bound on one HTTP payload, not a product limit — a never-pruned 50k-entry log
cannot become a single giant response, and Ask's digest caps lower still.

## Consequences

- Upgrading instantly widens the window over the same log: the
  Free-sees-25-then-Pro-sees-30 transition is asserted end to end, including
  through Ask's context.
- Storage cost is bounded by the retention policy (snapshots + eviction-time
  compaction), not by the cheapest plan on the tier ladder — the honest cost
  of never destroying a paying customer's history on a downgrade.
- The "who may read what" question now has one answer, in one module
  (`historyWindow.ts`), shared by every history consumer that will ever be
  added (the MCP `get_board_history` tool that C1 deferred belongs behind
  the same window when it comes).
- If a future plan tier demands enforced *deletion* (a compliance boundary,
  not a pricing one), that is a different mechanism with different
  guarantees — an audit record of what was destroyed — and gets its own ADR;
  it does not bend this one.
