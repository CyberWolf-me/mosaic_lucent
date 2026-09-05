# 0030 — The adapter architecture: one seam, proven fake-first

- Status: Accepted
- Date: 2026-09-05

## Context

Stage D4 opens the integration era. The owner's milestone: the
ExecutionProvider abstraction every external system implements (Linear
first, D6; GitHub/Jira/Figma/Slack later, D8), an integration connection
store, and an acceptance gate that is deliberately architectural — "build
a fake provider; prove Action → ExecutionProvider → FakeProvider works
WITHOUT the core Action model knowing anything about Linear."

Three shipped ADRs pre-named D4's territory: ADR 0027 deferred "external
execution links, provider/externalId (D4/D6)" and said "D4's
ExecutionProvider targets exactly these nodes [actionNodes]"; ADR 0028
listed external links under D4/D6.

The recon's decisive findings: the LLMProvider-in-@lucent/ai/injected-by-
server pattern is the exact mirror for where the interface lives; the
SsoStore is the shape for org-scoped connections; every secret in the
system lives in env, never the DB, and the codebase contains no reversible
cipher anywhere (HMAC + scrypt only); an external action is not a canvas
op, so the B3 proposal pipeline cannot carry it; and the Stripe webhook
receiver is the copied-verbatim precedent for D7's inbound sync.

## Decision

**One seam, four rulings:**

1. **The interface lives in @lucent/server** (`src/integrations/`):
   ExecutionProvider (createTask/updateTask/getTask/searchTasks,
   mapStatus, optional subscribeToChanges), ExternalTask (the normalized
   shape every provider returns), CreateTaskInput/UpdateTaskInput, and
   ExternalTaskChange (the D7 inbound seam). mapStatus maps INTO core's D1
   vocabulary (open/assigned/in_progress/blocked/completed/cancelled) —
   Lucent's status set stays one set; providers own their external words
   and translate at the adapter boundary. Core is untouched in D4, which
   is the acceptance gate's literal demand: mapStatus consumes core's
   types; nothing in core consumes the provider's.
   The FakeProvider is not a stub: deterministic ids, a deliberately
   different external vocabulary (todo/active/done/blocked/canceled) so
   mapStatus is a real translation, recorded calls for assertions, and
   the declared subscribeToChanges live as an in-memory change bus — D5's
   idempotency and D7's sync exercise something honest.

2. **External references live in the store-side link registry, not on
   the node.** The IntegrationStore holds BOTH record families: the
   connection (org-scoped; credential REFERENCE — an env var name /
   vault pointer, never the secret value; idempotent upsert per
   (org,provider); disable-not-delete) and the task link (board-scoped by
   (board, node, provider) → externalId, url, lastSyncedStatus, syncedAt).
   Weighed and rejected: an IssueFields field (the five-place cost puts
   provider strings inside the workspace blob, the op log, undo, and
   every export — ADR 0027 deferred it pending D6 evidence for exactly
   this reason); the provenance family (creation evidence is immutable by
   doctrine — ADR 0022's whole rule — while an external link is a live,
   mutable pointer: a category error); node.metadata (the client-side
   divergence anti-pattern ADR 0022 was written to kill). The Action node
   stays one node with zero provider strings on it; the link is
   connection-scoped sync state, the same division that keeps presence
   and snapshots store-side. The definition e2e asserts the blob carries
   no provider strings after the full sync story.

3. **Credentials are reference-first.** The connection row stores a
   reference (env var name / vault pointer) — the discipline every
   existing secret follows (LLM key, SCIM token, Stripe keys: all env,
   none ever in the DB). D4 adds zero crypto: the codebase has no
   createCipheriv and D4 does not introduce one. The admin surface
   fingerprints the reference (the SSO cert precedent), never echoing it
   in full — pinned by test. If a future OAuth flow (D6/D7) must persist
   a token, the TOTP precedent applies (plaintext column + "the DB is
   expected to be encrypted at rest" threat-model note) — a decision that
   gets its own ADR when a real flow demands it.

4. **D4 does not touch the B3 proposal pipeline.** An external action is
   not a canvas Operation: it cannot pass validateProposalInput's
   non-empty-ops check, cannot partially apply, cannot commit through
   the room. D5's approval/idempotency/outbox machinery takes the
   Stripe-event-ledger precedent (claim/idempotency-key/stale-window/
   sweep), not B3's. The sync route ships as D5's PRE-APPROVAL SKELETON,
   labeled honestly: a direct editor action today, replaced by propose →
   approve → execute on the same store and provider seam in D5.

**The routes**: org-owner connection CRUD (GET list — fingerprinted;
PUT idempotent upsert — a provider nothing implements is a 400, not a
dead connection; DELETE → disabled, never deleted) and the board link
read (viewer floor). The sync route (editor floor) requires an ACTIVE
connection — syncing through a disabled one is refused. Role guards run
before store checks (a 503 is not an org oracle), pinned by test.

**Deliberately not built**: any real provider (D6); the approval/
idempotency/outbox machinery (D5 — the link's create/skip/update behavior
is the beginning of its story); the PG store pair + migration (the
InMemory pair ships per the optional-store pattern; pg-integrations
lands with D6 when Linear demands persistence — connections are low-
volume org data, links are per-board sync state); reversible encryption
(none enters the codebase in D4); webhook routes (D7 — the Stripe
receiver's verify-before-ledger order is the precedent to copy);
subscribeToChanges server plumbing; OAuth flows; a "synced to X" chip in
the web UI beyond the link GET (D6's UX); MCP exposure of links (a summary
projection when agents need it, D7 territory).

## Consequences

- The acceptance gate holds structurally: `grep provider` over the core
  workspace blob finds nothing, forever — external references cannot leak
  into boards, undo, exports, or peers because they never enter the
  workspace at all.
- Every surface D6/D8 will need is already named: the provider map in
  AppDeps, the connection row, the link registry, the sync executor. A
  Linear adapter is one file implementing one interface plus a
  putConnection call — no pipeline changes.
- The sync route's drift-only update (updateTask runs only when the
  external status moved from lastSyncedStatus) is the route-level
  idempotency D5 will formalize as request-scoped keys with retry safety.
- The FakeProvider's change bus gives D7's webhook receiver a test
  surface before any network exists.
- One honest boundary: links are invisible to the op log, so deleting a
  node leaves a store-side link the sync no longer visits (actionNodes
  drives the loop). D5's outbox work owns the GC decision; D4 documents
  it rather than inventing an eager cascade.
