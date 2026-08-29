# 0009 — Room commits allocate seqs through the board store, not locally

- Status: Accepted
- Date: 2026-08-28

## Context

The server-authoritative op log (ADR 0001) gives every entry a monotonic `seq`
per board. With one process, `log.length + 1` is that number. With two
instances serving one board, it is a guess that loses to whoever commits first —
and a room that silently diverges from the durable log leaves every client
cursor meaningless.

## Decision

`Room.commit` is async and routes every batch through an allocator — the
board store's `appendOp`, whose `(board_id, seq)` primary key is the uniqueness
source. A commit validates against live state, appends with an optimistic
`expectedSeq`, and on a conflict pulls the winner's entries in through a
fetcher, re-validates its own batch against the state that actually won, and
retries once. A batch is refused only when it is genuinely invalid against the
merged state (`validation`), never merely for arriving second (`stale` after
retries are spent). Entries absorbed during a conflict are broadcast to local
clients, so no socket is left a seq behind.

The receiving half rides the fanout bus (ADR 0004): a message only says "the
log moved", and the room re-reads new entries from the store — the same
`pullRemote` path serves `op` notifications and `resync` markers, both
idempotent by seq.

## Consequences

- Two instances converge without a CRDT and without a coordinator; the store's
  uniqueness constraint is the referee.
- A commit is two or three round trips to the store instead of one in-memory
  append; the in-memory store keeps tests and single-instance dev at
  event-loop cost.
- `Room.version()` is the store head, not a local count — the number a client
  cursor means.
