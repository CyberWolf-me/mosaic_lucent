# 17. Engineering Roadmap — the freeze, the gates, and what reopens engineering

> **Status after the 2026-09-02 real-provider gate (verdict A):** the meeting
> intelligence is good enough to put in front of real users. The engineering
> response to that is NOT another milestone — it is a freeze on new features
> until users tell us where the next problem actually is. This document is the
> rulebook for that freeze: what is frozen, what stays legal, and the specific
> evidence that reopens building.

## The guiding principle

**Lucent should not become the product that can generate the most things. It
should become the product that can understand the most and make that
understanding useful.**

The moat is the semantic canvas and the meeting intelligence that fills it —
not the number of artifact types, integrations, or layout options. Every
engineering decision from here is judged against that sentence.

## The freeze rule

**No new features until a decision gate (below) opens on user evidence.** The
core loop — talk → editable structured visual appears → read it back later —
is validated at ≈93 composite with zero human corrections across six real
meetings. It does not need more engineering to be testable; it needs users.

These reasons are **explicitly not sufficient** to reopen a work stream:

- _"It would be cool."_ Cool is not a user problem.
- _"Competitor X has it."_ Feature parity is a treadmill; understanding
  quality is the differentiator.
- _"We'll need it someday."_ Someday is not now; the model stays additive
  (see the keep-list).
- _"The architecture would be cleaner."_ Refactors without a user-facing
  failure are vanity engineering.

### What stays legal during the freeze

1. **Production safety.** Data loss, security, authentication
   vulnerabilities, broken persistence, provider-outage handling, corruption,
   serious crashes. These are infrastructure requirements, not features —
   the audit below records what shipped under this clause and the one known
   boundary that remains.
2. **Benchmarks and measurement.** Running the eval sheet, adding fixtures,
   scoring. Measuring is never building.
3. **User evidence gathering.** Deploying, onboarding testers, watching
   sessions, collecting the category answers.
