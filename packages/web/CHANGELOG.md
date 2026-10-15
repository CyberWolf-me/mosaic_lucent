# @lucent/web

## 0.1.0

### Minor Changes

- 21262ce: Diagram regions: multiple diagram kinds on one board, each editable by text or voice.

  - `Group` gains an optional `kind`; a group carrying one is a _diagram region_ laid out under that kind's strategy while the rest of the board keeps its board-wide kind. Existing boards and swimlane lane groups are unchanged (ADR 0014).
  - New `SET_GROUP_KIND` operation changes or dissolves one region — "change the pricing section to an org chart" re-lays only that region, with full undo. `CREATE_GROUP` accepts the `kind` so the AI can add a second diagram kind to a populated board without transforming it.
  - The layout engine partitions regions into sub-workspaces, each under its own strategy, and packs them in a band with gutters; pinned nodes keep their hand-placed coordinates.
  - The AI summary and prompt (v3) carry and teach region targeting; the mock provider and golden evals cover both the "add a mind map region" and "retarget one region" flows. MCP agents get the new operation automatically via the derived tool schema.
  - Web: region boxes show their kind, the group context menu offers the same kind picker as the board, and SVG exports label region boxes.

- 880abea: Milestone 2: boards that grow without rearranging — the spatial-additivity invariant and the live meeting loop (ADR 0015).

  - commit() now relayouts ONLY the group a batch touches, at its current origin: every other node keeps its exact committed position (relayoutRegion + separateRegions in core; a growth overlap shifts just the overlapped neighbours). Verified live: a 22-node board held pixel-identical through a second topic's extraction.
  - Meeting capture extracts DIFFERENTIALLY while recording — hybrid trigger (speaker-pause OR burst OR overdue, debounced, one generation in flight), an additive-only auto-apply list, and a review gate for destructive/oversized batches. The prompt updates rather than duplicates: live topic-switch test UPDATED the existing Pricing region (5→7 members, one region, no "Pricing #2").
  - Speaker identity through the STT seam: LiveKit segments' participant identity is read; the browser provider fires per-utterance finals (segment mode) instead of one blob at stop.
  - Transcript checkpoints: a capture opens its server transcript at start and appends after each extraction (new POST /:mid/turns route, in-memory + Postgres parity) — a refresh mid-meeting loses nothing; ended meetings stay immutable; stop auto-saves.
  - Provenance: meeting-extracted nodes carry the meeting id, quoted turns, and timestamp; the node HUD shows a ✦ whose tooltip quotes the discussion that created it.

- fc2b928: Bundled release for the M5–M7 milestone work.

  - Streaming generation end-to-end: providers stream natively (OpenAI-compatible tool-call/prose lanes, Anthropic `input_json_delta`), `POST /api/generate/stream` serves the same validated pipeline over SSE, and the web client shows receipts as the payload arrives. Opt-in BYO provider keys behind `LUCENT_ALLOW_BYO_KEYS`.
  - SCIM 2.0 gateway for enterprise provisioning (`/scim/v2/Users`, bearer-token auth, deactivate = session invalidation) with the `scim_identities` migration.
  - OAuth sign-in (Google, GitHub) linking by verified email only; asset upload gateway with byte caps and org scoping; owner-visible org analytics trend; SLO document.

