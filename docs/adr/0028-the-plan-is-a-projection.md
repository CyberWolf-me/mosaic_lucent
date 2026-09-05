# 0028 — The plan is a projection, proposed and approved

- Status: Accepted
- Date: 2026-09-05

## Context

Stage D2 opens with the owner's milestone: turn the board's semantic state
into an executable plan — input from a meeting, selected statements, or the
current Intelligence selection — with the acceptance fixture (4 decisions,
6 actions, 3 requirements, 5 proposals, 4 questions, 2 risks) proving:
actions preserved, decisions create structure, proposals and questions
never silently converted, and every generated item carrying provenance
back to its source statements. docs/05's line is the north star: "create a
plan from today's meeting is a projection, not a re-entry problem."

The recon found D2's machinery already standing: the B3 proposal pipeline
is a complete propose→review→approve→apply gate (PROPOSAL_THRESHOLD=5 —
any real plan exceeds it; the approve path's AI actor chain means no plan
item ever appears human-decided); canvas multi-select already flows into
`send(text, sel)`; CREATE_GROUP regions (ADR 0014) render plan structure;
and `createdFrom` — the statement→action link — existed nowhere, the one
genuine gap.

The owner's decisions (via the recommended options): createdFrom rides the
provenance family; pill + Intelligence checkboxes as the input surfaces;
a PLAN_SAFE_OPS gate so the anti-conversion rule is mechanical; group
regions render the plan.

## Decision

1. **createdFrom is the provenance family's second evidence kind.**
   `provenanceFieldsSchema` gains `createdFrom?: string[]` (≤20 source
   statement node ids); `meetingId` becomes optional with an at-least-one
   refine — meeting evidence OR plan evidence, both coexisting when a plan
   comes from a meeting's decisions. `attachPlanProvenance` MERGES where
   `attachProvenance` fills: an op with meeting evidence keeps it and gains
   the sources (idempotent — the server's approve-time enrichment is a
   no-op over a client stamp). ADR 0022's extension clause executed
   verbatim: "they extend attachProvenance rather than inventing a third
   mechanism." The five-place rule held (model, op schema, workspaceSchema
   — looser on load, reducer, inverse — no change; DELETE_NODE's restore
   re-emits provenance verbatim, verified).
2. **PLAN_SAFE_OPS makes the acceptance rule mechanical.** A plan request
   (SendAttachments.plan) filters the model's ops against the allowlist:
   creation and organization only — CREATE_NODE, SET_STATEMENT, SET_ISSUE,
   UPDATE_ISSUE, CREATE_GROUP, CONNECT_NODES, SET_GROUP_KIND.
   Mechanically absent: UPDATE_STATEMENT (the one op that converts a
   proposal into confirmed work — a plan can never resolve a question or
   confirm a proposal; only a human does, visibly, through the HUD),
   DELETE_* (a plan never destroys), CHANGE_TEXT (a plan never rewrites).
   Skipped ops join the reply's skippedNote — the gate is honest about
   what it refused, never a silent drop.
3. **The B3 pipeline is the plan's approval.** No new gate, no plan kind
   field, no migration: the plan is an ordinary >5-op batch whose request
   text names it, opening the proposal panel; approving applies it through
   the room with the AI actor chain (`initiatedBy` the requester,
   `approvedBy` the decider) — the "no task appears human-decided if the
   model invented it" guarantee, structural.
4. **The plan is board content, not a view.** Decisions organize into a
   CREATE_GROUP region (kind process/decisiontree, ADR 0014's mechanism,
   spatially additive per ADR 0015); requirements/risks derive action
   nodes (the D1 triple, stamped createdFrom); existing actions pass
   through preserved (UPDATE_ISSUE at most). Intelligence and Board
   render the result through their existing projections; no plan
   dashboard exists in D2 (D9's territory).
5. **The input is a list of node ids and one send.** Canvas multi-select
   → pill (worked before D2; zero changes) and Intelligence checkboxes →
   "Plan from selection (N)" (the kind-aware surface) both reduce to
   `send(planRequestText, undefined, { plan: { statementIds } })`.

**Deliberately not built**: the Ask-citation→selection bridge and
region-based selection (no existing consumer; new wiring for nothing —
revisit on evidence); a plan kind/flag on the proposal record (store +
migration for a label the request text carries); dependencies (D3 —
CONNECT_NODES may visually sequence but carries no dependency semantics);
external execution links (D4/D6); a plan view/dashboard (D9); automatic
plan generation (a human requests every plan); re-planning/diffing
(History covers what changed).

## Consequences

- The provenance chain now reads meeting → turn → statement → action for
  plan-derived work — ADR 0027's D7 chain minus the external link, exactly
  as staged.
- The model sees deadlines: issue.dueDate + description join the summary
  and the server's workspaceFromSummary rebuild — a plan validates
  against the deadlines it must preserve (the recon's blindness finding,
  closed in both schema arms).
- A plan's trust story composes from existing ADRs: the gate's honesty
  (skippedNote), the proposal's accountability (B3), the AI actor chain
  (0017), the topic fold's convergence (0025), and provenance on the op
  (0022) — D2 added the createdFrom kind, the gate list, the checkboxes,
  and nothing else.
- createdFrom-only nodes have no ✦ meeting jump (honest — no transcript
  to open) and no reverse-provenance turn listing (honest — no turn to
  list); the HUD's planned-from rendering is where the plan's sources
  surface interactively.
- The gate composes with the repair round: a repaired re-emission passes
  through the same PLAN_SAFE_OPS filter — a second chance cannot smuggle
  a lifecycle conversion.
