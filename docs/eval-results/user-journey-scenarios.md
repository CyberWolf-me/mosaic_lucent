# Live User-Journey Scenarios

> **What this is.** The scenarios below are the product's user journeys written as
> executable stories, run against a **live stack** (real server, real Postgres when
> configured, real browser) and a **real AI provider** — not a mock.
>
> **Why real provider.** A mock proves our reducer is correct. It cannot prove the
> product works. The thing that can break between "the unit tests are green" and
> "a user is happy" is the seam between _the model's output_ and _our validator_ —
> and only a real model exercises that seam. The trade is explicit and accepted:
> **a failure here may be a model behaving differently, not a bug in our code.**
> Each spec separates those two cases where it can (see "Triage rule" below).
>
> **Triage rule.** Every finding is reported in exactly one of three buckets:
>
> - **BUG** — our code is wrong. The non-negotiables are load-bearing; a violation
>   of one (e.g. the AI authoring coordinates) is a bug regardless of who caused it.
> - **MODEL** — the provider produced something legitimate that we did not handle.
>   Not a bug. Recorded as a prompt/contract observation.
> - **FLAKE** — the environment, not the product. Timing, port contention, network.
>
> **Run record.** `docs/eval-results/<date>-user-journey-scenarios.md`

---

## The stack under test

| Component | How it is pinned                                                                                                                                                                                                                                  |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider  | Real. `LUCENT_AI_PROVIDER` from `.env`; the specs **assert at boot** that the provider is not `mock` and refuse to run otherwise (unless `SCENARIOS_ALLOW_MOCK=1`). A green run against a mock proves nothing and must not be reported as a pass. |
| Model pin | Logged per run, never asserted. A model swap is a legitimate config change, not a failure.                                                                                                                                                        |
| Auth      | `LUCENT_REQUIRE_AUTH=1`. Every journey starts signed up, like a real first minute.                                                                                                                                                                |
| Isolation | Each spec gets a **fresh account** (unique email) and therefore a fresh personal org. No cross-test state.                                                                                                                                        |
| Data      | In-memory unless `LUCENT_DATABASE_URL` is set; the report says which ran.                                                                                                                                                                         |

### Why a fresh account per scenario

Three of these journeys (permissions, classification, share) are about _who may do
what_. A shared account would make every other scenario's state visible to them and
turn an ordering dependency into a flake. Cost: one signup each, paid by the mock-free
path at ~200ms.

---

## Scenario A — The first minute _(the promise)_

> _"Think out loud. Build visually."_ This is the scenario the product exists for.
> If this one fails, nothing else matters.

**Preconditions:** none. Anonymous visitor.

1. Land on the app. No account.
2. Sign up with a name, email, password.
3. Dismiss any onboarding modal.
4. Type into the canvas: _"A five-step onboarding flow: sign up, verify email, choose plan, invite team, first login"_
5. Wait for the generation to settle.

**Expected:**

- [ ] Signup succeeds and the app lands on a canvas.
- [ ] Semantic nodes appear (≥3) — not a spinner that never resolves, not an error.
- [ ] The node **roles** are semantically right: the first step is a `start`, the
      last is an `end`, and the middle are `process` steps. This is the real assertion —
      a diagram of five grey boxes in a row is not the product.
- [ ] **The model authored zero coordinates.** Measured on the wire, not inferred
      from the render. Layout is the engine's job.
- [ ] Every node has a non-empty human-readable label.
- [ ] No uncaught console error.

**Why these assertions:** (4) is the only assertion in the whole suite that tests
the _semantic_ claim rather than a pixel. (5) is the architectural non-negotiable
most likely to regress silently — nothing else in the system would catch it.

**Triage:** missing roles with boxes present → **MODEL** (or **BUG** if every role
is `process` with no model variation at all). Coordinates > 0 → **BUG**, always.

---

## Scenario B — The edit loop _(not a regenerate)_

> The differentiator is not that the AI can draw. It's that the AI **edits** — the
> user's work survives, and the change is reversible.

**Preconditions:** a board from Scenario A.

1. Ask for a change: _"add a step for two-factor authentication"_.
2. Assert the _original_ nodes still exist — an edit, not a replacement.
3. Manually move a node by dragging it.
4. Assert the node stayed where it was put.
5. Undo. Assert it returns.
6. Redo. Assert it moves out again.

**Expected:**

