# Stage D final validation pass — live browser + real stack (2026-09-10)

The full 40-section live-validation protocol (the "CEO questions" pass), executed
against the real stack: server on :4391 (in-memory, auth on, provider `kilo-auto`
via kiosapi), Vite on :5174, the IAB browser as the user, second user (Sarah)
through REST + raw WebSocket, deterministic boards driven through `POST
/api/boards/:id/ops` and the room's own commit path, and the `fake` external
provider as the wire. Preflight gate before the pass: typecheck 0, all six
workspaces' tests green (the branch's uncommitted streaming tests included).

## Where it ran, honestly

- **Postgres was unavailable** (local 17 instance reachable but no working
  credentials), so §23's restart-persistence arms ran on the documented
  in-memory fallback: a restart wipes accounts/boards, and the pass re-seeded
  each time. This is the known deviation, not a defect.
- **The real LLM (kilo-auto/kiosapi) failed hard mid-pass**: 8 of 15 generate
  calls returned 502 — mostly "provider returned neither a tool call nor
  content" — and by the end the gateway timed out entirely on direct probes.
  §16 (Ask) and the LLM halves of §12–14/§24 could not complete against the
  real provider; their deterministic halves were verified through the ops/ws
  contract paths and prior-stage evidence.
- **Live meetings need humans and microphones** — §12/§13 ran the capture,
  store, saved-transcript, and turn-scanning surfaces with a 7-turn messy
  transcript (corrections, retraction, joke) through the meeting REST, not a
  microphone.

## The scorecard (§38)

