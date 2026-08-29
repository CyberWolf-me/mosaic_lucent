# 0005 — The AI emits validated semantic operations, never pixels or free text

- Status: Accepted
- Date: 2026-08-28

## Context

Most AI diagramming products generate an image or a blob of DSL text. Both are
unreviewable: you cannot diff them, you cannot enforce invariants on them, and a
model that drifts produces something that merely _looks_ plausible.

## Decision

The model's only output channel is the same discriminated-union operation
vocabulary the UI uses, expressed as a Zod schema, exported to the provider as a
JSON Schema tool definition. Every proposal is parsed, semantically validated
against the live workspace, repaired where repair is unambiguous, and applied
through the same reducer as a human edit. `AI_FORBIDDEN_OPS` withholds
operations the model has no business performing.

## Consequences

- Model output is _checkable_: invalid proposals are rejected with a reason
  instead of corrupting a board, which is what makes an eval suite meaningful
  (M5's golden set scores validity, not vibes).
- The AI is bounded by the same permission and validation gates as a user, so a
  prompt-injection attempt cannot widen what the model is allowed to do.
- Adding an operation means touching one union, and the AI can use it the same
  day. Removing one is a breaking change to prompts and stored logs.
- We pay in prompt size (the schema is large) and in the model's willingness to
  fill an unfamiliar shape; the repair pass exists to absorb the near-misses.
