---
"@lucent/core": minor
"@lucent/ai": minor
"@lucent/server": minor
"@lucent/web": minor
"@lucent/mcp": minor
---

Stage D2: semantic state → plan — the board proposes its own execution (ADR 0028). The B3 proposal pipeline is the plan's approval; the anti-conversion rule is mechanical; every plan item traces to its source statements.

- **createdFrom (`@lucent/core`)**: the provenance family's second evidence
  kind — source statement ids stamped on generated plan items via
  attachPlanProvenance (merging with meeting evidence, idempotent), riding
  the one pipeline: validate, log, peers, undo.
- **The plan gate (`@lucent/web`)**: PLAN_SAFE_OPS filters a plan's ops to
  creation and organization — UPDATE_STATEMENT is mechanically absent, so
  no plan can silently resolve a question or confirm a proposal. Skipped
  ops are reported, never silently dropped.
- **Deadlines visible (`@lucent/ai`, `@lucent/server`)**: the board summary
  carries issue.dueDate and description — a plan preserves the deadlines it
  can now see.
- **The input surfaces (`@lucent/web`, `@lucent/mcp`)**: canvas multi-select
  → the pill (unchanged), and Intelligence checkboxes → "Plan from
  selection" — both one send. MCP exposes plan sources per node.
