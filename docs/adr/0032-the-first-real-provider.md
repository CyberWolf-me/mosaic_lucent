# 0032 — The first real provider: the effect contract corrected, Linear shipped

- Status: Accepted
- Date: 2026-09-05

## Context

Stage D6 introduces the first real ExecutionProvider. The owner's review
of the initial plan (rated 9.2/10) found one critical architectural
contradiction and six refinements; all seven landed.

**The contract paragraph, at the top (the review's wording, adopted):**
D6 introduces the first real ExecutionProvider, Linear, without changing
the workspace model. A Linear connection supplies provider-specific
configuration and credentials through the server integration layer. Lucent
creates and updates external tasks only through the D5 execution/safety
machinery, persists external links outside workspace state, and reconciles
ambiguous provider outcomes using a provider-specific recovery strategy.
D6 is outbound-authoritative; inbound synchronization and conflict
resolution begin in D7.

## Decision

**THE EFFECT CONTRACT, CORRECTED** — the review's central finding: D5
established "the ledger dedupes attempts + the provider key dedupes
effects," but Linear has no idempotency-key header, so the guarantee did
NOT transfer unchanged. The ledger gives exactly-once ATTEMPTS; a
timed-out create may have LANDED, and a naive retry yields LIN-482 AND
LIN-483. The corrected contract: **at-least-once delivery with
provider-specific effect deduplication or outcome reconciliation.**
Key-native providers (none real yet; the FakeProvider models them) ride
the key; Linear-style providers carry **a stable Lucent marker in the
task representation** (`<!-- lucent-action:… -->` stamped into the
description, generated from the item's idempotency key — never
user-editable text) and implement **`recoverCreate?(marker)`** — on an
uncertain timeout, search the provider's own store by the marker: found →
link the existing issue (0 duplicates); not found → the create never
arrived → retry. The sweeper runs this recovery-first discipline on
stuck rows; the executor's retry path and any future UI ride the same
seam. The interface gains the optional method as its documented
evolution, not a break.

**The remaining review fixes:**
- **mapStatus never guesses**: the signature became
  `ExecutionStatus | undefined`. An unknown WorkflowState ("In QA",
  "Deployed", a custom state) returns undefined; surfaces preserve
  Lucent's state and warn — the citation-validation discipline applied
  to statuses. The D4-era unknown→open default is gone (the old test now
  pins the never-guesses rule).
- **toExternalStatus + cached states**: the reverse mapping is explicit,
  and the workflowStates are fetched ONCE per provider instance (asserted:
  one state query for a 10-create batch).
- **Deterministic assignee resolution**: exact email > exact normalized
  name > unique partial > AMBIGUOUS (an honest `unable to uniquely
  resolve assignee "Alex"`, never a guess), cached per instance.
- **teamId in connection config**: `IntegrationConnection.config` —
  provider-specific configuration lives on the connection, never on the
  Action, never in the workspace, never as an env-only secret. The
  Linear factory reads it at construction and refuses a missing teamId
  with an honest error at connect time.
- **The corrected preview statement**: "Nothing will be deleted. Existing
  external tasks will only be modified in the fields explicitly shown in
  the update rows." (the prior wording's contradiction fixed at the
  source).
- **connectionId on the action record**: approval verifies the proposal
  executes through the EXACT connection it previewed — disabled or
  replaced → 409 "Integration connection changed; please create a new
  preview". Pinned by test.
- **The connection-state UX**: the Sync button's three honest states
  (active → the button; not connected → the muted note; disabled → the
  error note) — the UI never pretends self-service while the admin route
  is API-only.

