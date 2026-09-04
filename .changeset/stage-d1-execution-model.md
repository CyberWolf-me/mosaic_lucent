---
"@lucent/core": minor
"@lucent/ai": minor
"@lucent/web": minor
"@lucent/mcp": minor
---

Stage D1: the execution model — the action becomes executable work (ADR 0027). One node, two layers, one vocabulary; no second task store, no new operation family.

- **The fields (`@lucent/core`)**: IssueFields gains `dueDate` (ISO
  YYYY-MM-DD, regex-validated — the system's first date field) and
  `description` (≤2000). UPDATE_ISSUE patches both; no field ever derives
  another — "assigned" is an initialization convention, not a derived state,
  and the statement lifecycle never derives from the issue status. All five
  schema/restatement places landed; the persistence round-trip test guards
  the strip trap.
- **The vocabulary (`@lucent/core`)**: the canonical execution statuses —
  open, assigned, in_progress, blocked, completed, cancelled — as
  convention + teaching + an explicit Board-column projection (not a zod
  enum; existing free-form boards load unchanged). `actionNodes()`
  selects the executable actions; `resolveDueDate()` resolves "by Friday"
  deterministically against a reference timestamp — never stores the word.
- **Teaching (`@lucent/ai`, `@lucent/web`)**: visual-agent v6 and the
  meeting-extraction prompt teach dueDate resolution, the vocabulary, and
  the attribution boundary (a hedged mention creates no deadline-bearing
  task). The mock finally carries the date its explanation always claimed;
  the golden gate pins the full D1 action at score 1.
- **The surfaces (`@lucent/web`, `@lucent/mcp`)**: the Intelligence action
  row completes (assignee, due date, execution status, overdue tint —
  rendered, never persisted); Board cards show the due-date chip; MCP's
  board summary exposes the fields so agents reason over deadlines.
