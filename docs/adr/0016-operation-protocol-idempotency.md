# 0016 — The operation protocol: requestId idempotency, explicit acks, operationId

- Status: Accepted
- Date: 2026-09-02

## Context

Stage A's gate ran 14 real-provider calls and surfaced the operational truth of
the operation path: the client's only confirmation was its own broadcast echo,
a duplicate submit was indistinguishable from a fresh one, and a rejection
carried no correlation. Concretely, with no idempotency:

- a retried `CREATE_NODE` (network blip, response lost) fails validation
  ("node already exists") — the retry looks like a bug in the user's board;
- a retried `MOVE_NODE` **applies twice** — moving twice is valid, so nothing
  catches it;
- a retried proposal approval would either double-commit or race the
  transition guard.

## Decision

Every op submit carries a client-generated `requestId` (`req_…`); every
committed batch carries a server-generated `operationId` (`op_…`). Three
properties follow:

1. **The replay guard runs BEFORE validation.** Recognizing a retry by
   re-validating its ops is wrong by construction — the world moved when the
   original landed, so validation measures the wrong thing. The key is the
   request's identity; the answer is its original outcome. The guard is
   implemented at both producers (the room, the REST ops route) with the
   store's `findRequest` as the authoritative lookup and the room's in-memory
   map as the fast path. `appendOp` additionally settles duplicates inside its
   allocation CTE, which is the durable backstop for a two-instance race no
   single room can see.
2. **Acceptance is explicit.** The submitter receives an `op-ack`
   (`{requestId, seq, operationId, duplicate?}`) addressed to them alone;
   peers never see another peer's ack. Refusals (`op-rejected`) carry the
   `requestId` and the log `head`, so a refused submit knows which request
   failed and how stale the state it validated against was.
3. **A partial unique index enforces it at the database.**
   `UNIQUE (board_id, request_id) WHERE request_id IS NOT NULL` — legacy rows
   and replay-only callers never collide.

A replayed request ignores `expectedSeq`: the request already committed at ITS
seq, and re-checking the caller's now-stale expectation would 409 a replay of
something that already succeeded.

## Consequences

- Exactly-once semantics for every submit path, provable in tests: duplicate →
  original seq + `duplicate: true` + no second effect.
- The reconnect queue (B4) relies on this: replaying queued batches with their
  original ids makes a half-delivered batch a no-op instead of a double.
- `operationId` gives acks, proposal approvals (`appliedSeq` links to it via
  the log), and any future audit trail a name that is not a board+coordinate.
