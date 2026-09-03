---
"@lucent/ai": minor
"@lucent/web": minor
"@lucent/server": minor
---

Stage C1: history and Ask — the board's evolution becomes queryable, and the AI pill learns to answer questions about it with citations.

- **History API (`@lucent/server`, `@lucent/web`)**: `GET
  /api/boards/:id/history` serves the op log's windowed revision timeline —
  actor names, labels, touched objects, and the proposal link for gated
  changes. `history.depth` (Free 25 / Pro 500 / unlimited) is enforced as a
  read boundary for the first time: nothing is deleted, so upgrading
  instantly reveals the older revisions of the same log (ADR 0019).
- **Ask Lucent (`@lucent/server`, `@lucent/ai`, `@lucent/web`)**: the AI
  pill gains a Build/Ask toggle. Build mutates; Ask answers questions about
  the board and its history, read-only, and every citation is validated
  against real, caller-visible state before it renders — an invented or
  out-of-window citation is dropped while the answer survives (ADR 0020).
  Viewers may ask (asking is reading); asks bill the same monthly AI
  allowance, metered with `mode: ask`.
- **The answer call type (`@lucent/ai`)**: `generateAnswer` joins
  `generateOperations` as the second provider surface, with the
  board-historian prompt (emits no operations) and the
  `answer_with_citations` tool derived from the same Zod-first pattern as
  the canvas tool. The offline MockProvider cites only ids the context
  really contains, so the offline demo exercises the same citation
  validation the real provider faces.
- **Honest windows everywhere**: truncated history is disclosed in the API
  envelope (`hasMore`/`historyDepth`), in the model's context (the historian
  prompt's rule: never answer "nothing happened" on the strength of a
  short window), in the history view's depth banner, and by the meeting
  digest sharing the same window floor.
