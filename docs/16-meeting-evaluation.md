# 16. Meeting Evaluation — the scoresheet

> **P0-2 (2026-09).** The question this document exists to answer, per the
> advisory: _"Can Lucent turn a 30-minute messy product meeting into a
> useful, trustworthy workspace without making the board unreadable?"_
> Measured, not vibed. The offline half is pinned in
> `packages/web/test/meeting-eval.test.ts` (trigger/gating/continuity/
> stability across all five fixtures); this sheet measures the MODEL's
> semantic quality against the real provider, where only human scoring can.

## The fixtures

Five scripted meetings in `packages/web/src/meeting-fixtures.ts`, one per
column below, chosen to stress different failure modes:

| #   | Fixture                 | What it stresses                                                          |
| --- | ----------------------- | ------------------------------------------------------------------------- |
| 1   | product-launch          | The clean baseline: sequential topics, decisions, an action with an owner |
| 2   | architecture-jumping    | Topic switching WITHIN a domain: frontend → … → BACK to frontend          |
| 3   | brainstorm-disagreement | Speculation everywhere + one explicit rejection                           |
| 4   | planning-owners         | Owners, deadlines, dependencies, and a scope change                       |
| 5   | messy-meeting           | Interruptions, corrections, a joke, side chatter, undecided proposals     |

## How to run the real-provider pass

1. Start the stack (`npm run start -w @lucent/server`, `npm run dev -w @lucent/web`).
2. Open meeting mode on a shared board; start recording.
3. Paste each fixture's turns as spoken turns (or speak them), in order, at a
   realistic cadence — the differential loop extracts on the hybrid trigger.
4. After the last turn, stop; then answer the sheet below per fixture.
5. Log the completed sheet as
   `docs/eval-results/YYYY-MM-DD-<fixture>.md` (create the directory).

Score each axis 0–2: **0** = failed, **1** = partial, **2** = clean. Any 0 on
a trust axis (semantic accuracy, correction, attribution, "why") is a P0-3
bug regardless of totals.

## The eight metrics

### 1. Capture (recall)

_How much important information did Lucent miss?_

Check against the fixture's `expectedTopics` and its explicit facts
(decisions, owners, constraints — the turns with a stated commitment or
number). Count misses.

- 2: every expected topic and every stated fact appears on the board
- 1: a topic or 1–2 facts missing
- 0: a whole topic missing, or ≥3 facts

### 2. Precision (over-extraction)

_How much irrelevant information landed on the board?_

The messy fixture is the test: the babysitter line, the game chat, the
joke, must NOT appear. Every board object should trace to a material turn.

- 2: zero junk objects
- 1: 1–2 junk objects
- 0: ≥3, or a junk _region_

### 3. Semantic accuracy (statement kinds)

_Did each captured statement get the right kind?_

Score each row: fact / proposal / question / decision / rejection / action /
constraint / risk. The three that matter most:

- "Maybe we could…" must be a **proposal**, never a decided fact
- "No, we're not doing X" must be a **rejection that supersedes** X's
  earlier proposal (visible on the board, not just absent)
- "Sarah will handle marketing" must be an **action owned by Sarah** (see 6)

- 2: all three correct plus no misclassified kinds
- 1: one soft misclassification (e.g. proposal rendered as plain node)
- 0: any speculation treated as decided

### 4. Continuity (topic switching)

_When the same topic comes back later, did Lucent UPDATE it or duplicate it?_

Fixture 2's explicit return to frontend is the direct test; fixtures 4–5
also contain returns.

- 2: every return lands inside the existing region — no `Pricing #2`
- 1: one duplicate region, but the rest held
- 0: duplicated regions

### 5. Correction handling

_When somebody says "no, that's not what I meant," did the model correct?_

Fixture 5: "students" → "Actually, young professionals" → "Yes, young
professionals." The board's final word must be **young professionals**,
with no contradictory surviving node.

- 2: one corrected node; nothing contradicts
- 1: correction landed but the original also survives unmarked
- 0: both statements on the board as if both were true

### 6. Attribution

_Did the right person get assigned to the action?_

Fixture 4 is the direct test (Alex → research, David → prototype, Sarah →
review). Fixture 5's trick: "talk to Sarah about pricing" is NOT an action
owned by Sarah — it is _discuss pricing with Sarah_ (ambiguity rule).

- 2: every action owned by its speaker; the ambiguity line not misassigned
- 1: one misassignment
- 0: actions without owners, or the ambiguity line assigned to Sarah

### 7. Visual quality (10-second readability)

_At the end: can a human understand the board in 10 seconds?_

Show the finished board to someone who wasn't in the "meeting" for exactly
ten seconds; ask them what the team is building and what was decided.

- 2: they answer both correctly
- 1: they answer one
- 0: neither

### 8. Trust ("Why is this on the board?")

_Pick three AI-created objects at random and ask why. Each must answer._

The provenance loop: click the ✦ → quote of the source words → jump to the
transcript span. All three objects must answer.

- 2: 3/3 answer with the right source words
- 1: 2/3
- 0: any AI object with no answer

## Reading the results

- **<12 total**: stop feature work; the failures name the next P0-3 batch.
- **Any trust-axis 0** (3, 5, 6, or 8): that specific failure becomes a
  golden case in `packages/ai/src/golden.ts` before anything else ships.
- **≥13 with clean trust axes**: the loop is trustworthy — move to P1
  (visual clarity) and re-run only fixture 5 after it lands.

The discipline: these numbers decide what gets built, not opinions. The
first pass's completed sheets are the input to P0-3 exactly as specified.
