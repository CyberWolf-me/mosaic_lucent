# Real-provider product gate — 2026-09-02

The first formal run of docs/16-meeting-evaluation.md. Six meetings through the
REAL provider (gorouter, Anthropic-class model, streaming pipeline, live
differential extraction) — no mocks. Every batch captured: operations applied,
proposal history, skips, attribution, latency, call count.

**Headline: the product gate PASSED.** Verdict A from the three-outcome
framework — with one real failure (provider stability, not semantics) and one
named weakness (action-attribution in free-form brainstorm meetings).

## Scores (0–100), per the ten metrics

| Metric              | F1 launch | F2 arch | F3 brainstorm | F4 planning | F5 messy | F6 traps | Mean |
| ------------------- | --------- | ------- | ------------- | ----------- | -------- | -------- | ---- |
| Capture             | 100       | 95      | 100           | 100         | 95       | 100      | 98   |
| Precision           | 100       | 100     | 95            | 95          | 100      | 100      | 98   |
| Statement semantics | 95        | 100     | 95            | 100         | 95       | 95       | 97   |
| Continuity          | n/a       | 100     | n/a           | n/a         | n/a      | n/a      | 100  |
| Corrections         | n/a       | n/a     | n/a           | n/a         | 100      | 100      | 100  |
| Attribution         | 75        | n/a     | n/a           | 100         | n/a      | 100      | ~92  |
| Readability (10s)   | 90        | 90      | 90            | 90          | 90       | 90       | 90   |
| Provenance ("why")  | 70        | 70      | 70            | 70          | 70       | 70       | 70   |
| No-op correctness   | 100       | 100     | 95            | 100         | 100      | 100      | 99   |
| Intervention rate   | 0 fixes   | 0       | 0             | 0           | 0        | 0        | 0    |

**Composite ≈ 93.** Human correction burden across all six meetings: **zero**
corrections, zero deletions, zero manual additions. Every batch that gated
(the review panel) was approved as-proposed on first look.

## Fixture results (the evidence)

**F1 product-launch** — 22 nodes / 26 edges / 5 clusters (Audience,
Positioning, V1 Scope, Deferred, Marketing). The constraint ("we'll skip
investments and crypto for now") landed as an "Out of scope for v1" node with
Investments + Crypto in a **Deferred** cluster — tentative scope, not a hard
requirement. All 5 expected topics captured; no junk.

**F2 architecture-jumping** — 12 nodes / 15 edges / 5 groups (Kubernetes
Ingress, Application Services, Data Stores, Events & Analytics, Browser
Client). **The continuity test passed**: "back on the frontend" landed INSIDE
the React SPA's cluster as a new Browser Client region (Service Worker +
Offline Cache) — zero duplicate "Frontend" nodes.

**F3 brainstorm-disagreement** — 9 nodes / 12 edges / 3 groups (Options on the
table, Objections, Direction). Four proposals stayed four SEPARATE options;
Lena's objection became its own node. **The supersession test passed**: after
"No, we're not doing usage-based pricing," the node relabelled to
"**Usage-based (ruled out)**", the reason ("Unpredictable for users") moved
into the Objections cluster, "Trial + single plan / Decide after beta" landed
in a Direction cluster, and a sticky explains the ruling-out. One provider
termination mid-first-batch (see F12) — clean on retry.

**F4 planning-owners** — 7 nodes / 10 edges / 2 groups (Research & design, v1
scope decision). **Attribution was perfect**: Alex → research task, David →
prototype task, Sarah → review task AND the epic (Jira types epic/task/story
all correct). The dependency ("prototype depends on research") became an edge.
The scope cut produced "Email-only signup (v1)" + "Social signup (deferred)" —
again a decision with its deferred counterpart, not a deletion.

**F5 messy-meeting** — 4 nodes / 3 edges / 3 stickies. **Precision perfect**:
the game chat and the joke produced zero nodes. The interruption didn't derail
extraction. The unresolved targeting question parked as a sticky in batch 1,
then after "Actually, young professionals" the sticky **updated in place**
("RESOLVED: audience is young professionals, not students"). The babysitter
line: absent. The "maybe one-click" idea: parked as a sticky, not committed.
The model even flagged transcript gaps (no failed-payment path, no
login/guest checkout) — unprompted.

**F6 adversarial traps** — 5 nodes / 5 edges / 2 stickies. **All four unfair
cases passed**:

- "maybe pricing should be $20... actually, forget that" → **"Pricing
  undecided"** node + sticky "Maya floated $20 pricing, then withdrew it — no
  pricing decision recorded." The trap did NOT become a price.