- 2de5aef: Persist proposals, measure the meeting intelligence, and make large boards readable (P0-1…P1).

  - **Persisted proposals (P0-1)**: a review-gate batch is now a durable
    record on the project — id/boardId/meetingId/turns/operations/status/
    createdAt — with idempotent approve/reject (a decidedRef guard set before
    any await, so a double-click, a replayed call, or a decision after a
    reload can never commit twice), an audit trail (proposalHistory, capped at
    10, statuses pending/approved/rejected/superseded), rehydrate-on-boot (a
    pending record reopens the review panel after a hard reload), cross-
    project isolation on every project-switch path, and stale-batch safety
    (apply re-validates via applyValidOperations: a rehydrated proposal whose
    ops reference nodes deleted before the reload applies its valid remainder
    and reports the skips). Live-gated: proposal → hard reload → panel
    restored → approve → board commits once (25→34 nodes) → record archived.
  - **Meeting evaluation harness (P0-2)**: five scripted meetings (product
    launch, architecture topic-jumping, brainstorm disagreement, planning
    with owners, and the adversarial messy meeting) as fixtures, a 21-test
    offline suite driving the differential-loop policies across all five,
    and docs/16 — the eight-metric scoresheet (capture, precision, statement
    kinds, continuity, correction handling, attribution, 10-second
    readability, "why is this on the board?") with the run protocol. The
    suite caught and fixed a real gap on its first run: rejections ("no,
    we're not doing X") now classify as decisions.
  - **Statement kinds as data (P0-3)**: extracted nodes carry the source
    turns' deterministic kinds in provenance (turnKinds), the HUD ✦ shows
    them beside the quote, and the differential prompt teaches the full kind
    contract — proposals are never decisions, a rejection visibly supersedes
    what it rejects, a correction replaces the earlier node in place, a
    mention is not an owner ("talk to Sarah" ≠ assigned to Sarah), and small
    talk emits nothing. Four golden cases pin it at gate 1.00 (with mock
    scripts so the offline gate stays honest).
  - **Visual clarity, minimal (P1)**: selection focus (selected node + edge
    neighbours stay full strength, everything else recedes; edges stay drawn
    when either endpoint is prominent — pure opacity, no data/layout changes)
    and region collapse (a kind-region renders as a labelled summary card
    with member/edge counts and an Expand button; double-click to collapse;
    expand returns the exact prior geometry because the model never changed).

- ad64f3b: Stage A: the evidence-named fixes from the real-provider gate, plus the feature freeze.

  - **Provider retry parity (`@lucent/ai`)**: the stream-restart contract — a
    failed attempt restarts the entire generation and discards the incomplete
    stream, never appends. A stream missing `message_stop` is classified as
    truncation in transit (retryable with backoff); a parse failure after it is
    the model answering badly (not retried). The named case is pinned: partial
    stream → retry → complete response → exactly one commit.
  - **Semantic attribution rule (`@lucent/ai`, `@lucent/web`)**: genuine
    commitment or explicit tasking creates the action and its assignee in any
    meeting style; hedged or speculative mentions create no assignee and often
    no action. Both polarities are golden cases ("I'll think about it" → no
    task; "we should probably ask Sarah" → no assignee).
  - **Provenance stable references (`@lucent/web`)**: `turnRange`/`turnKinds`
    stored as the stable reference (the quote is presentation); the selection
    HUD ✦ jumps to the Meeting view with the source meeting selected.
  - **Storage data-loss guard (`@lucent/server`)**: in-memory + auth +
    production refuses to boot; dev warns loudly.
  - **Non-destructive load (`@lucent/core`)**: dangling edges are retained on
    parse (render-layer skip is the belt) instead of silently deleted —
    load→drop→save no longer permanently removes them.
  - **Live-gate CSS fixes (`@lucent/web`)**: regions are now collapsible with a
    real pointer (pointer-events on the region box and the bounds frame), and
    entrance animations no longer pin their final frame at animation
    precedence — which silently disabled the selection-focus grades, the
    spotlight dim, the hover lift, the presentation caption's centering, and
    disabled-item dimming.
  - **The freeze (`docs/17`)**: no new features until a decision gate opens on
    user evidence; production safety, benchmarks, and fixes to shipped
    behavior stay legal. Decision gates: A (understand meetings) PASS; B
    (repeat usage), C (adoption blocker) need user data; D (which investment)
    is data-driven.

- 80322dc: Stage B: the multi-user operation protocol — idempotency, actors, server-side proposals, reconnect resilience.

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

- ef0f4bd: Stage C1: history and Ask — the board's evolution becomes queryable, and the AI pill learns to answer questions about it with citations.

  - **History API (`@lucent/server`, `@lucent/web`)**: `GET
/api/boards/:id/history` serves the op log's windowed revision timeline —
    actor names, labels, touched objects, and the proposal link for gated
    changes. `history.depth` (Free 25 / Pro 500 / unlimited) is enforced as a
    read boundary for the first time: nothing is deleted, so upgrading
    instantly reveals the older revisions of the same log (ADR 0019).
  - **Ask Lucent (`@lucent/server`, `@lucent/ai`, `@lucent/web`)**: the AI
    pill gains a Build/Ask toggle. Build mutates; Ask answers questions about
    the board and its history, read-only, and every citation is validated
    against real, caller-visible state before it renders — an invented or
    out-of-window citation is dropped while the answer survives (ADR 0020).
    Viewers may ask (asking is reading); asks bill the same monthly AI
    allowance, metered with `mode: ask`.
  - **The answer call type (`@lucent/ai`)**: `generateAnswer` joins
    `generateOperations` as the second provider surface, with the
    board-historian prompt (emits no operations) and the
    `answer_with_citations` tool derived from the same Zod-first pattern as
    the canvas tool. The offline MockProvider cites only ids the context
    really contains, so the offline demo exercises the same citation
    validation the real provider faces.
  - **Honest windows everywhere**: truncated history is disclosed in the API
    envelope (`hasMore`/`historyDepth`), in the model's context (the historian
    prompt's rule: never answer "nothing happened" on the strength of a
    short window), in the history view's depth banner, and by the meeting
    digest sharing the same window floor.

