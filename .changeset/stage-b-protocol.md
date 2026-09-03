---
"@lucent/ai": minor
"@lucent/web": minor
"@lucent/core": minor
"@lucent/server": minor
---

Stage B: the multi-user operation protocol — idempotency, actors, server-side proposals, reconnect resilience.

- **Operation protocol (`@lucent/server`, `@lucent/web`)**: every op submit
  carries a requestId and is idempotent at the database (partial unique index);
  the replay guard runs before validation, so a retried CREATE is answered
  with its original outcome instead of "node already exists" and a retried
  MOVE applies once. Submitters receive an explicit `op-ack`
  (seq/operationId/duplicate) addressed to them; `op-rejected` carries the
  requestId and log head. REST `/api/boards/:id/ops` has the same contract.
- **Actor model (`@lucent/server`)**: every log entry records actorType
  (user/ai/system), actorId, initiatedBy, and approvedBy — a review-gated AI
  commit says "Lucent created this, initiated by Alex, approved by Sarah"
  while workspace authorship (`by`) stays the pressing user. Migration
  backfills existing rows as human edits.
- **Server-side proposals (`@lucent/server`, `@lucent/web`)**: the pending
  review-gate record for a shared board lives on the server (the P2
  boundary): visible to every member, race-safe one-pending-per-board at the
  database, transition-guarded decisions, approval committed through the
  room with the full accountability chain, and live
  proposal-created/proposal-decided broadcasts so panels open and close on
  every connected browser. A refresh no longer drops the panel.
- **Reconnect resilience (`@lucent/server`, `@lucent/web`)**: edits made on a
  dead socket queue and replay exactly-once after reconnect; a client whose
  cursor predates the log's snapshot floor is reseeded with the whole board
  instead of a partial catchup; room rebuilds are snapshot-anchored with
  eviction-time compaction (a 50k-entry board stops replaying its history on
  every cold join); GET /api/boards/:id reports latestSeq; server error
  frames (e.g. "board deleted") surface instead of vanishing.

The full acceptance scenario — two users, presence, sequenced edits, a shared
proposal approved by the second user, both boards converging on one AI-actor
entry, a hard refresh, a reconnect with exact catchup — passes end to end
(`stageB.definition.e2e.test.ts`).
