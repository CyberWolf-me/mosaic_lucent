# @lucent/core

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

- 6b7ab61: Visual Intelligence V4+V5: the layout benchmark and the routed layered engine. A permanent deterministic visual-quality harness (crossings, overlaps, edge length, per-node sprawl, layout ms over synthetic boards at 20–500 nodes), which isolated and closed the layered engine's crossings explosion: cycle-safe layering (return edges no longer collapse the layering), the deep-chain wrap gated to chains only, and long edges routed through the rows as polylines (Edge.route) — 10,871 → 902 crossings at 500 nodes, edge lengths 4–26× shorter. Renderers, exports, and the benchmark all draw the same routed geometry.
