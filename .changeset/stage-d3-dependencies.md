---
"@lucent/core": minor
"@lucent/ai": minor
"@lucent/server": minor
"@lucent/web": minor
"@lucent/mcp": minor
---

Stage D3: dependencies & blockers — the flat work becomes an execution graph (ADR 0029). Typed relationships on existing edges; cycles rejected at the authoritative validator; derived truth computed beside manual state, never merged.

- **The graph (`@lucent/core`)**: `depends_on` (canonical) and `blocks`
  normalize into one upstream adjacency; `related_to` never propagates.
  The validator rejects dependency cycles — including ones formed within a
  single AI batch — naming the cycle. Deletion and undo inherit the edge
  machinery unchanged.
- **Derived execution (`@lucent/core`)**: `blockedBy` (transitive upstream
  blocked, executable nodes only) and `atRiskBy` (overdue-unfinished
  upstream — blocked not excluded, trouble compounds) — a pure projection,
  never stored, recovery is re-computation. Manual `issue.status` stays
  independently editable; the two layers never merge.
- **Teaching (`@lucent/ai`)**: visual-agent v8 teaches the vocabulary with
  the direction pinned — the waiting work is the source, the prerequisite
  is the target. The golden gate pins the direction at score 1.
- **The surfaces (`@lucent/web`, `@lucent/mcp`, `@lucent/server`)**:
  Intelligence shows blocked-by/at-risk lines; the Board card carries the
  ⚠/⌛ badges without refiling; dependency edges render as a quiet dash;
  MCP and the Ask digest expose the derived truth so agents and answers
  reason over structure, not labels.
