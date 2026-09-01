---
"@lucent/web": minor
"@lucent/ai": minor
---

Persist proposals, measure the meeting intelligence, and make large boards readable (P0-1…P1).

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
