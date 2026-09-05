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

## Amendment (2026-09-04): Stage C3 executed — cross-meeting memory

The owner decision, on the same footing as C1/C2: the Stage C document's
third batch. The plan's recon finding shaped everything: cross-meeting
memory is a projection over state C2 already made canonical (statements +
supersedes chains, op-level provenance with stable turn ranges, append-only
transcripts, C1's revision window) — so C3 adds NO new store anywhere. The
memory is the reading of it, forwards and backwards.

What Stage C3 shipped (batches, commits, and the acceptance scenario in
`packages/server/test/stageC3.definition.e2e.test.ts`):

- **The chain, first-class** (`@lucent/server`, `@lucent/ai`): the Ask
  digest's statement-evolution section renders every supersession with each
  side's meeting of origin; the historian v3 answers evolution questions
  from it, naming turn indices; the answer contract gains those indices
  and the honest meetings window (`meetingsTruncated` — the cap that was
  silent since C1 now states itself, even when it empties the section).
- **Real meeting boundaries** (`@lucent/server`, `@lucent/web`):
  `MeetingStore.end` + the end route (editor, idempotent, guarded in the
  WHERE like appendTo). Live captures stop being "in progress" forever;
  the chronology's meeting rows mean what they say.
- **The reverse link** (`@lucent/web`): `turnObjects`/`objectsByTurn` scan
  the workspace the browser holds — no server call, the payoff of ADR
  0022's ops-level provenance. A turn's row lists '✦ N objects · view'; the
  canvas ✦ now carries the turnRange (`?turn=`), the same contract the Ask
  citation path has had since C1.
- **The merged project timeline** (`@lucent/server`, `@lucent/web`):
  HistoryView extended, not a new view. Revisions + meeting markers +
  statement events (derived from the log's own statement ops) in one
  day-grouped chronology; with no meetings/statements it degrades to
  exactly the C1 revision list.

Three defects C1/C2 left, closed as part of the batch: live meetings never
ended; the ✦ jump landed at the transcript top instead of the exact turns;
the meetings digest truncated silently.

Explicitly NOT built, per the plan's not-built list: a WS meeting-ended
broadcast (meeting lists fetch on mount; revisit with a live timeline),
turn-level citation kinds (indices in answer text + the three-kind contract
suffice), meeting-to-meeting reference columns (the chain lives in
statements + provenance), transcript editing/renumbering (the index system
depends on immutability), the Decisions view (still C6's projection), topic
entity resolution (C5), semantic search (C4).

## Amendment (2026-09-04): Stage C4 executed — semantic search

The owner's two decisions, taken together: build BOTH the search API and
the ⌘K surface alongside Ask retrieval (Lucent by C3 had accumulated
boards, meetings, transcripts, statements, provenance, and history — users
need a direct "find" mechanism, not only an "explain" one), and keep the
scorer weighted lexical (deterministic, cheap, explainable, offline-
testable; embeddings wait for demonstrated lexical misses, and they need
their own ADR first).

The plan's recon finding shaped the architecture: the ask route already
loads the entire searchable corpus, so the retriever is pure computation
over data already fetched — no store, no index, no persistence. And the
entitlement floor, not the digest caps, is the trust boundary: retrieval
widens recall inside a window it cannot widen itself.

What Stage C4 shipped (batches, commits, and the acceptance scenario in
`packages/server/test/stageC4.definition.e2e.test.ts`):

- **The seam** (`@lucent/server`): `retrieve(query, corpus)` — weighted
  lexical (label 5, topic 4, kind/status and nodeType 3, quote and revision
  label 2, turn text 1), the owner's normalization list (NFKD fold, digits
  surviving punctuation, symmetric plural fold, prefix, shared stem),
  deterministic ranking, top-20. Every hit carries the matched tokens, so
  a result explains itself ("Matching: pricing, 20"), never a similarity.
- **Ask retrieves** (`@lucent/ai`, `@lucent/server`): the answer request
  gains `retrieved` — up to 8 hits over the same window the digest
  rendered, including the unclassified turns and over-cap content no
  section ever shows. The historian v4 reads the "Retrieved evidence"
  section and cites through the existing three kinds; the mock demonstrates
  it. Citation validation needed no change — it already accepts the whole
  window.
- **The search API** (`@lucent/server`): `GET /api/boards/:id/search?q=`
  mirrors the history route (viewer floor, no CSRF, no meter), windows its
  corpus with the same arithmetic (`visibleMeetings` moved to
  `meetingsWindow.ts` so ask and search share one floor), and discloses
  `windowTruncated` so "no results" never reads as "nothing else exists."
- **⌘K** (`@lucent/web`, `@lucent/i18n`): on a shared board the palette's
  board family becomes server results — debounced 250 ms, aborted per
  keystroke — grouped nodes/transcript/revisions, each row navigating
  through the C1 citation contract (?reveal / ?meeting+?turn / ?rev, never
  a fourth navigation). The Ask bridge turns "find" into "understand"
  without retyping: Enter submits through `ask()`, whose own retrieval
  surfaces the same evidence — one retriever, two consumers, no
  result-list-as-context coupling. Local boards keep today's local scan.
  The palette i18n keys that existed since M7 are finally wired, plus the
  new groups/bridge/window keys, en + hu.

One defect the envelope-family rule caught on the way: a retrieved hit's
body could have contained a literal `</retrieved-hit>` and broken the
envelope — `retrieved-hit` joined `HARNESS_TAG_PATTERN` (ADR 0024 records
the lesson: every new envelope tag joins the family).

Explicitly NOT built, per the plan's not-built list: embeddings, pgvector,
any semantic index (the seam exists so these can wait for evidence); a
palette "Boards" section (needs client-side orgId plumbing that exists
nowhere in the web app — the Dashboard is local-projects only); shapes in
the server corpus (the local scan keeps covering them); pagination, an
MCP search tool, advanced syntax, saved searches, analytics, cross-org
search, a dedicated search page.

## Amendment (2026-09-04): Stage C5 executed — topic entity resolution

The owner's two decisions, plus the refinement that became the stage's
philosophy: teach + deterministic fold (no LLM resolver — another model call
per generation to fix "pricing" vs "pricing-model" is the wrong
architecture), and universal normalization *of machine-authored ops* at
every boundary. The owner's challenge refined "never rewrite the human"
into the four-rule C5 contract: safe normalization is automatic;
human-authored text is never silently rewritten (the precise invariant:
human-authored semantic fields are immutable by automatic canonicalization
— recommendations may propose, only an explicit user action may apply);
semantic uncertainty becomes an evidence-backed recommendation, not a
merge; recommendations carry evidence. The line for the record: Lucent
should be willing to disagree with the user, but never silently overrule
the user.

What Stage C5 shipped (batches, commits, and the acceptance scenario in
`packages/server/test/stageC5.definition.e2e.test.ts`):

- **The fold + the detector** (`@lucent/core`, topicFold.ts):
  canonicalizeTopic (morphology only), topicsAreVariants (the safe list
  falls out — pricing ≡ pricing, pricing-model ⊃ pricing, price ~ pricing
  by stem; monetization and customer-acquisition stay apart BY DESIGN),
  foldStatementTopics (one existing candidate = converge; zero = novel;
  multiple = untouched; batch-internal collisions close transitively on
  the shortest representative), and possibleDuplicateTopics — variant
  AUTHORED key pairs with statement counts and meetings of origin, each
  key in at most one pair.
- **Teaching** (`@lucent/ai`, `@lucent/web`): visual-agent v5 + both
  meeting-extraction prompts teach REUSE — the board's existing topics are
  the vocabulary; a variant minted beside an existing key is the split the
  rule exists to prevent. A mock reuse script reads the summary's real
  authored key; the golden case topic-reuse-over-variant pins it (gate
  stays at score 1).
- **The fold at the boundaries** (`@lucent/server`): generate (the repaired
  re-emission folds too), MCP ops, proposal approval, and room commits —
  ai-actor batches only, the actor model's own discriminator. A user-actor
  'pricing-model' survives the room exactly as typed, pinned.
- **The challenge at authoring time** (`@lucent/web`): the HUD's topic
  field gains suggestions (the board's authored keys, datalist, never
  forced) and the live rule-3 hint — 'Possible duplicate — Pricing Model
  may refer to existing Pricing (N statements carry it)' with Use/Keep;
  Accept sets the field through the same validated edit path (an explicit
  user action), Keep dismisses for that value. The client send path folds
  the meeting loop's model ops (the room's ai-only rule deliberately won't
  touch user-actor sends); local boards fold identically; applyManual has
  NO fold — the human's edit is the human's.
- **The read-side payoff** (`@lucent/server`): the Ask digest's
  statements-by-topic section — statements grouped by topic identity (the
  same representative rule the fold chooses), authored spellings noted,
  capped at 20 topics / 8 statements. "What happened with pricing?" reads
  one section even when the board's own keys disagree on spelling.

Explicitly NOT built, per the plan's not-built list: an LLM resolver round
(conditional-future, gated on measured duplicate rates, run only on the
ambiguous branch), a general recommendation engine (the generic
Recommendation shape is documented in ADR 0025 as C6+ — contradictions,
stale objects, ownership conflicts are future detectors), any persisted
canonical/alias field or entity table (ADR 0023's rule), semantic aliasing
(monetization ≈ revenue-model is beyond the deterministic fold by
design), a Topics view or recommendation inbox (C6's projections).

## Amendment (2026-09-04): Stage C6 executed — the Intelligence view

The owner's decisions (1/1/1/1, with refinements): one sectioned
Intelligence view — not six rail slots, because all six kinds are
projections of the same statement model and the rail keeps its four
surface verbs (Board → manipulate, Meeting → listen, History →
understand change, Intelligence → understand current semantic state; ⌘K →
find, Ask → explain). All six kinds first-class with per-kind glyphs,
open prominent and settled dimmed. The recommendation inbox with
Merge/Keep — C5's loop closes — with a change-aware ephemeral Keep (an
unchanged pair doesn't re-nag within the session; any change re-arms) and
a previewed Merge (exactly what will update, nothing deleted, then
confirm). The time lens explicitly out, with the spec sentence: 
Intelligence is a projection of the current semantic workspace; it does
not create new truth, mutate state without approval, or replace History
as the source for temporal analysis.

What Stage C6 shipped (commits and the acceptance scenario in
`packages/server/test/stageC6.definition.e2e.test.ts`):

- **The projection layer** (`@lucent/web`, intelligence.ts — pure,
  node-tested, the historyTimeline convention): intelligenceSections (the
  six kinds in fixed order, open first / settled after, rows carrying
  authored topic, supersedes, provenance, and the issue assignee — the
  Board bridge made visible); topicGroups (C5's own equivalence rule,
  authored keys as-authored); inboxItems (possibleDuplicateTopics with
  evidence); mergePreview/mergeOps (one derivation — the preview cannot
  lie about the batch); suppressionKey (change-aware: the pair plus both
  statement counts).
- **The view** (`@lucent/web`): six collapsible sections with
  always-visible counts, KIND_TINT headers, per-kind glyphs, the uniform
  evidence contract (label → ?reveal, ✦ → ?meeting+?turn), view-empty
  states. The four join points: View union, RAIL_ITEMS (Sparkle, after
  Meeting), palette, Router. Pure client-side — zero fetches, identical
  for shared and local boards.
- **The recommendation inbox** (`@lucent/web`): each duplicate pair with
  statement counts and meetings of origin; Merge previews then confirms
  UPDATE_STATEMENT ops through applyManual (the same validator, undo, and
  history as any human edit — only the explicit click applies, the C5
  invariant end to end); Keep suppresses change-aware-ephemerally. ADR
  0025's Recommendation shape gets its first real consumer.
- **The record** (`docs`): ADR 0026, this amendment, the checklist
  section, the changeset.

Explicitly NOT built, per the plan: the time lens (temporal projection is
a future stage on the C1/C3 history/meeting infrastructure — Intelligence
does not replace History), durable dismissals or a persisted inbox (ADR
0023's rule; the future engine's ADR), the general recommendation engine
(contradictions, stale objects, ownership conflicts — future detectors),
per-kind status machines (the C2 decision stands), any REST/MCP
intelligence route or server-side grouping (pure client-side by design),
editing statements from the view (the HUD edits; the view reads), the
"create a plan from today's meeting" bridge (the assignee display is its
seam).

## Amendment (2026-09-04): Stage D1 executed — the execution model

The owner's decisions (1/1/1/1, with the review's two contract
clarifications): node-based — an executable Action is an ordinary workspace
node carrying a C2 action statement plus IssueFields, one system, no
second store (the parallel-state shape refused since C1); dueDate +
description in IssueFields (two clean layers: statement = what is this
semantically, issue = how is the work managed); the six-value execution
vocabulary as convention + teaching + mapping, NOT a zod enum (existing
"To Do"/"In Review" boards load unchanged); the Board column as a
PROJECTION of execution state (open/assigned→todo, in_progress/blocked→
in_progress, completed/cancelled→done); no derivation between the two
status systems in any direction ("assigned" is an initialization
convention — unassigning a completed action leaves it completed);
dependencies deferred entirely to D3; relative dates resolve
deterministically against the meeting/message timestamp (never store
"Friday").

What Stage D1 shipped (commits and the acceptance scenario in
`packages/server/test/stageD1.definition.e2e.test.ts`):

- **The fields + the vocabulary + the resolver** (`@lucent/core`):
  IssueFields gains dueDate (ISO regex-validated — the system's first date
  field) and description (≤2000, the validator authoritative); UPDATE_ISSUE
  patches both (null clears), the reducer never cross-writes; all five
  places landed with the persistence round-trip test guarding the strip
  trap. EXECUTION_STATUSES + executionStatusColumn (categorizeStatus maps
  the canonical values first, legacy keywords unchanged — pinned);
  actionNodes (statement.kind=action AND issue — a bare action statement
  is not work); resolveDueDate (strictly-forward weekdays, 'the Nth'
  rolled forward, explicit ISO passthrough, unresolvable words store
  nothing).
- **Teaching** (`@lucent/ai`, `@lucent/web`): visual-agent v6 (the
  vocabulary, dueDate resolution, description, the no-derivation rule);
  the meeting-extract DEADLINES clause (resolve against the MEETING's
  date); the mock's launch-brief script finally carries the date it always
  claimed (fixed reference, deterministic gate) with status 'assigned' and
  a description; golden action-carries-deadline pins the full D1 action,
  the hedged case forbids a dueDate on vague words. Gate stays at score 1.
- **The surfaces** (`@lucent/web`, `@lucent/mcp`): the Intelligence action
  row completes (assignee, due date, execution status beside the statement
  lifecycle; the overdue tint rendered from Date.now(), never persisted —
  isOverdue pure and tested); BoardView cards gain the due-date chip (red
  when overdue) and the accessible deadline; MCP's issue summary exposes
  dueDate + description (capped 200).

Explicitly NOT built, per the plan and ADR 0027: dependencies in any form
(D3's ADR must answer the eleven questions), a separate actions store, a
new operation family, an execution-status enum or transitions, external
execution links (D4/D6), an execution dashboard (D9), reminders,
persisted overdue state, calendar/timezone infrastructure.

## Amendment (2026-09-05): Stage D2 executed — semantic state becomes a plan

The owner's decisions (via the recommended options, all four): createdFrom
rides the provenance family (ADR 0022's extension clause executed
verbatim); the input surfaces are the canvas multi-select pill (already
worked — zero changes) plus Intelligence checkboxes ("Plan from selection");
the plan gets its own op gate so the anti-conversion rule is MECHANICAL
(PLAN_SAFE_OPS — creation and organization only; UPDATE_STATEMENT
deliberately absent, so a proposal can never silently become confirmed
work); and the plan renders as board content — a CREATE_GROUP region, not
a view.

What Stage D2 shipped (commits and the acceptance scenario in
`packages/server/test/stageD2.definition.e2e.test.ts`):

- **createdFrom, the second evidence kind** (`@lucent/core`):
  provenanceFieldsSchema gains createdFrom (≤20 source statement ids);
  meetingId becomes optional with an at-least-one refine (either evidence
  kind; both coexist). attachPlanProvenance MERGES with meeting evidence
  (fill-don't-overwrite, idempotent). All five places landed; reader
  guards on the new optionality (askContext renders the plan link;
  reverse-provenance treats plan items as belonging to no turn; the ✦
  renders only with meeting evidence). 15 tests.
- **The planning gate + teaching** (`@lucent/ai`, `@lucent/web`,
  `@lucent/server`): the summary sees deadlines (dueDate + description in
  WorkspaceSummary, summarySchema, and the workspaceFromSummary rebuild);
  planGate.ts (PLAN_SAFE_OPS + gatePlanOps + planRequestText); the send
  path gates then stamps createdFrom when plan attachments are present;
  visual-agent v7's planning clause; the mock's plan script (reads the
  summary's real statements); golden plan-from-statements — the acceptance
  fixture (4/6/3/5/4/2) with the mechanical forbids. Gate stays at 1.
- **The Intelligence surface** (`@lucent/web`, `@lucent/mcp`): every row a
  checkbox; "Plan from selection (N)" sends the plan request; MCP get_board
  exposes fromStatements for plan items (either evidence kind, honestly).

Explicitly NOT built: the Ask-bridge and region selection (no consumer), a
plan kind on the proposal record (the request text carries it),
dependencies (D3), external links (D4/D6), a plan view (D9), automatic
generation (a human requests every plan), re-planning diffs (History).