**The factory map**: `providers: Map<string, ExecutionProviderFactory>`
— the ADR 0030 interface stays frozen; the map's VALUE type changed from
instance to factory because a Linear credential is per-ORG (the
connection's credentialRef) while the map is process-global. The routes
hold the connection at every call site; `resolveProvider` folds the
existence/active guards + the `process.env[credentialRef]` resolution +
the factory call. An unset env ref answers the honest 503/400, never a
silent skip. **The env-ref is documented as temporary**: "D6 uses
reference→environment resolution as a controlled single-deployment
credential mechanism. The provider interface is stable; credential
storage is replaceable in D6+/E." The SaaS multi-tenant token problem
(Acme's token A, Beta's B, Gamma's C) is named, not hidden — the env
mechanism cannot become the permanent multi-tenant architecture.

**The LinearProvider itself**: one file, the StripeClient seam set
(fetchImpl/timeout/retry/backoff), the raw-key `Authorization` header
(NO Bearer — Linear's documented divergence, commented so nobody "fixes"
it), the GraphQL error envelope → one `LinearError` with `retryable`
computed once. `externalId` = the IDENTIFIER (LIN-482 — what the
acceptance names and the chips render); updateTask resolves it to the
UUID internally (cached). Linear has no idempotency header — the adapter
accepts the retry-contract window and implements the recovery instead;
that is what the interface's allowance ("providers that cannot honor keys
accept the retry contract's window") anticipated, now made honest by the
marker.

**The PG pairs land** (the D4/D5 deferral retired): four tables —
integration_connections (the (org,provider) unique carries the upsert),
integration_task_links (the (board,node,provider) unique), integration_
actions (connection_id + items jsonb — the payload IS the replay
source), execution_ledger (the composite PK (board_id,provider,
request_id); attempts decided by the first INSERT; the status-guarded
re-claim restates isReclaimable in SQL — the pg-stripe-events doctrine).
main.ts's PG branch swaps the InMemory trio; the sweeper wires on the
Stripe-sweep interval pattern with recovery-first replay. Parity suites
run the same contract over both pairs.

**The web surfaces**: the ↗ chips (Intelligence rows + Board cards, the
link registry's join), the Sync button (whole-board — the route's own
semantics; per-node propose does not exist), the IntegrationPanel — the
ADR 0031 frozen preview shape rendered, not redesigned: the statement
verbatim, creates as add-rows, updates as mod-rows, Approve/Reject, the
post-approve results with ↗ issue links, the 409 as the panel's error.

**Deliberately not built**: inbound sync, conflict resolution, the
webhook receiver (D7 — `subscribeToChanges` stays unimplemented; the
Linear scheme is HMAC-SHA256 of the raw body in X-Signature, and the
Stripe receiver's three doctrines — raw-body-is-the-message,
verify-before-ledger, signature-is-the-auth — are the copied-verbatim
precedent when D7 ships it). OAuth flows + real multi-tenant credential
storage (the env-ref temporariness is the ADR clause; replacement is its
own ADR). Scope enforcement (Linear's keys carry no scope metadata —
account-role based; a local gate would be the "second system" the
owner's rule forbids). Link GC on node deletion (the sweep owns the
decision). Per-node propose, canvas chips, a connection-admin UI beyond
the status surface, an actions-history view, MCP link exposure (D7's
summary projection). AI-initiated external proposals (D9).

## Consequences

- The D5 pairing is honest per provider now: key-native providers get
  exactly-one-effect through the key; Linear gets at-least-once delivery
  + marker-based reconciliation. The ADR 0031 phrasing is corrected in
  this record — the guarantee was never provider-independent, and
  pretending it was would have shipped the LIN-482/LIN-483 failure as a
  surprise.
- The acceptance proves the recovery at the wire level: the hang lands
  the issue in the stubbed Linear store, the response is lost, and the
  retry's `recoverCreate(marker)` finds LIN-1 — one issue, one link, zero
  duplicates, and the wire saw exactly ten issueCreate mutations for ten
  actions.
- The factory map is the last interface change external providers will
  force: D8's GitHub/Jira/Figma/Slack adapters are each one file + one
  map entry + one config field, exactly as ADR 0030 promised.
- The workspace invariant is now pinned in the acceptance itself: after
  ten issues created, the board blob carries no provider/externalId/url —
  the link registry owns all of it, permanently.
- One test-harness lesson worth recording: the first e2e draft sent
  `method: "POST"` to the connection PUT route and read the 404 as a
  permission failure — a full debug probe cycle found the method. The
  15s-default race timeout also needed a bundle-level injection
  (`executionTimeoutMs`) so the hang arm runs in the test budget; the
  field is now a legitimate knob for slow-provider deployments.