4. **Bug fixes to shipped behavior.** When a shipped feature is wrong
   (the live-gate CSS findings are the canonical example: two bugs where
   shipped interactions silently didn't work), fixing them is maintenance,
   not new scope.

## The decision gates

The next engineering phase is **NOT automatic**. It is chosen by evidence
against these gates, in order:

| Gate | Question                                   | Status                                                 | What passing it means                                                    |
| ---- | ------------------------------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------ |
| A    | Does Lucent understand meetings?           | **PASS** (2026-09-02, composite ≈93, zero corrections) | Ship to users; freeze features                                           |
| B    | Do users come back and reuse it?           | UNKNOWN — needs usage data                             | Without repeat usage, nothing else matters; find out why before building |
| C    | What is the adoption blocker?              | UNKNOWN — needs user reports                           | Users name the wall (from the category list below)                       |
| D    | Which investment does the evidence demand? | DATA-DRIVEN                                            | The gate's evidence picks the phase — not taste, not competition         |

### The category list users will answer from

When we ask testers "what's the next problem," their answers land in these
categories. Each maps to a known, deliberately-not-built work stream:

- **Identity / sharing** — accounts, share links, roles (live-verified;
  one gap → P2 boundary below)
- **Realtime collaboration** — live boards (live-verified; multiplayer undo
  uses snapshots by design)
- **AI quality** — the meeting intelligence (Gate A's subject)
- **Visual clarity** — reading large boards (focus + collapse shipped
  2026-09-02; connector tiers deliberately deferred)
- **Meeting memory** — cross-meeting decision evolution (single-meeting
  memory is complete; cross-meeting is Stage C territory)
- **Execution** — turning boards into tracked work (issue fields exist;
  execution views do not)
- **Integrations** — external tools (none built)
- **Lattice connection** — the cross-board knowledge layer (not built)
- **Advanced layout** — beyond the four engines (not built)

Two worked examples of the discipline:

- _If users say "I lose track of what we decided across meetings"_ →
  cross-meeting memory (Stage C). That is a Gate C→D path.
- _If users say "I can't share this with my team properly"_ → sharing/identity
  work. Also Gate C→D — but the P2 boundary below may already cover the
  common case.

## What shipped before the freeze (Stage A, 2026-09)

The approved post-gate package — five independent commits plus the
live-verification pass, all bisectable:

1. **Provider retry parity** (`packages/ai`, 3228bf5) — the stream-restart
   contract: a failed attempt restarts the ENTIRE generation and discards
   the incomplete stream; never append. `message_stop` is the whole-answer
   frame — its absence means truncation in transit (retryable); a parse
   failure WITH it means the model answered badly (not retried). The named
   test: partial stream → retry → complete response → exactly one commit.
2. **Semantic attribution rule** (7ebfee2) — genuine commitment or explicit
   tasking → action + SET_ISSUE assignee, in any meeting style; hedged or
   speculative mentions → no assignee, often no action; a mention is never
   an owner. Both polarities pinned in golden cases ("I'll think about it" →
   no task; "we should probably ask Sarah" → no assignee).
3. **Provenance stable references** (4becb03) — turnRange/turnKinds stored
   as the stable reference (a quote is presentation and moves if transcript
   normalization changes); the ✦ on the HUD jumps to the Meeting view with
   the source meeting selected — the board→evidence half of bidirectional
   navigation, with the reverse link shaped for.
4. **Storage guard** (de6037e) — in-memory + auth + production refuses to
   boot (data loss is not a silent fallback); dev warns loudly.
5. **Non-destructive dangling edges** (96ee6f0) — parseWorkspace retains
   edges whose endpoints don't resolve (render-layer skip is the belt);
   load→drop→save no longer permanently deletes them.

Plus the **live gate** — the browser verification the unit suites can't
replace — which found and fixed two real bugs in shipped P1 features
(59d839e: regions were un-collapsible with a mouse — pointer-events; 736d448:
entrance animations pinned their final frame at animation precedence,
silently nullifying the focus grades, the spotlight dim, the hover lift,
the presentation caption's centering, and disabled menu items).

## The keep-list (what the freeze protects)

The validated core is **additive-only** from here — changes may extend it
but not rework it:

- The semantic model + operation schema (`@lucent/core`) — the stable
  contract between AI and renderer.
- The differential meeting loop with statement kinds as data.
- The bespoke renderer (no tldraw/React Flow/dagre; the layout engine owns
  geometry).
- Server-authoritative sequenced ops (not CRDT).
- One provider call, one prompt, one derived tool — layout and validation
  deterministic.

## Known boundaries (recorded, deliberately not built)

- **P2 — server-side proposal state.** A pending review-gate proposal for a
  SHARED board lives only in the proposing browser's localStorage; that
  browser is the sole source of truth for the batch until decided. The fix
  is server-side proposal records through the boards API — Stage B scale.
  Recorded here so it is a planned boundary, not a surprise.
- Cross-meeting decision evolution, execution views, integrations, the
  lattice, advanced layout tiers — all Stage C+ candidates awaiting Gate
  C/D evidence.

## The audit table (the "be the user" pass, 2026-09)

Category-by-category honest assessment that produced the freeze decision:

| Category               | Verdict                                       | Evidence                                                            |
| ---------------------- | --------------------------------------------- | ------------------------------------------------------------------- |
| Identity / sharing     | works; one gap (P2 above)                     | share links, viewer/editor roles, email-gated invites live-verified |
| Realtime collaboration | works                                         | live broadcast, presence, role gating live-verified                 |
| AI quality             | **Gate A: PASS**                              | composite ≈93, zero corrections, all four adversarial traps passed  |
| Visual clarity         | shipped + live-verified (after the two fixes) | focus grades measured in-DOM; collapse/expand round-trip exact      |
| Meeting memory         | single-meeting complete                       | cross-meeting evolution deliberately Stage C                        |
| Execution              | not built (by design)                         | issue fields exist; no execution views                              |
| Integrations           | not built (by design)                         | none                                                                |
| Lattice                | not built (by design)                         | none                                                                |
| Advanced layout        | not built (by design)                         | four engines suffice for the tested boards                          |

**The three safety findings** from the audit: P1 storage guard (shipped),
P3 non-destructive load (shipped), P2 server-side proposals (recorded as
the boundary above).

## What happens next

1. Deploy to a handful of real teams (verdict A's instruction).
2. Collect Gate B (repeat usage) and Gate C (named blockers) evidence.
3. The first gate to fail picks the next phase — and only then does
   engineering reopen, on the evidence, through the decision that Gate D
   names.

## Amendment (2026-09-02): Stage B executed — the platform core completed

The freeze's own rule admits engineering on an owner decision grounded in the
audit, and the owner made one: the four gaps the audit named (all
engineering-verified, none user-demanded yet) were exactly the ones that make
shared boards untrustworthy, and Stage B closed them. Recorded honestly: this
reopening was **not** Gate B/C evidence — it was the owner accepting that the
P2 boundary, the missing idempotency protocol, and the dropped-edit failure
modes would be found by users as breakage, not as feature requests.

What Stage B shipped (batches, commits, and the full acceptance scenario in
`packages/server/test/stageB.definition.e2e.test.ts`):

- **B1 — the operation protocol** (c87a832): requestId idempotency (the replay
  guard runs BEFORE validation — recognizing a retry by re-checking its ops
  answers a retried CREATE with "already exists" and double-applies a retried
  MOVE), explicit `op-ack` frames, server-generated `operationId`, and a
  partial unique index at the database. ADR 0016.
- **B2 — the actor model** (0d5f44a): `user | ai | system` plus
  `initiatedBy`/`approvedBy` on every log entry — "✦ Lucent created 4 nodes,
  initiated by Alex, approved by Sarah" is now true of the record. ADR 0017.
- **B3 — server-side proposals** (6ff0686): the P2 boundary. The record, the
  transition guard, the one-pending invariant, approval through the room with
  the full accountability chain, and live panels on every connected browser.
  ADR 0018.
- **B4 — reconnect resilience** (c4ab04c): the pending-op queue (edits on a
  dead socket queue and replay exactly-once), resync below the snapshot floor
  (never a partial catchup), snapshot-anchored room rebuilds (ADR 0010 finally
  wired — a 50k-entry board stopped replaying its whole history on cold join),
  eviction-time compaction, `latestSeq` on the board snapshot, and the durable
  replay lookup the resilience tests found missing.

Explicitly NOT built, per the plan's decisions: commenter/admin/guest roles
and `can()` (owner/editor/viewer stays; the vocabulary opens on a real team's
"discuss without edit"), the workspace hierarchy tier (org→board stays;
"workspace" is the canvas document), AI room participation (actor typing
delivers the auditability; presence is a UX call), magic-link login,
server-derived undo inverses.

The freeze resumes on the same terms: production safety, benchmarks, user
evidence, infrastructure requirements. Gate B (repeat usage) and Gate C
(adoption blockers) remain UNKNOWN — the next engineering phase still comes
from users, not from us.

## Amendment (2026-09-03): Stage C1 executed — history and Ask

The owner decision that reopened engineering for C1: the Stage C document's
first batch (C1: history API + history UI + Ask mode), with three review
amendments folded in before implementation — `history.depth` bounds the
ENTIRE context Ask consumes (not just the history list), the two scope
guarantees (context and citation) are locked by tests, and the Ask context
builder is a projection, never a second memory layer. Recorded honestly:
same footing as Stage B — an owner decision grounded in a plan, not Gate
B/C user evidence.

What Stage C1 shipped (batches, commits, and the acceptance scenario in
`packages/server/test/stageC1.definition.e2e.test.ts`):

- **The answer call type** (`@lucent/ai`): `generateAnswer` joins
  `generateOperations` as the second provider surface. Build mutates; Ask
  reads. The board-historian prompt (registry v2) emits no operations, and
  its honesty rule — a truncated window is disclosed, never answered as
  "nothing happened" — is the trust behavior the whole feature rests on.
  ADR 0020.
- **The window** (`@lucent/server`): `historyWindow()` is the single piece
  of arithmetic both the timeline and Ask consume. `history.depth` is
  enforced at the read boundary and nowhere else — nothing is deleted to
  enforce a plan, an upgrade instantly widens the window over the same log,
  and the meeting digest is windowed to the same floor so Ask cannot leak
  what the timeline refuses to show. ADR 0019.
- **The routes**: `GET /api/boards/:id/history` (viewer floor; the
  summarized timeline — actor names, touched ids, the Stage B3 proposal join
  by appliedSeq — with the honest `hasMore`/`historyDepth` envelope) and
  `POST /api/boards/:id/ask` (viewer floor; same allowance as Build,
  metered `mode: ask`; citations validated against real, caller-visible
  state and dropped into `warnings` while the answer survives).
- **The surfaces** (`@lucent/web`): the AI pill's Build/Ask segmented
  toggle (one surface, two directions), amber ✦ citation chips that jump to
  evidence (node → select+focus, meeting → the transcript with the turn
  range highlighted — the reverse-provenance interaction, now real —,
  revision → the history view), and HistoryView upgraded to the server
  timeline for shared boards (day-grouped, actor-named, depth banner) with
  the local client timeline untouched.

Explicitly NOT built, per the plan's decisions: history pagination (the
2,000-entry response ceiling plus `hasMore` is honest; paging when a real
board hits it), SSE for Ask (answers are short; the seam exists if latency
ever hurts), semantic search/embeddings, the MCP `get_board_history` tool
(two-line addition behind the same window when wanted), any Knowledge
collection (statements stay on nodes; transcript context covers the rest),
decision/action lifecycles and cross-meeting memory (C2's territory — built
on canonical state, not on askContext's projection).

The freeze resumes on the same terms. The next C batch (semantic lifecycle)
reopens on the same rule as this one: a plan, an owner decision, and the
scope guarantees named before code.

## Amendment (2026-09-04): Stage C2 executed — the semantic lifecycle

The owner decision that reopened engineering for C2, on the same footing as
C1: the Stage C document's second batch (statements + evidence), with the
review's three implementation amendments folded in — provenance as a field
of the ORIGINATING operation (no post-pass, no SET_PROVENANCE synthetic
event; the review rewrote the proposed implementation before any code), the
six-kind vocabulary with the freeze rule (a new kind needs a distinct
lifecycle, not a label; fact/constraint stay transcript context), and chips +
HUD editor only (no Decision view — C6's projection, built later from this
same state).

What Stage C2 shipped (batches, commits, and the acceptance scenario in
`packages/server/test/stageC2.definition.e2e.test.ts`):

- **The statement contract** (`@lucent/core`, ADR 0021): six kinds
  (decision/proposal/question/action/requirement/risk), four lifecycle
  statuses, `SET_STATEMENT`/`UPDATE_STATEMENT` mirroring the issue layer,
  visible supersession (the reducer marks targets superseded, preserving
  their identity fields), cycle-safe validated supersession graphs,
  repair ordering for backwards-emitted batches, and undo that restores
  every superseded target. The identity rule holds: relabel/transform never
  touch a statement or its provenance.
- **The model learns statements** (`@lucent/ai`): visual-agent v4 teaches the
  doctrine as data (decisions born resolved; proposals never decisions;
  rejections flip or supersede; kind never changes), the summary carries
  statements so the model can update what it sees, the historian v2 answers
  "what did we decide about pricing?" from the digest's statement brackets,
  and the offline mock/golden gate pins the shapes.
- **The evidence fix** (`@lucent/server`, `@lucent/web`, ADR 0022): the C1-era
  divergence the C2 recon proved — the meeting stamp existed only in the
  capturing browser, and the review-gated path stamped nobody — is closed as
  a correctness fix. Provenance rides the ops (attachProvenance, three
  writers, one helper), so it lands in history, on peers, in the server
  board, and in the log, by construction. The convergence contract is a
  test: undo removes exactly, replay carries exactly.
- **The surfaces** (`@lucent/web`): the ✦ chip on every statement node
  (kind · status, settling as it closes), the HUD statement editor (kind/
  status/topic/supersedes committed through the same validator the AI
  faces — a statement-less target or a cycle is refused visibly), and the
  meeting prompts teach the ops mapped from turn kinds.

Explicitly NOT built, per the plan's decisions: Decision/Action/Risk views
(C6's projections over statementNodes()), per-kind status machines (the
label + the log carry the nuance), topic entity resolution (C5 — the kebab
key is the seam), cross-meeting memory (C3), semantic search (C4), statement
provenance on UPDATE (evidence attaches at creation), and any fact/constraint
kind (the freeze rule's first application).

Gate: typecheck 0 and tests green across all six packages; the definition
scenario passes the continuous story (live meeting on a SHARED board →
decision node with statement + provenance in the ops → second browser sees
both → ✦ jumps to the transcript → Ask cites the node → a later rejection
supersedes visibly and undo restores → the gated path stamps everyone →
relabel preserves meaning → a HUD cycle attempt is refused).
