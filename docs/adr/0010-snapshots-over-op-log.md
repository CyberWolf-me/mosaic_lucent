# 0010 — Board snapshots are a cache over the op log, never a second truth

- Status: Accepted
- Date: 2026-08-28

## Context

A board with 50k logged ops replays all 50k on cold start. Snapshots bound
that, but two stores of the same state invite the classic drift bug: a snapshot
restored without its log tail loses edits, and a log replayed over a stale
snapshot resurrects deleted objects.

## Decision

`board_snapshots` stores `{seq, workspace}` — the state _after_ that seq. Cold
start seeds the room from the snapshot and applies only the log tail above it;
the room's `baseSeq` records the floor, so a client asking for catchup from
below the floor gets an explicit reseed rather than a replay with a hole.
Snapshots are pruneable and rebuildable at any time from the log; the log
remains the only append-only source of truth, and pruning below the newest
snapshot is the only ever deletion.

## Consequences

- Cold start cost is bounded by (snapshot age), not board history.
- Snapshot restore bugs surface as catchup/resync behaviour, which is testable
  (`room.fromSnapshot`, two-instance suite), instead of as silent state loss.
- The log tail, snapshots and the board row's `workspace` are three projections
  of one history; the write path — allocate seq, then project — keeps them in
  that order.