- 34575f8: Stage C2: the semantic lifecycle — statements live on nodes, and meeting evidence finally converges.

  - **Statements as operations (`@lucent/core`, ADR 0021)**: `SET_STATEMENT`
    and `UPDATE_STATEMENT` give a node its meaning — decision, proposal,
    question, action, requirement, or risk — with an open/resolved/rejected/
    superseded lifecycle, kebab-case topics, and validated supersession links
    (visible by reducer side effect, cycle-safe, restored exactly on undo).
    The kind set is closed and frozen: new kinds require evidence of a
    distinct lifecycle. A statement survives relabels and transforms.
  - **Provenance rides the operation (ADR 0022)**: `CREATE_NODE` gains the
    meeting evidence (id, turn range, kinds, quote) that produced it, attached
    by the meeting loop before commit. The old browser-local stamp never
    reached peers, history, or the server — on shared boards it silently
    vanished, and review-gated extractions stamped nobody. Now the evidence
    lands everywhere the ops land, by construction, and Ask's "why is this
    here?" answers from converged data.
  - **The model and agents see meaning (`@lucent/ai`, `@lucent/mcp`)**: the
    build prompt teaches the doctrine as data (decisions are born resolved; a
    rejection supersedes visibly; kind never changes), the board summary
    carries statements so the model can update what it sees, Ask answers
    "what did we decide about pricing?" from statement brackets, and MCP's
    get_board projects them for agents.
  - **Visible + editable (`@lucent/web`)**: a kind·status chip on every
    statement node, a HUD editor whose manual edits commit through the same
    validator the AI faces, and the ✦ evidence jump working on shared boards.

- 6e18ac6: Stage C3: cross-meeting memory — the chain, the reverse link, and the merged timeline. No new store: memory is the reading of state C2 made canonical.

  - **Evolution answers (`@lucent/ai`, `@lucent/server`)**: the Ask digest
    renders every statement supersession with each side's meeting of origin,
    and the historian answers "why did we change pricing?" by reading it —
    naming turn indices, which now ride the answer contract alongside an
    honest meetings window (`meetingsTruncated` says when older meetings fell
    outside the digest, the same rule C1 set for revisions).
  - **Meetings end for real (`@lucent/server`, `@lucent/web`)**: live
    captures get real boundaries (`MeetingStore.end`, an idempotent end
    route) instead of abandoning the id and leaving the store saying "in
    progress" forever.
  - **Reverse provenance (`@lucent/web`)**: a transcript turn lists the board
    objects it produced ("✦ 2 objects · view") — a pure scan of the workspace
    the browser already holds, the payoff of C2's ops-level provenance. The
    canvas ✦ jump now lands on the exact turns (`?turn=`), matching the Ask
    citation contract.
  - **The project timeline (`@lucent/web`, `@lucent/server`)**: HistoryView
    becomes the merged chronology — revisions, meeting markers, and statement
    events ("decision made · superseded a previous statement") in one
    day-grouped surface, each row jumping to its evidence. Statement events
    derive from the log's own operations; no new view was added.

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

