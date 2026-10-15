# @lucent/mcp

## 0.1.0

### Minor Changes

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

- 82a3560: Stage D7 — inbound sync, the symmetric human gate (ADR 0033). The webhook receiver copies the Stripe doctrines verbatim (raw-body-is-the-message, verify-before-ledger, signature-is-the-auth) with Linear's X-Signature HMAC; the signature is the org resolution (per-connection webhookSecretRef through the environment, all candidates computed before any match). Every inbound change queues for human accept — nothing auto-applies; the never-guesses rule produces dismiss-only warning rows (accept refuses 409). Accept commits as the system actor's first use (actorType "system", the provider as actorId, the acceptor as initiator) through the room-first + fallback path. Conflict semantics named: outbound-authoritative on explicit sync (supersession + the reported count), the provider's word never silently lost (both decisions update lastSyncedStatus). Three-layer dedupe (delivery/queue/resolution). The PG pairs + migration 0021; the parity contracts; the sweep's refetch-current-truth arm. Web: the External changes section, the Sync badge, the integrations-inbound frame, i18n en+hu. MCP list_external_links — read-only; no tool decides an inbound change.

### Patch Changes

- Updated dependencies [21262ce]
- Updated dependencies [880abea]
- Updated dependencies [ad64f3b]
- Updated dependencies [80322dc]
- Updated dependencies [34575f8]
- Updated dependencies [c0b5660]
- Updated dependencies [9651fb6]
- Updated dependencies [b2c3daa]
- Updated dependencies [b290972]
- Updated dependencies [6b7ab61]
  - @lucent/core@0.1.0