- [ ] The change is additive: prior node count + the new step.
- [ ] No node is lost. (Losing the user's diagram is the worst failure this product has.)
- [ ] A manual drag survives — and is not reverted by a subsequent AI call. This is
      **human authority over the canvas**; the server refuses AI `MOVE_NODE` on the
      agent surface for exactly this reason.
- [ ] Undo/redo are inverse-operation exact: the label and position both restore.

**Why it matters:** "AI edits rather than regenerates" is a ticked box in the
checklist. This is the scenario that either proves it or quietly disproves it.

---

## Scenario C — Persistence _(the trust layer)_

> A user who loses their work does not come back. This is the cheapest thing to get
> catastrophically wrong and the easiest to regress.

**Preconditions:** a board with at least one node and one manual edit.

1. Reload the page.
2. Assert the board comes back.
3. Assert the manual edit survived (not just the AI nodes).
4. Open a _new_ tab to the same board and assert it matches.

**Expected:**

- [ ] Node count is identical after reload.
- [ ] The manual position survives — autosave is not saving a partial snapshot.
- [ ] No duplicate nodes from a double-applied autosave.

**Triage:** AI nodes survive but manual ones don't → **BUG** (autosave is persisting a
stale projection). Duplicates on reload → **BUG** (idempotency broken).

---

## Scenario D — Two people, one board

> Server-authoritative op log, sequenced, deduped on catch-up. Deliberately not a CRDT.

**Preconditions:** an owner with a published board, and a second account.

1. Owner publishes the board and captures the `?board=<id>` link.
2. Invitee opens the link.
3. Both clients are open simultaneously.
4. Owner adds a node.
5. Assert the invitee sees it **without reloading**, and with the same node count.
6. Owner attempts to promote the invitee; invitee attempts a forbidden edit.

**Expected:**

- [ ] Invitee lands in the same room and catches up from the op log.
- [ ] Owner → invitee propagation is live.
- [ ] A non-owner cannot change board role.
- [ ] A viewer commit is **refused by the server** (not merely hidden in the UI).

**Why (6) is the real test:** a UI that merely disables a button proves nothing about
authorization. The refusal must come from the server, and it must be observable.

---

## Scenario E — One model, many representations

> "Board → multiple artifacts works." The semantic model is the moat; a diagram that
> can only be one kind of picture is just a picture.

**Preconditions:** a board with a meaningful graph (≥4 nodes, a chain).

1. Switch lens: **flowchart** → **mind map** → **architecture**.
2. At each step, assert the same semantic nodes are present.
3. Return to flowchart.
4. Assert the graph is structurally the one it started with.

**Expected:**

- [ ] Node count is invariant across lenses — the model is shared, not per-lens.
- [ ] Roundtrip is lossless: no node dropped or duplicated by the round trip.
- [ ] Edges survive where the lens has an edge concept.

**Triage:** a lens rendering few nodes because it has no representation for that node
type is **MODEL/by-design**; losing them on _return_ to the original lens is a **BUG**.

---

## Scenario F — Governance _(who may do what)_

> Users paste sensitive company information. These refusals are the product.

**Preconditions:** an owner account with a published board.

1. Set the board classification to **Restricted**.
2. Attempt an AI generation against that board.
3. Attempt to share it.
4. Read the refusal and assert its _reason_.

**Expected:**

- [ ] Restricted + AI → refused **before any provider spend**. (The 403 must cost $0.)
- [ ] The refusal names the boundary and the classification — a usable message, not
      `403`.
- [ ] A second account cannot read the board at all — it gets a **404, never a
      tier-revealing 403**. A 403 here leaks the board's existence and its security
      level to an outsider.
- [ ] Classification downgrade by a non-owner is refused.

**Why "before spend" is asserted:** a refusal that happens _after_ the provider call
still leaks the board contents to a third party. The check is on ordering, not just
on the status code.

---

## Scenario G — Out and back in

1. Export the board (JSON and Mermaid).
2. Assert the export is non-empty and structurally valid.
3. Reset to an empty board.
4. Re-import.
5. Assert the node count and the labels match the pre-export state.

**Expected:**

- [ ] Export is lossless for the semantic model.
- [ ] Mermaid export renders the same flow in text form.
- [ ] Import lands through the **same validated operation path** as the AI — an
      import that bypassed the validator would be a security hole, not a feature.

---

## Out of scope for this pass — and why

| Area                              | Why not now                                                                                                                                          |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Voice → canvas                    | Requires microphone permissions and a live STT provider; the _hardware_ story is already recorded as NOT CERTIFIED for a reason. Covered separately. |
| Meetings / LiveKit                | Needs live room credentials; multi-hour soak is human-gated.                                                                                         |
| Integrations (Linear/Jira/GitHub) | Needs real PATs per vendor; the auth path is already covered by server tests.                                                                        |
| Load / performance                | k6 already runs daily in CI.                                                                                                                         |

These are excluded **deliberately and visibly**, not quietly skipped. A suite that
silently omits half the product is worse than one that names its boundary.

---

## What a green run does and does not mean

**Means:** the seams hold — model → validator → layout → render → persist → sync —
on a real provider, today, in a real browser.

**Does not mean:** the product is certified for launch. The launch blockers already
recorded in `checklist.md` are human-gated (physical diarization cohort, vendor OAuth,
a partner canary) and no amount of automation retires them. The honest claim this
suite supports is narrower and worth making precisely because it is narrow.
