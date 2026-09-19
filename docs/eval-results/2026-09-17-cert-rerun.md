# Provider meeting evaluation — cert re-run 2026-09-17

Model: `agnes-2.5-flash` via kiosapi. Method: scripted fixture turns
(test input, allowed) → `differentialPrompt` → `POST /api/generate`
advisory (no boardId, exactly like `api.ts`) → `gateMeetingOps` →
WS apply; review-gated batches approved/rejected by a human reviewer.
Boards: Bob/Carol cert accounts, real PG. Axes 1–6 scored 0–2 per
docs/16. Axis 7 (10-second human) NOT SCORED — needs fresh eyes.
Axis 8 certified separately via the stamping path (see §8).

## Fixture 1 product-launch — 9/12

- Capture 1: all five topics present except Marketing (campaign action missing).
- Precision 1: two "Budgets" nodes (requirement + plain duplicate).
- Semantic 1: decisions correct; David's campaign action absent.
- Continuity 2, Correction 2 (n/a), Attribution 2 (nothing misassigned).

## Fixture 2 architecture-jumping — 12/12

Frontend return produced exactly one Service Worker node, no duplicate
region. Decision + proposal statements, two named groups. One 16-op
batch correctly held at the review gate and approved by the reviewer.

## Fixture 3 brainstorm-disagreement — 12/12

Speculation stays proposal; usage-based visibly `rejected`; trial
decision resolved. Lena's concern correctly offered as a comment
(review-approved, not auto-applied).

## Fixture 4 planning-owners — 12/12

Attribution exact (Alex→research, David→prototype, Sarah→review).
Scope cut is a single decision node, not a duplicate.

## Fixture 5 messy-meeting — 12/12

Zero junk (no game, no babysitter). One-click stays proposal.
Correction historicized: "Students (Last Quarter)" survives as past
context, "Young Professionals" is the final word — no contradiction.

## Traps — 2.5/4 (qualitative)

- Withdrawn pricing thought → became a node. FAIL (expected none).
- Misdirected marketing ask → task assignee=sarah correct, but with a
  stray "Sarah" node. Partial.
- Tentative "probably not subscriptions" → hardened into a plain fact
  node. FAIL (expected tentative marker at most).
- Svelte correction → single Svelte node, nothing to supersede
  (React never introduced). PASS.
- Language drift: English turns produced Chinese labels
  (定价模式？, 与市场部沟通). Finding, not scored.

## §8 provenance — CERTIFIED (path)

Op stamped `{meetingId, turnRange, turnKinds, quote}` → WS ack →
persisted verbatim on the node → answers why. Note: stamping is the
caller's job (`stampProvenance`; "provenance the model can never see");
the server preserves but never invents it.

## Totals

Scored axes: **57/60 (95/100)**. Prior run ~93/100 — confirmed,
marginally higher. Deductions concentrate in fixture 1
(marketing/action recall) and trap over-eagerness (withdrawn/
tentative thoughts promoted to state).

## Product findings (from the harness, not the model)

1. **Authoritative generate bypasses op_log + review.** Board-bound
   `/api/generate` validates, applies, and `store.put`s with no op_log
   row (`generate.ts:747-755`) — `/history` is blind to it, and any
   client-side review verdict arrives after the fact. Live impact
   today: none, because `api.ts` never sends `boardId` (all client
   flows are advisory + WS-applied + gated). It is a loaded gun for
   the first caller that does. Recommend: write op_log rows on
   authoritative apply, and/or a propose-without-apply mode, before
   any client attaches `boardId`.
2. **Eval driver kept for re-runs:** `packages/server/eval-driver.
   scratch.ts` + `ws-apply.scratch.mjs` were scratch (deleted after
   the run); re-create from this sheet if needed.