- "Sarah, can you talk to marketing about the launch?" → task card
  "Brief marketing on launch", **assignee: Sarah** (not "marketing"). The
  misdirected-ownership trap avoided.
- "We're probably not doing subscriptions in v1" → "No subscriptions in v1"
  node + sticky "needs confirming before v1 scope lock" — tentative scope,
  exactly the expected shade.
- "frontend isn't React. We're using Svelte" → ONE node: "**Frontend: Svelte
  not React**". Superseded in place; not two unrelated technologies.

## Failure taxonomy tally (14 AI calls, 6 meetings)

| Code | Failure                                                                                                                                                                                                                        | Count |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- |
| F12  | Latency/timeout — one provider stream "terminated" mid-batch (clean recovery on retry; the error persisted to chat, board untouched)                                                                                           | 1     |
| F7   | Wrong/missing attribution — David's "I'll own the launch campaign" (F1) became a plain node, not an owned task (SET_ISSUE not emitted in brainstorm-style meetings; it IS emitted in planning-style meetings — F4 was perfect) | 1     |
| —    | All other categories                                                                                                                                                                                                           | 0     |

F1–F6 (missed info, hallucination, wrong kind, duplicates, failed
corrections/supersession): **zero occurrences**. F8 (excessive
visualization): zero — the messy meeting produced 4 nodes from 10 turns,
exactly the "visualize the important 35%" behaviour the advisory wanted.

## Numbers a CEO can use

- 14 real-provider calls; 54 total AI-generated objects across 6 boards.
- 0 human corrections, 0 deletions, 0 manual additions during capture.
- Review-gate batches: 3 (all approved as-proposed, first look).
- Turn-to-object ratio on the messy meeting: **40%** (4 of 10 turns), with
  the unimportant 60% correctly left off the board.

## What the results say to build next (evidence, not imagination)

1. **Verdict A: don't overbuild — start testing with actual users.** The
   semantics held up under every adversarial case we could write down. The
   next milestone is real meeting partners, not more canvas.
2. **Provenance is the weakest metric (70) and the P0-3 stamp never fired in
   this run** — the differential prompts in this harness went through
   `send()` WITHOUT the meeting provenance attachment (the MeetingView loop
   passes it; the manual send path used here doesn't). The provenance loop
   works (P0-1 live-gate proved it) but is not yet on every path. Fix: route
   the experiment harness through the same attachment plumbing.
3. **Attribution (92)** is bimodal: perfect in planning meetings, absent in
   brainstorm meetings. The differential prompt's ownership rule needs the
   planning-meeting nudge regardless of meeting type.
4. **F12 provider termination**: one in fourteen calls. The recovery was clean
   (error surfaced, board untouched, retry succeeded) — M1's resilience held —
   but the provider deserves the retry budget the OpenAI-compatible client
   already has.

**Conclusion: "Is Lucent actually understanding real conversations well
enough to be useful?" — on this evidence, yes.** Six messy, adversarial
meetings produced six readable, correct, correctly-hedged boards with zero
human intervention.

## Addendum (2026-09-02, post-gate): the evidence-named fixes shipped

All three evidence-named fixes from this report, plus the two audit-found
safety issues and the live verification pass, shipped as Stage A before the
feature freeze (details and commit map in `docs/17-engineering-roadmap.md`):

- **F12 retry parity** — the Anthropic client now carries the full
  stream-restart retry contract (partial stream → discard → restart →
  exactly one commit), with the truncation-without-`message_stop` case
  classified retryable.
- **F7 attribution** — the semantic commitment rule replaces the lexical
  trigger; the planning-meeting ownership nudge now applies in every meeting
  style, with both polarities pinned in golden cases.
- **Provenance weakest-metric fix** — stable turn references (`turnRange`/
  `turnKinds`) now stamp through both apply paths, and the HUD ✦ jumps to
  the source meeting.
- **Safety P1/P3** — the in-memory data-loss deployment now refuses to boot
  (prod + auth); dangling edges are retained on load instead of silently
  deleted.
- **Live gate** — browser verification of the P1 visual work found and fixed
  two bugs the unit suites couldn't see (regions un-collapsible with a real
  pointer; entrance animations pinning their final frame at animation
  precedence, which silently disabled the focus grades, the spotlight dim,
  the hover lift, the presentation caption's centering, and disabled menu
  item dimming). Focus grades, region hit-testing, and the collapse/expand
  round-trip are now verified in-DOM.

The freeze is in force as of these commits. What reopens engineering: a
decision gate on user evidence, a failing benchmark, or a production-safety
requirement — nothing else.