- c0b5660: Stage C5: topic entity resolution — normalize, group, and challenge; never silently overrule. One deterministic variant rule shared by the fold, the detector, the HUD hint, and the Ask grouping; nothing persisted (ADR 0025).

  - **The fold (`@lucent/core`)**: `topicFold.ts` — canonicalizeTopic (morphology
    only), topicsAreVariants (segment sets equal or subset: pricing ≡
    pricing-model ≡ price ≡ prices; monetization and customer-acquisition stay
    apart by design), foldStatementTopics (converge on the board's existing
    authored key when exactly one candidate; novel and ambiguous untouched;
    deterministic batch-collision representatives; idempotent), and
    possibleDuplicateTopics — evidence-bearing pairs for the challenge layer.
  - **Teaching (`@lucent/ai`, `@lucent/web`)**: visual-agent v5 and both
    meeting-extraction prompts teach topic reuse — the board's existing topics
    are the vocabulary. A mock reuse script + the golden
    topic-reuse-over-variant case pin the doctrine (offline gate stays at
    score 1).
  - **Every machine-op boundary folds (`@lucent/server`, `@lucent/web`)**:
    generate (repaired re-emissions too), MCP ops, proposal approval, room
    commits with the ai actor, and the client's send/proposal paths. Human ops
    never fold — the room's user-actor batches and the HUD's applyManual are
    pinned untouched.
  - **The challenge at authoring time (`@lucent/web`)**: the HUD topic field
    offers the board's authored keys and surfaces a possible-duplicate hint
    with statement-count evidence — Use adopts the existing key through the
    same validated edit path (an explicit user action), Keep dismisses.
  - **The Ask payoff (`@lucent/server`)**: the digest's statements-by-topic
    section groups every spelling of a subject under one section, so "what
    happened with pricing?" reads as one answer even when authored keys
    disagree.

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

