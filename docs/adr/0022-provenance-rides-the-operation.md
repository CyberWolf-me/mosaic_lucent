# 0022 — Provenance rides the originating operation

- Status: Accepted
- Date: 2026-09-04

## Context

Meeting extraction needed nodes to answer "why is this here?" — the
transcript quote behind a decision. The M2 implementation stamped
`metadata.meeting` onto nodes in a client-side post-pass after the model's
operations were applied. Stage C1's recon, run before C2 planning, proved
what that choice actually did: the stamp existed only in the extracting
browser's React state. It was not in the ops, so it never reached the undo
history, remote peers, the server's stored board, or the op log — and on a
shared board, the next incoming operation's `onWorkspace` sync overwrote it.
Worse, the Stage B3 review-gated path stamped _nobody_ — not even the
proposer. Meanwhile C1's Ask digest rendered `metadata.meeting`, so the
provenance citations C1 shipped only worked on local boards, from the one
browser that captured the meeting.

## Decision

**Provenance is a field of the operation that causes the object to exist —
not a second operation, and never a post-pass.**

- `CREATE_NODE` gains optional `provenance: { meetingId, turnRange?,
turnKinds?, quote? }`; `SET_STATEMENT` embeds it in the statement (the
  evidence behind a decision). The reducer stores it to `node.provenance`
  once, and no later operation touches it.
- The model never emits provenance — it cannot see meeting ids or turn
  indices. The **meeting loop enriches the ops it already holds** before
  committing, via the pure `attachProvenance(ops, evidence)` (idempotent
  per op, so the server's approve-time enrichment backfills older clients'
  raw ops rather than fighting them). Three writers, one helper: the
  client's send path, the client's local-proposal approval, and the
  server's B3 approve route.
- No `SET_PROVENANCE` operation. The review's framing, which this ADR
  adopts: a post-pass stamp is "an artificial second operation for
  something that is really metadata of the first." An op that set
  provenance after creation would need coalescing in history (users would
  see "create node" + "set provenance" as unrelated actions), would let
  any later editor rewrite a node's origin, and would still have the
  two-writers problem the post-pass had — just moved. Evidence attaches at
  creation, and creation is the only moment it is knowable.
- `extractedAt` is dropped from the old stamp's shape: the op log's own `at`
  already records when the creation happened, and a second timestamp on
  the node would be a second source of truth the first time anyone edits.
- Readers prefer `node.provenance` with the legacy `metadata.meeting` as a
  fallback, so pre-C2 boards keep loading and their meetings keep
  answering. No migration.

Because the stamp is in the ops, convergence is a structural property, not
a behavior to maintain: undo removes the provenance exactly (the inverse
replays the same ops), peer replay carries it exactly (peers apply the same
ops from the log), the server's stored board holds it (the ops applied to
it), and the log itself is the record. The C2 test that pins this — undo
removes, replay carries, both exact — is the test the old design could
never have passed.

## Consequences

- "Why is this node here?" now has one answer on every machine, in history,
  and in Ask citations — the C1 provenance loop completes on shared boards.
- The enrichment helper is the single seam for evidence attachment. When
  later stages add other evidence kinds (a document a node was extracted
  from, a URL a fact came from), they extend `attachProvenance` rather than
  inventing a third mechanism.
- A node's provenance is immutable state — the origin never changes even
  when everything else does. If a future feature genuinely needs to correct
  a wrong meeting link, that is a deliberate op with its own validation
  and its own ADR, not an edit to this field.
- Ops carrying provenance are slightly larger on the wire (the quote caps
  at 240 chars). The alternative — a server-side join from op log to
  meeting store at read time — would rebuild the very stamp that diverged,
  one table over.