| Capability | Score | Evidence |
| --- | --- | --- |
| AI understanding (semantics of what's said) | **96** | All 10 prompts' content correct incl. the failure loop T1 invented and T10's ambiguity; §6 corrections update-in-place exactly |
| Visual correctness (structure/connectors) | **88** | Zero dangling edges across 10 boards; T6 sequence numbered; T2/T7 hierarchy right |
| Visual readability (layout) | **58** | The V2 wrap defect on flowcharts (T1/T3), sequence edge-label clipping (T6), ER column (T7), ≥80-node label collapse |
| Execution model (deps, rollup, external) | **93** | Cycle rejected with the path named; transitive blocking + unblock recovery exact; rollup exact; fake-wire propose→approve→5 links with translated statuses |
| Collaboration (rooms, roles, presence) | **85** | Sarah joined via invite as editor; commits broadcast; converged state — but the ops-API/room split (defect h) and the missed live frame (§11) subtract |
| Trust/provenance surfaces | **90** | Statements carry meeting/turn provenance through the ws path; Intelligence/Execution/Meeting all render the ✦ chain; defect j (history window) and k (placeholder leak) subtract |
| Provider reliability (the pass's environment) | **30** | 8/15 generate 502s, no retry for the no-tool-call class, silent UI failure; gateway hard-down by the end |
| Time-to-useful-board (§35) | **PASS at scale, FAIL at the tail** | 10–35s when the provider answers; ~50% of attempts needed 1–3 retries because of provider failures |

## Defects found (the pass's real output)

Ordered by severity, with the protocol's taxonomy:

1. **[E1/DoS-class] `SET_STATEMENT` shape mismatch crashes the whole server**
   (`reducer.ts:215`). `validateOperations` PASSES an op carrying the statement
   fields at the top level (schema wants them nested under `statement`), and
   `applyOperations` then throws `op.statement.supersedes` of undefined — the
   ws commit path applies after validation, so one authenticated op kills the
   process. Reproduced offline: `validate errors: 0` then `APPLY THROWS`.
   **Fix immediately.**
2. **[M1/M2] The ops-API/room split (two writers, no reconciliation).**
   `POST /api/boards/:id/ops` appends to the log + persists the workspace but
   never notifies the realtime room; a live room keeps serving its stale state
   (a mid-session 150-node seed never reached the open browser), and a room
   eviction snapshots whatever it holds — a board joined before its ops-seed
   now serves a **permanently empty resync frame** to every future ws joiner
   (80 nodes on the server, empty `workspace` in the resync, browser shows the
   first-run hero). MCP/agent-driven boards are the exact hit case.
3. **[P1] The history window's off-by-one hides the whole log**
   (`historyWindow.ts`). With an eviction snapshot at the current head —
   routine on last-peer-leave — `firstExisting = baseSeq+1` exceeds `head`, so
   `fromSeq > head`, `loadLog(fromSeq-1)` returns nothing: History and Ask see
   an empty timeline while `latestSeq: 7`. Reproduced with the server's own
   function: `historyWindow(7, 25, 7) → fromSeq: 8`. The density assumption
   ("entries at/below baseSeq are compacted") is false when no prune ran.
4. **[S5/silent] `UPDATE_ISSUE` typo'd shape is a 200-acked no-op.** Zod strips
   unknown keys, so `{op:'UPDATE_ISSUE', id, patch:{status}}` (a natural
   mistake) validates, commits, and changes nothing. The pass's first status
   sweep "succeeded" six times without changing state. Unknown-key stripping on
   the op schema turns shape typos into silent success — reject them.
5. **[V2] Flowchart layout wraps.** Vertical chains longer than the viewport
   wrap to the top-right, with the return edge crossing the whole canvas and
   two labels partially occluded (T1, T3 — same defect class).
6. **[S1] A failed generation can bleed the previous workspace into a new one.**
   After a 502 on workspace 3's first prompt, the retry merged T1's flowchart
   into T2's architecture (15 nodes); the persisted project only held T2's
   result, and a reload dropped the merge. Reproducible via a 502 during the
   Begin→generate transition.
7. **[E3] The `fake` external link's status translation shows `done` for a
   completed Lucent action** — verified acceptable in this direction, but the
   D8 never-guesses rule should be asserted here too (not a wrong mapping, an
   unasserted one).
8. **[V5] ≥80 nodes at fit-zoom: labels unreadable** (mass text collapse at
   150/305 — the protocol's "can I understand the board in 10 seconds" fails
   without zooming; grouping/collapse features exist but nothing surfaces
   them at scale automatically).
9. **[P2] Intelligence evidence sentence leaks literal placeholders**: "1
   statements on \"{existing}\", 1 on \"{dup}\"" — an i18n/format-args bug in
   the merge recommendation.
10. **[M3] Supersede-pending-proposal semantics surprise**: sending a new turn
    while a proposal is open silently supersedes it (the pricing proposal
    vanished when I asked about architecture). Documented B3 behavior, but a
    user loses review state with no notice.
11. Provider failures are **silent in the UI** — three consecutive 502s left
    the app in the empty state with no toast/error (§16-adjacent trust issue
    — the server's `/metrics` and logs show the 502s the user never sees).

## A–D buckets (§37)

- **A (ship as-is):** 7, 9, 10 — cosmetic or documented semantics.
- **B (fix immediately):** 1 (server-crash vector), 4 (silent no-op contract),
  11 (silent provider failure), 5 (layout wrap — highest-frequency usability
  issue of the pass).
- **C (build next):** 2 + 3 (the ops/room/snapshot coherence family — one fix
  concept: ops-API commits go through the room, eviction snapshots from the
  store truth, history window clamps `fromSeq ≤ head`), 8 (large-board
  readability affordances).
- **D (ignore):** none found.

## The build-next answer (§39, the CEO decision)

The protocol's own arithmetic — frequency × severity × user value — points at
one cluster: **platform coherence (B+C above) before any new feature**. The
execution layer's engine is in excellent shape (rollup/blocking/drives/external
wire all exact under test); what the live pass exposed is that the *seams
between* the four write paths (generate, ops API, ws room, snapshot/eviction)
and the *read windows* (history/search/ask) disagree, and that the layout
renderer gives back unreadable boards exactly when the content is right. Neither
finding is in the roadmap's remaining bullets (Slack/Figma/Lattice/OAuth) —
which is precisely the point of the pass: the measured failures, not the
remaining roadmap items, should pick what gets built next.

Deferred and unbuilt (recorded, §28–31): Slack/Figma adapters (their own
provider families per ADR 0034), Lattice/repository gap analysis (no code
exists), decision-impact analysis over dependencies (the E1 drives relation
exists but no "what does changing X affect" walk), inbound webhook live arm
(needs the secret in the server env; D7/D8 live evidence covers it), and
plan-from-meeting through the real LLM (deterministic arms verified).

## Metric rollup (§33, what was measured)

- Generation → useful board: **10–35s** (model latency), 50% attempt-retry rate
  from provider failures; manual cleanup: **0 corrections** on all 10 boards
  (the content was right every time — the layout is what needed the eye).
- Interaction: 12 zoom events **5.6–8.1ms**, 30 pan events **2.8–8.2ms** at
  150 nodes/305 edges — no performance wall anywhere in the range (the
  checklist's "large boards" fear is a readability problem, not an FPS one).
- Room ops: commit→broadcast→second-session convergence verified; cycle
  rejection names the path; the status sweep's 6/6 acks exposed defect 4.
- External: propose→approve→5 creates with assignee/dueDate/status translated,
  5 `fake-n` links with urls, exactly-once on duplicate approval (prior D6/D8
  live evidence re-confirmed by the link shape).