- 9651fb6: Stage D1: the execution model — the action becomes executable work (ADR 0027). One node, two layers, one vocabulary; no second task store, no new operation family.

  - **The fields (`@lucent/core`)**: IssueFields gains `dueDate` (ISO
    YYYY-MM-DD, regex-validated — the system's first date field) and
    `description` (≤2000). UPDATE_ISSUE patches both; no field ever derives
    another — "assigned" is an initialization convention, not a derived state,
    and the statement lifecycle never derives from the issue status. All five
    schema/restatement places landed; the persistence round-trip test guards
    the strip trap.
  - **The vocabulary (`@lucent/core`)**: the canonical execution statuses —
    open, assigned, in_progress, blocked, completed, cancelled — as
    convention + teaching + an explicit Board-column projection (not a zod
    enum; existing free-form boards load unchanged). `actionNodes()`
    selects the executable actions; `resolveDueDate()` resolves "by Friday"
    deterministically against a reference timestamp — never stores the word.
  - **Teaching (`@lucent/ai`, `@lucent/web`)**: visual-agent v6 and the
    meeting-extraction prompt teach dueDate resolution, the vocabulary, and
    the attribution boundary (a hedged mention creates no deadline-bearing
    task). The mock finally carries the date its explanation always claimed;
    the golden gate pins the full D1 action at score 1.
  - **The surfaces (`@lucent/web`, `@lucent/mcp`)**: the Intelligence action
    row completes (assignee, due date, execution status, overdue tint —
    rendered, never persisted); Board cards show the due-date chip; MCP's
    board summary exposes the fields so agents reason over deadlines.

- b2c3daa: Stage D2: semantic state → plan — the board proposes its own execution (ADR 0028). The B3 proposal pipeline is the plan's approval; the anti-conversion rule is mechanical; every plan item traces to its source statements.

  - **createdFrom (`@lucent/core`)**: the provenance family's second evidence
    kind — source statement ids stamped on generated plan items via
    attachPlanProvenance (merging with meeting evidence, idempotent), riding
    the one pipeline: validate, log, peers, undo.
  - **The plan gate (`@lucent/web`)**: PLAN_SAFE_OPS filters a plan's ops to
    creation and organization — UPDATE_STATEMENT is mechanically absent, so
    no plan can silently resolve a question or confirm a proposal. Skipped
    ops are reported, never silently dropped.
  - **Deadlines visible (`@lucent/ai`, `@lucent/server`)**: the board summary
    carries issue.dueDate and description — a plan preserves the deadlines it
    can now see.
  - **The input surfaces (`@lucent/web`, `@lucent/mcp`)**: canvas multi-select
    → the pill (unchanged), and Intelligence checkboxes → "Plan from
    selection" — both one send. MCP exposes plan sources per node.

- b290972: Stage D3: dependencies & blockers — the flat work becomes an execution graph (ADR 0029). Typed relationships on existing edges; cycles rejected at the authoritative validator; derived truth computed beside manual state, never merged.

  - **The graph (`@lucent/core`)**: `depends_on` (canonical) and `blocks`
    normalize into one upstream adjacency; `related_to` never propagates.
    The validator rejects dependency cycles — including ones formed within a
    single AI batch — naming the cycle. Deletion and undo inherit the edge
    machinery unchanged.
  - **Derived execution (`@lucent/core`)**: `blockedBy` (transitive upstream
    blocked, executable nodes only) and `atRiskBy` (overdue-unfinished
    upstream — blocked not excluded, trouble compounds) — a pure projection,
    never stored, recovery is re-computation. Manual `issue.status` stays
    independently editable; the two layers never merge.
  - **Teaching (`@lucent/ai`)**: visual-agent v8 teaches the vocabulary with
    the direction pinned — the waiting work is the source, the prerequisite
    is the target. The golden gate pins the direction at score 1.
  - **The surfaces (`@lucent/web`, `@lucent/mcp`, `@lucent/server`)**:
    Intelligence shows blocked-by/at-risk lines; the Board card carries the
    ⚠/⌛ badges without refiling; dependency edges render as a quiet dash;
    MCP and the Ask digest expose the derived truth so agents and answers
    reason over structure, not labels.

- aae3df0: Stage D6 — Linear, the first real ExecutionProvider (ADR 0032). The effect contract corrected: at-least-once delivery with provider-specific reconciliation (the lucent-action marker + recoverCreate before any retry). The LinearProvider on the StripeClient seam (raw-key Authorization, mapStatus never guesses, deterministic assignee ladder, once-per-batch workflowStates cache). The provider factory map (per-org credentials through the connection; teamId in connection.config). connectionId on the action record — approve refuses a changed connection (409). The PG pairs (4 tables, migration 0020) + the recovery-first sweeper. Web: ↗ chips, the Sync button's three honest connection states, the IntegrationPanel (the frozen preview rendered, approve/reject/results, the 409 as the panel error). The stage-D6 acceptance: 10→10 issues, the ambiguous-create recovery (1 issue, 1 link, 0 duplicates), partial failure, duplicate approval, viewer 404s, the workspace blob provider-free.
- 82a3560: Stage D7 — inbound sync, the symmetric human gate (ADR 0033). The webhook receiver copies the Stripe doctrines verbatim (raw-body-is-the-message, verify-before-ledger, signature-is-the-auth) with Linear's X-Signature HMAC; the signature is the org resolution (per-connection webhookSecretRef through the environment, all candidates computed before any match). Every inbound change queues for human accept — nothing auto-applies; the never-guesses rule produces dismiss-only warning rows (accept refuses 409). Accept commits as the system actor's first use (actorType "system", the provider as actorId, the acceptor as initiator) through the room-first + fallback path. Conflict semantics named: outbound-authoritative on explicit sync (supersession + the reported count), the provider's word never silently lost (both decisions update lastSyncedStatus). Three-layer dedupe (delivery/queue/resolution). The PG pairs + migration 0021; the parity contracts; the sweep's refetch-current-truth arm. Web: the External changes section, the Sync badge, the integrations-inbound frame, i18n en+hu. MCP list_external_links — read-only; no tool decides an inbound change.
- 6331c7f: Stage D8 — GitHub + Jira, the second and third ExecutionProviders (ADR 0034). THE CAPABILITY-HONESTY LAYER: the optional capabilityWarnings seam — what a provider cannot represent faithfully is stored on the action items, shown in the preview, and approve REFUSES with 409 until acknowledgeWarnings: true; nothing drops silently. THE HARDENED recoverCreate CONTRACT: 0-after-poll → retry; 1 → recover; >1 → the honest ambiguous failure — plus a poll budget for the eventual-index window. The GitHub adapter (REST v3, the recorded divergences: no dueDate, the lossy status map; the reliable-only assignee ladder with email deliberately not offered). The Jira adapter (ADF descriptions, THE TRANSITIONS CONTRACT — 0/1/>1, never the first match; the conservative mapStatus; the three-field config schema) + assertSafeOutboundUrl (the SSRF boundary: https only, no localhost/private IPs/userinfo, authoritative at connect time). The webhook scheme registry (the receiver's generic half + per-provider schemes; the github X-Hub-Signature-256 scheme with the composed externalValue; a scheme-less provider answers the honest 404 — Jira inbound deferred, the Connect JWT/QSH named). The UI: warning rows + Send anyway, per-provider Sync-with/Send-to buttons, the chip tooltip's raw word, i18n en+hu. The multi-provider acceptance: three providers through the untouched routes on one board.
- 9ccf9fe: Stage D9 — the narrowing agent (ADR 0035). The AI drafts external-work proposals by SELECTING: generateExternalPlan on LLMProvider (the third call type, the generateAnswer precedent) with the propose_external_sync tool; the external-selector prompt carries the injection clause verbatim (board content is untrusted data). THE CONTEXT BOUNDARY: the model's request is semantic only — never credentials, external ids, or connection internals. The AI may only narrow: the upper bound is the shared server-side item builder's output (extractProposalItems, extracted verbatim — both routes call it); the route dedups, intersects (unknown ids → visible warnings), and REFUSES oversized selections with the honest 422 (never a silent truncate). The record gains origin ("ai"), provenance {request, explanation} — a recommendation, never board truth — and sourceSeq (the board revision, audit only; migration 0022). The ladder: connection before model (a refusal costs no allowance). The approve flow is untouched — the same human gate, the same D8 capability warnings + ack, the same ledger keys. Web: "Ask Lucent to draft" + the AI-preview ordering (the selection ratio first, the rationale quoted below). The acceptance: 4 of 10 selected, the ghost dropped, the 409 → the ack → exactly 4 on the wire, the stale-board snapshot, the never-tests.
- 6b7ab61: Visual Intelligence V4+V5: the layout benchmark and the routed layered engine. A permanent deterministic visual-quality harness (crossings, overlaps, edge length, per-node sprawl, layout ms over synthetic boards at 20–500 nodes), which isolated and closed the layered engine's crossings explosion: cycle-safe layering (return edges no longer collapse the layering), the deep-chain wrap gated to chains only, and long edges routed through the rows as polylines (Edge.route) — 10,871 → 902 crossings at 500 nodes, edge lengths 4–26× shorter. Renderers, exports, and the benchmark all draw the same routed geometry.

### Patch Changes

- Updated dependencies [21262ce]
- Updated dependencies [880abea]
- Updated dependencies [fc2b928]
- Updated dependencies [2de5aef]
- Updated dependencies [ad64f3b]
- Updated dependencies [80322dc]
- Updated dependencies [ef0f4bd]
- Updated dependencies [34575f8]
- Updated dependencies [6e18ac6]
- Updated dependencies [db2e71d]
- Updated dependencies [c0b5660]
- Updated dependencies [e1bb2c3]
- Updated dependencies [9651fb6]
- Updated dependencies [b2c3daa]
- Updated dependencies [b290972]
- Updated dependencies [aae3df0]
- Updated dependencies [82a3560]
- Updated dependencies [6331c7f]
- Updated dependencies [9ccf9fe]
- Updated dependencies [6b7ab61]
  - @lucent/core@0.1.0
  - @lucent/ai@0.1.0
  - @lucent/i18n@0.1.0
