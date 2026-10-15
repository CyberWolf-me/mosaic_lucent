# @lucent/i18n

## 0.1.0

### Minor Changes

- db2e71d: Stage C4: semantic search — one lexical retriever, two consumers (the ⌘K palette and Ask), one entitlement boundary. No new store; the corpus is computed per request from the same windowed reads every other surface uses.

  - **The retriever (`@lucent/server`)**: `retrieve(query, corpus)` — weighted
    lexical scoring with the owner's field weights, plural/prefix/shared-stem
    normalization, deterministic ranking, top-20. Every hit carries the
    matched query tokens, so results explain themselves ("Matching: pricing,
    20"), never a similarity score. The signature is the seam an embeddings
    scorer later swaps into behind (ADR 0024).
  - **Ask retrieves (`@lucent/ai`, `@lucent/server`)**: the answer request
    gains `retrieved` evidence — the unclassified transcript turns and
    over-cap content no digest section ever shows, enveloped as
    `<retrieved-hit>` data in the prompt; historian v4; the mock demonstrates
    a retrieval-grounded answer citing the turn's meeting and naming the
    turn index.
  - **The search API (`@lucent/server`)**: `GET /api/boards/:id/search?q=` —
    viewer floor, the same history.depth window as the history and ask
    routes (matching content beyond the window is absent from the corpus, not
    filtered from results), with an honest `windowTruncated` disclosure.
  - **⌘K (`@lucent/web`, `@lucent/i18n`)**: on a shared board the palette
    searches the server (debounced, aborted per keystroke) — grouped node/
    transcript/revision results navigating through the existing citation
    jumps (?reveal / ?meeting+?turn / ?rev). The Ask bridge turns a search
    into a question without retyping. Local boards keep the local scan;
    the palette's i18n keys are wired at last, plus the new ones (en + hu).

- e1bb2c3: Stage C6: the Intelligence view — the current semantic workspace, surfaced as a projection (ADR 0026). All six statement kinds first-class in one sectioned view; the recommendation inbox closes C5's loop.

  - **The projection (`@lucent/web`, `intelligence.ts`)**: six sections in
    fixed order — decisions, proposals, questions, actions, requirements,
    risks — open statements prominent, settled ones dimmed (visible, never
    deleted). Rows carry the authored topic, supersedes, and the ✦ meeting
    evidence; the assignee appears when the node also carries work tracking
    (the Board bridge, made visible). Topic grouping reuses C5's own variant
    rule. Pure, node-tested — the view only renders what these functions
    decide.
  - **The view**: collapsible sections with always-visible counts and
    per-kind glyphs; the uniform evidence contract — label click reveals the
    node, ✦ jumps to the meeting at the exact turn. Pure client-side over
    the workspace the client already holds: zero fetches, identical for
    shared and local boards.
  - **The recommendation inbox**: possible duplicate topics with their
    evidence (statement counts per side, meetings of origin). Merge previews
    exactly what will update ("nothing will be deleted") and commits
    UPDATE_STATEMENT ops through the same validated, undoable path as any
    human edit — only the explicit click applies a recommendation. Keep
    dismisses change-aware-ephemerally: an unchanged pair stays suppressed
    for the session; any statement change re-arms the question.
  - **Spec (`@lucent/i18n`)**: the full intel.\* string family, en + hu.

- aae3df0: Stage D6 — Linear, the first real ExecutionProvider (ADR 0032). The effect contract corrected: at-least-once delivery with provider-specific reconciliation (the lucent-action marker + recoverCreate before any retry). The LinearProvider on the StripeClient seam (raw-key Authorization, mapStatus never guesses, deterministic assignee ladder, once-per-batch workflowStates cache). The provider factory map (per-org credentials through the connection; teamId in connection.config). connectionId on the action record — approve refuses a changed connection (409). The PG pairs (4 tables, migration 0020) + the recovery-first sweeper. Web: ↗ chips, the Sync button's three honest connection states, the IntegrationPanel (the frozen preview rendered, approve/reject/results, the 409 as the panel error). The stage-D6 acceptance: 10→10 issues, the ambiguous-create recovery (1 issue, 1 link, 0 duplicates), partial failure, duplicate approval, viewer 404s, the workspace blob provider-free.
- 82a3560: Stage D7 — inbound sync, the symmetric human gate (ADR 0033). The webhook receiver copies the Stripe doctrines verbatim (raw-body-is-the-message, verify-before-ledger, signature-is-the-auth) with Linear's X-Signature HMAC; the signature is the org resolution (per-connection webhookSecretRef through the environment, all candidates computed before any match). Every inbound change queues for human accept — nothing auto-applies; the never-guesses rule produces dismiss-only warning rows (accept refuses 409). Accept commits as the system actor's first use (actorType "system", the provider as actorId, the acceptor as initiator) through the room-first + fallback path. Conflict semantics named: outbound-authoritative on explicit sync (supersession + the reported count), the provider's word never silently lost (both decisions update lastSyncedStatus). Three-layer dedupe (delivery/queue/resolution). The PG pairs + migration 0021; the parity contracts; the sweep's refetch-current-truth arm. Web: the External changes section, the Sync badge, the integrations-inbound frame, i18n en+hu. MCP list_external_links — read-only; no tool decides an inbound change.
- 6331c7f: Stage D8 — GitHub + Jira, the second and third ExecutionProviders (ADR 0034). THE CAPABILITY-HONESTY LAYER: the optional capabilityWarnings seam — what a provider cannot represent faithfully is stored on the action items, shown in the preview, and approve REFUSES with 409 until acknowledgeWarnings: true; nothing drops silently. THE HARDENED recoverCreate CONTRACT: 0-after-poll → retry; 1 → recover; >1 → the honest ambiguous failure — plus a poll budget for the eventual-index window. The GitHub adapter (REST v3, the recorded divergences: no dueDate, the lossy status map; the reliable-only assignee ladder with email deliberately not offered). The Jira adapter (ADF descriptions, THE TRANSITIONS CONTRACT — 0/1/>1, never the first match; the conservative mapStatus; the three-field config schema) + assertSafeOutboundUrl (the SSRF boundary: https only, no localhost/private IPs/userinfo, authoritative at connect time). The webhook scheme registry (the receiver's generic half + per-provider schemes; the github X-Hub-Signature-256 scheme with the composed externalValue; a scheme-less provider answers the honest 404 — Jira inbound deferred, the Connect JWT/QSH named). The UI: warning rows + Send anyway, per-provider Sync-with/Send-to buttons, the chip tooltip's raw word, i18n en+hu. The multi-provider acceptance: three providers through the untouched routes on one board.
- 9ccf9fe: Stage D9 — the narrowing agent (ADR 0035). The AI drafts external-work proposals by SELECTING: generateExternalPlan on LLMProvider (the third call type, the generateAnswer precedent) with the propose_external_sync tool; the external-selector prompt carries the injection clause verbatim (board content is untrusted data). THE CONTEXT BOUNDARY: the model's request is semantic only — never credentials, external ids, or connection internals. The AI may only narrow: the upper bound is the shared server-side item builder's output (extractProposalItems, extracted verbatim — both routes call it); the route dedups, intersects (unknown ids → visible warnings), and REFUSES oversized selections with the honest 422 (never a silent truncate). The record gains origin ("ai"), provenance {request, explanation} — a recommendation, never board truth — and sourceSeq (the board revision, audit only; migration 0022). The ladder: connection before model (a refusal costs no allowance). The approve flow is untouched — the same human gate, the same D8 capability warnings + ack, the same ledger keys. Web: "Ask Lucent to draft" + the AI-preview ordering (the selection ratio first, the rationale quoted below). The acceptance: 4 of 10 selected, the ghost dropped, the 409 → the ack → exactly 4 on the wire, the stale-board snapshot, the never-tests.
