# 0033 — Inbound sync: the symmetric human gate, the receiver that copies the Stripe doctrines, and the system actor's first use

- Status: Accepted
- Date: 2026-09-06

## Context

ADR 0032 drew the line: "D6 is outbound-authoritative; inbound
synchronization and conflict resolution begin in D7." D6 shipped Linear
outbound — propose → preview → approve → execute, every external effect
human-approved. D7 is the mirror: changes that originate in the external
system flow INTO Lucent, and the stage's core position is that the same
trust rule applies in both directions.

**The contract paragraph:** D7 introduces inbound synchronization from
connected execution systems without loosening the D5/D6 safety line. A
verified provider webhook queues a change for human review; nothing
auto-applies to a board. An accepted change commits as the system actor
with the accepting user as the initiator, through the same validated,
logged, room-broadcast path as any edit. Conflict resolution is named:
Lucent stays outbound-authoritative on explicit sync, the provider's
word is never silently lost, and untranslatable words never write —
they warn. The webhook receiver authenticates by HMAC signature over
the raw body, resolved per-org through the connections' secret
references; no session, no CSRF, no origin check applies to it.

## Decision

**THE SYMMETRIC HUMAN GATE.** D5/D6 made every outbound effect
human-approved. D7 is the mirror: every inbound change queues for human
accept — an external system mutating a Lucent board without a human
seeing it is the same trust violation in both directions. The queue is
a new record family (`InboundChangeRecord`: pending/applied/dismissed/
superseded), rendered in the Intelligence view's "External changes"
section. There is no auto-accept, no TTL, no "trusted provider"
carve-out — and the MCP projection is read-only for the same reason
(`list_external_links` sees the queue; no tool decides it).

**THE RECEIVER COPIES THE STRIPE DOCTRINES VERBATIM** (the ADR 0032
named precedent): raw-body-is-the-message (the route reads a Buffer
through the existing readRawBody seam; a re-serialised body fails the
signature), verify-before-ledger (a tampered body answers 400 and the
event ledger stays empty — pinned), signature-is-the-auth (the route
sits FIRST in the app ladder, before every session/CSRF guard, the
billing webhook placement). The delivery ledger dedupes on
sha256(provider + raw bytes) with the claim/duplicate/in_flight
protocol; the claim ladder is: FAILED re-claims immediately (the work
errored, nobody is mid-flight), RECEIVED inside the window is in_flight,
past it re-claims (a crashed worker). The sweep recovers stale
deliveries by REFETCHING CURRENT TRUTH via getTask — the Stripe
refetch doctrine adapted, because Linear has no fetch-by-event-id API;
a replayed stale event can never resurrect an old value.

**THE SIGNATURE IS THE ORG RESOLUTION.** Linear webhooks are configured
per-org, so the receiver iterates the provider's ACTIVE connections
(`connectionsFor`, new on the store interface), resolves each
connection's `config.webhookSecretRef` through the environment (a
REFERENCE on the connection, never a value in the DB — the same
env-ref temporariness clause as credentialRef; multi-tenant credential
storage remains its own future ADR), computes the HMAC for EVERY
candidate before resolving any match (no early-exit timing leak), and
the matching connection identifies the org. A webhook resolved to one
org never writes another org's queue even when two orgs link the same
external task — pinned.

**CONFLICT SEMANTICS, NAMED** (the stage's second contract, answering
the question ADR 0032 deferred):

1. Lucent is OUTBOUND-AUTHORITATIVE on explicit sync — the board's
   pushed value wins; the sync route SUPERSEDES pending inbound records
   for the fields it pushed and reports `supersededInbound: n`.
2. The provider's word is never silently lost: both accept and dismiss
   update the link's `lastSyncedStatus` (a fact about the provider);
   only accept changes the board.
3. Accept applies the REVIEWED SNAPSHOT — the record's externalValue
   through mapStatus, never a re-fetch. If the provider moved again, its
   newer webhook updated the pending row.

**THE NEVER-GUESSES RULE GOVERNS INBOUND TOO.** An untranslatable
provider word ("In QA", a custom state) maps through mapStatus to
undefined; the record queues as the WARNING row (dismiss-only). Accept
REFUSES it with the honest 409 ("Lucent has no translation for 'In QA';
the board keeps its state") — because accepting would require guessing
a status to write. The web renders the warning sentence and does not
offer the Accept button at all; the pure `inboundRowActions` encodes
the rule so the UI cannot contradict it.

**THE SYSTEM ACTOR'S FIRST USE.** `OperationActor.actorType: "system"`
has been declared since Stage B and never used. An accepted inbound
change commits as `actor: { actorType: "system", actorId: <provider>,
initiatedBy: <the accepting user> }` — the history timeline honestly
shows "Lucent ← linear, accepted by <user>". Applied room-first through
the B3 `commitForBoard` seam (peers receive the ordinary op frame) with
the direct-store fallback (the proposals.ts precedent), requestId
`inb_<changeId>` (idempotent; a second accept is the honest duplicate
with no second op — pinned). The decide routes are decided-once
guarded, the B3 pattern.

**THE DEDUPE LADDER** (three layers, each pinned): delivery-level (the
event ledger: identical bytes = the same event, 200 duplicate),
queue-level (a pending record for the same (board, node, provider,
field) refreshes detectedAt on the same value or updates in place on a
new value — never a second row), resolution-level (a record whose live
board value already equals the mapped value is not queued at all).

**Inbound create/delete are NOT built** — the receiver ignores the
create and remove actions (inbound create is a future import flow;
remove remains the sweep's documented link-GC decision). Title/
assignee/description inbound sync are not built either — status first,
the vocabulary mapStatus owns; the record's `field` column anticipates
the rest without a schema break.

## Consequences

- The D4-declared seam (`ExternalTaskChange` + `subscribeToChanges`)
  remains declared-not-plumbed: the webhook receiver is the inbound
  path, and `subscribeToChanges` stays the in-memory test bus it was
  documented to be. If a future provider's push model needs a
  long-lived subscription (SSE, socket), the seam is where it lands —
  the queue and the decide routes are already provider-agnostic.
- The acceptance proves the story at the wire level: the stub fires a
  signed webhook → one pending row → accept → the node's status changed
  - the system-actor op in the log + the link updated; a redelivery is
    a duplicate; a newer value updates the row; the warning row refuses
    accept with 409; the tampered signature leaves the ledger empty; the
    explicit sync supersedes and reports; the unlinked issue is ignored;
    the workspace blob carries no provider strings throughout.
- The PG pairs (migration 0021) give the queue and the delivery ledger
  the same durability as the rest of the platform; the parity suites
  run the same contracts over both twins.
- Two test-harness lessons worth recording: per-test state isolation
  matters even for "stateless" route suites — the first D7 inbound
  suite run leaked an accept's mutated board into the next test through
  a shared harness; the suite now builds a fresh harness per test. And
  the claim-ladder order (failed-immediately vs received-in-window)
  only became correct when the parity contract stated BOTH arms — the
  first implementation made failed rows wait for the stale window,
  which the InMemory twin passed and the stated contract caught.
