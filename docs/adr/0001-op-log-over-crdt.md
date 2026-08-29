# 0001 — Server-authoritative sequenced op log, not a CRDT

- Status: Accepted
- Date: 2026-08-28

## Context

Multiple people edit one `Workspace` graph at the same time. The obvious
industry answer is a CRDT (Yjs, Automerge): merge without a server, converge
eventually. Our edits are not text runs, though — they are 32 semantic
operations (`CREATE_NODE`, `CONNECT`, `RESOLVE_COMMENT`, `APPLY_LAYOUT`, …) with
invariants a merge cannot invent: an edge must reference two live nodes, a
layout is a whole-graph transform, a lock must actually deny a write, and an AI
proposal must be validated against the _current_ graph before it is accepted.

## Decision

The server is the single writer of truth. Every accepted change becomes an entry
in a per-board append-only op log with a monotonic `seq`; clients apply
optimistically, then reconcile against the sequence the server assigns. Conflict
resolution is last-writer-wins per operation, arbitrated by `seq`, with
semantic validation (`validateOperations`) as the gate rather than a merge
function.

## Consequences

- Invariants and permissions are enforceable in one place, because one process
  decides the order. Role checks (`Room.commit`) and validation cannot be
  bypassed by a peer.
- Undo is operation-based and multiplayer-safe: we invert operations
  (`inverseOperations`) rather than restoring snapshots, so undoing your own edit
  does not revert a collaborator's.
- The log is an audit trail and a history feature for free.
- We give up offline-first editing and pay for the ordering authority: the
  sequence allocator must live in the database once more than one instance runs
  (M3), and a losing write must trigger a resync rather than a silent merge.
- If we ever need true offline, a CRDT can be layered _under_ one board's log
  without changing the operation vocabulary; this decision is reversible at the
  transport layer, not at the domain layer.
