# 0049 — Automation proposes; the one rule that applies is opt-in and reversible

- Status: Accepted
- Date: 2026-09-27

## Context

docs/26 A5 asks for automation v1. Four events are worth reacting to:

- a meeting ends with turns the live loop never extracted;
- a decision is approved in Review;
- work passes its due date;
- Linear, Jira or GitHub marks linked work done.

Lucent already has every piece an automation would use: the extraction
prompt, the plan gate (ADR 0028), the inbound queue (ADR 0033), proposals and
notifications. The question is how much an automation may do without a
person, when the product's rules are "the AI never touches the canvas
directly" and "major operations are gated behind human approval".

## Decision

**An automation's output is something a person reviews or reverses. Rules
that write the board make proposals. The one rule that applies a change
directly is off until an owner turns it on, and every such apply is an
ordinary op-log entry with a system actor, audited and undoable.**

- **Rules are org settings.** `OrgSettings.automation` holds four booleans,
  validated like every setting and merged one rule per PATCH:

  - `meetingExtract` and `decisionPlan` default off: they spend model calls.
  - `overdueNotify` defaults on: it only tells the person whose work it is.
  - `externalClose` defaults off: it writes the board without a review.

  A stored value that isn't a boolean runs nothing. For automation, "Lucent
  does nothing on its own" is the restrictive answer.

- **Rules are read when they run, not when they're queued.** Events go
  through the outbox (`MeetingEnded`, the new `DecisionApproved`) to jobs
  (`meeting.extract`, `decision.plan`). The hourly `sweep-overdue` is a
  recurring job. Each job reads the org's settings first, so turning a rule
  off stops work already queued.
- **A model call from an automation passes a person's gates:** the board's AI
  boundary, the org's provider policy and the monthly allowance, in that
  order. It is metered, and recorded as an AI run with no initiator (the
  system's own), tagged `automation:<rule>`.
- **The two proposal rules never displace a person.** A board holds one
  pending proposal. An automation that finds one pending proposes nothing
  (`busy`). A proposal is made on behalf of a real person: the meeting's
  recorder, or the decision's approver. That person is told
  (`automation.proposed`), and a proposal approved later records its
  approver as any proposal does.
- **Meeting extraction covers only what nothing covered.** The remainder
  starts past every turn range the board's nodes, and the meeting's pending
  or decided proposals, cite. A rejected batch was looked at, so it is never
  proposed again. The request uses the live loop's own differential prompt,
  moved to `@lucent/ai` so both ask the same way. It fits the message cap
  by taking as many turns as fit.
- **Plans go through the plan gate.** Creation and organization only, and
  every created node carries `createdFrom` the approved decisions. One
  proposal covers one Review action. A decision that already drives work
  is skipped.
- **Overdue reminders are sent once per due date.** The notification id is
  derived from the board, the node and the date, and the row's primary key
  is the dedupe across sweeps and processes. Only a person the assignee names
  exactly is told, the same matching as `work.assigned`.
- **External close applies only "done".** Other inbound words still queue
  for a person's accept. The change applies through the same helper a
  person's accept uses (`applyInboundChange`):

  - the same SET_ISSUE, the integration as the op log's system actor;
  - link bookkeeping, and the change marked `applied` by `automation`;
  - an audit row, `automation.external-close`, with no human actor.

  The board's integration boundary still refuses it.

## Consequences

- Nothing an automation produces lands on a board unseen, except work marked
  completed by a tracker the owner chose to trust. That change is visible in
  history, undoable, and never applied retroactively: turning the rule on
  doesn't apply changes already queued.
- A busy board skips the meeting remainder. The turns stay in the
  transcript, and "Re-extract from here" still reaches them. We accept this
  rather than let an automation queue proposals behind a person's.
- The shared extraction prompt exposed a live bug: its ~3.5k characters of
  instructions left the 4k message cap about 500 characters of speech, so
  the live loop's longer batches were refused whole. The cap is now 12k.
  That still bounds the prompt, at about 3k tokens.
- Assignment by name stays text matching. An assignee who matches no member,
  or several, gets no reminder. That is quieter than telling the wrong
  person.
