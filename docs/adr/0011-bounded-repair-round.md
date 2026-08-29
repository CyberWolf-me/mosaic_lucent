# 0011 — One bounded repair round for batches that fail validation

- Status: Accepted
- Date: 2026-08-28

## Context

Model output is schema-parsed and then semantically validated against real board
state (`/api/generate`, `docs/09 §8`). A batch can fail for a benign reason — a
reference to a node renamed a turn ago, an ordering the deterministic repairer
cannot fix — and the user-visible result is a bare 422 and a manual retry. But
each repair attempt is a billable provider call, and an unbounded loop "fix it
until it validates" is a cost amplifier with no floor.

## Decision

Exactly one repair round: when the first batch fails validation, the server
re-asks the provider once with the rejected batch and the validator's complaints
embedded in the request, clamped to the same message cap every request obeys.
The corrected batch runs the identical filter/stamp/validate path as the first —
it gets no trust upgrade by surviving a round. A provider failure inside the
round is not a 502: the first call succeeded, so the honest answer is the
original 422 with `repaired` naming what happened. Metering sums both calls.

## Consequences

- Benign, describable failures self-heal without a user-visible error.
- Cost is bounded: at most two provider calls per request, and the second only
  when the first produced an invalid batch.
- The repair prompt contains only board state and our own validation messages —
  it is not a second injection surface.
