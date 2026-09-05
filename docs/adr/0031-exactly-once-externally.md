# 0031 — Exactly once, externally: the ledger and the key

- Status: Accepted
- Date: 2026-09-05

## Context

Stage D5 wraps external mutations in the safety the owner specified:
distinguish internal from external mutations; the flow propose →
permission → preview → human confirmation → execute → store the external
reference; every external request identified by the triplet
(lucentActionId, requestId, provider) so timeout → retry → the SAME
external task, never LIN-482 AND LIN-483; and the permission model reuses
Stage B — no second external-action system. The acceptance: simulate
create → timeout → retry → 1 external task, 1 Lucent reference, 0
duplicates, plus the unauthorized case.

The recon's decisive finding: the codebase already contains BOTH halves of
the answer. The billing event ledger (ADR 0007's claim/duplicate/
in_flight triad, stale window, sweep) is the ATTEMPT-idempotency
machinery; the Stripe client's idempotency-key-on-every-POST
("the request may never have reached Stripe, and if it did the idempotency
key covers us") is the EFFECT-idempotency machinery. An outbound external
create is the one case where BOTH are required simultaneously — the
ledger alone gives at-most-one-VISIBLE-attempt (a timed-out create may
have landed externally; re-claiming → two tasks), and a key alone names
nothing about which request is in flight.

## Decision

**The pairing is the ruling**: the execution ledger dedupes ATTEMPTS, the
provider call's idempotency key dedupes EFFECTS, and the acceptance is
only literally true with both.

1. **The execution ledger** (`src/integrations/ledger.ts`): the
   Stripe-event shape generalized to outbound mutations — composite
   (boardId, provider, requestId) key, states received/applied/failed,
   the claim triad plus `exhausted`, first-INSERT-wins, the shared
   isReclaimable rule (failed re-claims immediately; stale received after
   the window), max attempts then permanent, pending() as the sweep feed.
   THE ONE GENERALIZATION the problem demands: the row stores the payload
   — an intended external create has no external authoritative copy, so
   the pending record IS the replay source (Stripe's ledger keeps no
   payload because Stripe re-fetches its own events; that luxury does not
   exist here). The requestId names the ITEM
   (`ext_<recordId>_<approverId>_<nodeId>`) — the owner's triplet
   resolved per node, a defect the route test caught: the first draft
   keyed per-BATCH, so ten items shared one composite key and the first
   item's claim made the other nine answer duplicate with ITS external
   id.
2. **The provider idempotency key** (`CreateTaskInput.idempotencyKey`):
   the executor threads `ext_<nodeId>` per item — STABLE across records,
   so a retry of a failed node through a fresh proposal cannot duplicate;
   the FakeProvider honors it (repeated key → the SAME fake-N, Linear's
   real behavior), and `failNext`/`hangNext` give the fake deterministic
   fault arms. Providers that cannot honor keys accept the retry
   contract's window — recorded in the interface docs, their problem when
   real (none exist until D6).
3. **The approval record is a new kind, NOT B3** (ADR 0030's ruling,
   confirmed): `IntegrationActionRecord` in the integrations store —
   the status quartet, one-pending-per-(board,provider) by supersede,
   the decided-once transition guard (a second approve answers
   `duplicate: true` with the ORIGINAL outcome), board-scoped reads,
   items carrying their exactly-once keys. The record stores its items —
   the sweep's replay source.
4. **The routes**: propose (editor) computes the per-node plan and
   returns THE PREVIEW — per-item creates with titles/assignees/dates,
   the updates, and the honest statement ("Nothing will be deleted;
   existing external tasks are only modified beyond status drift if
   their fields changed on the board"). approve (editor) runs the
   executor: per item, ledger claim → keyed provider call under a 15s
   race timeout → link → applied; one item's failure fails that item,
   never the batch (the partial-application philosophy, applied to
   external effects). reject (editor) — ZERO external effects, the
   provider never called on that path (pinned). list (viewer). The D4
   sync route remains the DIRECT path for scripts/tests; the human path
   is propose → approve.
5. **The permission floor: board editor, no second system** — identical
   to D4's sync and B3's approve; the org owner's control is structural
   (only an owner configures connections; execution refuses inactive
   ones). The unauthorized case: viewer → 404 on every mutation route
   (pinned), reads at the viewer floor. Scopes stay recorded metadata —
   enforcement waits for D6's real vocabularies (the owner's "do not
   invent a second system unless evidence demands").

**Deliberately not built**: any web surface (the chip + external-action
panel land in D6 against the frozen preview shape); scope enforcement; the
PG ledger/record twins + migration (InMemory pairs ship; PG lands with
D6 when Linear demands persistence); a background sweeper process (the
sweep function ships and is tested; main.ts's interval wiring lands with
D6 — the direct route covers D5's consumers); link GC on node deletion
(documented, deferred — the outbox owns the decision); real providers
(D6); webhook receivers (D7); AI-initiated external proposals (D9's
automation through the same routes).

## Consequences

- The acceptance is proven at the assertion level: the failed first
  attempt's createTask is RECORDED (the attempt happened) while only ten
  tasks exist (the effect happened once) — attempts and effects counted
  separately, the pairing's proof.
- The per-node key's stability across records is what makes a retry after
  a partial batch safe: the failed node re-creates through the same key;
  the nine linked nodes are updates by the link registry's own idempotent
  upsert.
- The decided-once guard composes with the ledger: the guard protects
  the DECISION, the ledger protects the EXECUTION — a double-approve
  answers duplicate before the loop runs, and an in-flight retry answers
  in_flight without a second provider call.
- The preview is contract, not decoration: D6's panel renders against
  the frozen shape (creates/updates/statement), so the web work is a
  renderer, not a redesign.
- One honest boundary carried from ADR 0030: links are invisible to the
  op log, so a deleted node leaves a store-side link the sync no longer
  visits. The sweep's pending feed is the GC seam when that work lands.
