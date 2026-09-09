# 0037 — Execution Intelligence: the drives relation, the rollup doctrine, the create-the-work bridge

- Status: Accepted
- Date: 2026-09-09
- Stages: E1 (this ADR's founding), E2 and E3 (extensions at their commits)

## Context

The Stage D reconciliation (docs/17's 2026-09-09 amendment) recorded the
future-milestone ledger: eight strategic capabilities left over when the
engineering D1–D10 closed, each "named for its own milestone, none
inheriting the D numbering." Stage E draws the first three from that
ledger — decision→action linkage (strategic D7), the execution dashboard
(strategic D17), and create-the-work (strategic D13). This ADR records
E1's `drives` relation; E2 and E3 extend it at their commits (the rollup
doctrine, the nodeIds seam on propose-ai).

## The drives relation (E1)

**`drives` is the fourth relation ADR 0029 anticipated.** 0029's
edge-vs-metadata answer ruled that new relations ride existing edges —
"edges, with their deterministic edgeId triples, inverse support, and
delete-cleanup, are the machinery built to carry them" — and named the
family split: dependency is one relation; causality is another. E1 is
that second family's first member.

The contract:

- **Typed causal edge**: `Decision —drives→ Action`. The DECISION is the
  source, the ACTION is the target — "the decision drives these actions,"
  the same direction-natural reading `depends_on` has. The validator pins
  the endpoints: the source must carry a decision-kind statement, the
  target must be executable (an action statement AND an issue) — both
  checkable within one batch (statements and issues are batch-simulated,
  the `statementOf` precedent extended with an `issueOf` presence-set).
- **Bidirectionally queryable**: `decisionDriveGraph` is the adjacency;
  `actionsFromDecision` and `decisionsBehindAction` are the two read
  directions the surfaces ask ("what work came from this decision?" /
  "which decisions caused this work?"). Read-side defensive filtering, the
  `derivedExecution` stance: an edge whose endpoints lost their meaning
  reads as no causality.
- **Never a dependency**: drives never enters `dependsOnGraph`, never
  participates in cycle rejection, never propagates blocking. Causality is
  HISTORICAL — the work exists because the decision caused it — while
  dependency is FUTURE — the work waits on something. A decision cannot
  "block" the action it caused; it already happened.
- **Free-form end to end**: `relationship: "drives"` round-trips op schema,
  load schema, summary, and digest with zero schema change, exactly as
  0029 recorded for `depends_on`. `DRIVES_RELATIONSHIP` is convention +
  validator + teaching, never a zod enum.

## The six places (0029's doctrine, applied)

1. **Validator** (`core/validator.ts`): the endpoint rule above; error
   messages name the missing side. DISCONNECT stays always-valid.
2. **Semantics** (`core/model.ts`): `DRIVES_RELATIONSHIP`,
   `decisionDriveGraph`, `actionsFromDecision`, `decisionsBehindAction`.
3. **Teaching** (`ai/prompts/visual-agent.json`, v9): the Drives section
   with the direction-explicit example models flip ("the CAUSE is the
   source, the CAUSED WORK is the target — never the reverse").
4. **Render** (`web/ui/DiagramLayer.tsx`): drives joins the quiet-dash
   `edge-dep` family — causality renders as subtly as dependency, never
   high-salience.
5. **Surfaces**: BoardView's "◆ decisions" chip on a card, the "→ N
   actions" line on Intelligence decision rows, the Ask digest's
   `[drives: N]` / `[from decision: labels]` brackets, and MCP
   summarizeBoard's `drivesActions` / `drivenByDecisions` fields — the
   same four consuming surfaces 0029 named for the dependency graph.
6. **Golden pins**: the plan golden gains its drives expectations (and a
   flipped-direction forbid); a question-only golden case forbids any
   drives edge at all — causality needs a cause.

## Consequences

- The plan flow (D2's gate, unchanged) now carries causality: the mock
  derives one drives edge per derived action (decision chosen round-robin,
  deterministic), `PLAN_SAFE_OPS` already admitted CONNECT_NODES, so the
  gate needed no change; `planRequestText` teaches the linkage.
- `createdFrom` provenance (ADR 0022) and `drives` answer related but
  different questions: createdFrom is DERIVATION EVIDENCE ("this node was
  minted from these statements"); drives is CAUSAL RELATIONSHIP ("this
  decision caused this work"). The former is stamped by the app, one-way
  and untyped; the latter is an edge, typed and queryable in both
  directions. A derived action carries both; a human-created action
  linked to a decision by hand carries only the edge.
- No new store (0029 Q4), no new statement kind (ADR 0021's freeze), no
  write-time derivation (ADR 0027 — the graph is computed on read).

## E2 extension (recorded at E2's commit)

The execution rollup's doctrine: pure client-side derivation over
`actionNodes` + `derivedExecution` + `isOverdueUnfinished`; blocked NOT
excluded from at-risk (0029's settled rule restated — trouble compounds);
at-risk stays an analytical signal, never a status; percent over
completed only. Zero server state.

## E3 extension (recorded at E3's commit)

The create-the-work bridge: the propose-ai route gains an optional
`nodeIds` array — the selector LLM is skipped when ids are supplied, but
the ids flow through the SAME dedupe → intersect → cap → warn path (the
D9 narrowing precedent applied: the human names the ids, the server
builds the items, the approve gate, warnings-409/ack, and the
exactly-once ledger all apply untouched). The plan's task tree is board
content (ADR 0028 unchanged) — workstream sub-groups over the derived
actions, drives edges connecting decisions to their work.
