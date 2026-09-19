# 0027 — The action is executable work: one node, two layers, one vocabulary

- Status: Accepted
- Date: 2026-09-04

## Context

Stage D opens with its execution model. The owner's milestone spec: turn C6
action statements into real executable work objects — title, description,
assignee, due date, status, source, dependencies — with the acceptance gate
"20 actions, all persisted, attributable, undoable, synchronized." The
standing temptation, rejected at the fork: a separate actions table, the
shape every integration-driven roadmap reaches for first.

The recon proved the opposite is already built: statement + issue fields
coexist on one node end to end (reducer spreads preserve both, the
validator has no cross-rule, workspaceSchema parses both, the inverses
restore both, the mock already emits the triple on one node), and
BoardView's own doctrine is "no separate task store." A separate store
would split the provenance chain (workspace → node → statement →
provenance → operation → history → realtime → undo) into two systems that
must be kept in sync — the parallel-state shape refused since C1, three
times over.

The owner's decisions: node-based; dueDate + description in IssueFields
(a third node layer would scatter work data); the six-value execution
vocabulary as convention, not a zod enum (existing "To Do"/"In Review"
boards must load unchanged); the two status systems never derive from each
other — and per the review, _issue status is independently editable;
"assigned" is an AI/default initialization convention, not a derived
state_; dependencies deferred entirely to D3, with the eleven questions
they raise recorded as D3's ADR outline. Two review clarifications locked
in: relative dates resolve against the meeting/message timestamp (a fixed
reference — deterministic per input, no calendar/timezone infrastructure),
and the server/core validator stays authoritative where a textarea doesn't.

## Decision

**The D1 contract**: _An Action is an ordinary Lucent workspace node that
carries an action statement and execution metadata. Users and AI can
assign, describe, schedule, and update its work state through the existing
validated operation protocol without introducing a second task store or
changing semantic statement lifecycle. Existing free-form boards remain
compatible._

1. **One node, two layers.** The statement layer answers _what is this
   semantically_ (kind=action, lifecycle, topic, provenance); the issue
   layer answers _how is the work managed_ (assignee, priority, points,
   status, dueDate, description). `actionNodes(workspace)` selects the
   executable actions: statement.kind === "action" AND an issue present —
   a bare action statement is still just a statement ("maybe we should
   redesign onboarding" is not work).
2. **dueDate is the system's first date field**: ISO YYYY-MM-DD,
   regex-validated at the op boundary; `resolveDueDate(words, referenceAt)`
   resolves relative phrases deterministically against a reference
   timestamp (strictly-forward weekdays — today never matches; "next X"
   is the upcoming X, the way people speak; "the Nth" rolls forward when
   past; explicit ISO passes through; unresolvable words store nothing,
   never a guess). Never store "Friday."
3. **The vocabulary, not an enum**: `EXECUTION_STATUSES` = open, assigned,
   in_progress, blocked, completed, cancelled — taught to the AI, rendered
   by Intelligence, mapped by `executionStatusColumn` onto the Board's
   three columns (open/assigned→todo, in_progress/blocked→in_progress,
   completed/cancelled→done). The Board column is a PROJECTION of the
   execution state, never its definition; legacy labels keep
   `categorizeStatus`'s keyword behavior unchanged.
4. **No derivation, in any direction**: statement status never derives
   from issue status; issue fields never derive from each other. The tests
   pin the review's exact cases — unassigning a completed action leaves it
   completed; changing status never touches the assignee; completing work
   never clears its owner.
5. **The five-place duplication rule**, restated as it bit: every new
   IssueFields field lands in model.ts, operations.ts (schema + both ops),
   reducer.ts, inverse.ts (free — SET/UPDATE inverses replay whole
   objects), and workspaceSchema.ts's deliberate restatement (looser on
   load, so a board predating the contract parses) — or it is silently
   stripped on every persisted load. The persistence round-trip test is
   the standing guard.
6. **"Overdue" is rendered, never persisted**: computed at render from
   today (timezone-naive — the field is a calendar date, not an instant;
   the day after counts, today does not), tinted in Intelligence and the
   Board card.

**Deliberately not built**: dependencies in any form — D3's ADR must
answer direction, cardinality, cycles, rendering, deletion, undo,
edge-vs-metadata, and blocker propagation before a field exists; a separate
actions/execution store; a new operation family (SET_ISSUE/UPDATE_ISSUE
carry everything, so MCP and the room gain the fields for free); an
execution-status enum or transition validation (a state machine needs
lifecycle evidence first — the C2 freeze-rule doctrine); external
execution links, provider/externalId (D4/D6); an execution dashboard
(Board + Intelligence project D1; the dashboard is D9); reminders or
notifications; calendar/timezone infrastructure (the reference-timestamp
rule is the whole of D1's date policy).

## Consequences

- The op protocol carries D1 for free: every write path (web send, manual
  HUD edits, MCP/agent, the room, generate with repair) validates,
  authorizes, sequences, and undoes the new fields without a single new
  mechanism — "20 synchronized" is the room doing what it already does.
- The AI teaching lands in visual-agent v6 and the meeting-extract
  prompt: the canonical vocabulary, dueDate resolution against the
  conversation's/meeting's date, and the attribution boundary extended —
  a hedged mention creates no task with a deadline merely because the
  noun phrase looks actionable.
- The mock's launch-brief script finally carries the date its explanation
  always claimed; the golden gate pins the full D1 action (the deep-equal
  key-count rule means expectations name complete nested objects).
- Intelligence renders the action row complete — assignee, deadline,
  execution status beside the statement lifecycle — and the Board shows
  the due-date chip; MCP's summary exposes the fields so agents reason
  over deadlines.
- The two-lives-one-node model composes with everything downstream: D2's
  plan generation reads `actionNodes`, D4's ExecutionProvider targets
  exactly these nodes, and D7's provenance chain (meeting → turn →
  statement → action → external task) is this node plus one link.
