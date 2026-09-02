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
