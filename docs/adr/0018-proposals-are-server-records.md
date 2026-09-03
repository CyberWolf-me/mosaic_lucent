# 0018 — Proposals are server records, not browser state

- Status: Accepted
- Date: 2026-09-02

## Context

The P2 boundary (docs/17): a pending review-gate proposal for a shared board
lived only in the proposing browser's localStorage. That browser was the sole
source of truth for the batch — invisible to every peer, gone if the tab
closed, and the "one pending per board" invariant was enforced per-browser.
The real-provider gate called this the weakest link in the multiplayer story.

## Decision

The `proposals` table is the record: status (`pending/approved/rejected/
superseded`), operations, request, explanation, provenance (quote + stable
turnRange/turnKinds), createdBy, decidedBy/decidedAt, and `appliedSeq` linking
an approval to the exact `op_log` entry it produced.

Three deliberate placements:

1. **The transition guard lives in the store.** `decide` updates only rows
   `WHERE status = 'pending'`; a second browser's approve changes nothing and
   reads the record back (the server-side `decidedRef` the client could only
   approximate locally).
2. **The one-pending invariant lives in the database.** A partial unique
   index on `(board_id) WHERE status = 'pending'`, plus a create that retires
   any pending predecessor and inserts in one data-modifying CTE — the
   localStorage supersede contract, made race-safe.
3. **Approval commits through the room, not around it.** The applied batch
   enters via `Room.commit` with the actor record (B2) and a requestId (B1),
   so peers receive the same sequenced entry any edit produces. When no room
   is live, the store applies it; the entry lands in the log either way.

Approval re-validates with `applyValidOperations` (partial application): a
proposal written against yesterday's board may reference a node deleted
overnight — the valid remainder applies, the skips are reported. Refusing
wholesale would make every proposal hostage to the first concurrent edit.

Reads are viewer-floor: every member of the board can see what Lucent is
proposing. The panel is board state, not a private draft.

## Consequences

- `proposal-created` / `proposal-decided` broadcast to the board's sockets, so
  panels open and close as one fact on every browser.
- The web client rehydrates the pending record on board load and mirrors peer
  proposals through the socket; a refresh no longer drops the panel.
- Local (offline) boards keep the localStorage path unchanged — the server
  path activates only for adopted boards.
- Stage C can build cross-meeting decision history on `appliedSeq` without
  touching the client.
