---
"@lucent/server": minor
---

Stage D5: external action safety — propose → preview → approve → execute, exactly once (ADR 0031). The ledger dedupes attempts; the provider's idempotency key dedupes effects; the acceptance (timeout → retry → 1 task, 1 reference, 0 duplicates) is only literally true with both.

- **The ledger** (`src/integrations/ledger.ts`): the billing-event shape
  generalized to outbound mutations — the claim triad, the stale window,
  max attempts, the sweep feed — with the one generalization the problem
  demands: the row stores the payload (an intended external create has
  no external copy; the pending record IS the replay source).
- **The key** (`CreateTaskInput.idempotencyKey`): the executor threads a
  stable per-node key so a retry after a partial failure cannot duplicate;
  the FakeProvider honors it and gains failNext/hangNext fault arms.
- **The approval record**: B3's pattern in a new kind — the decided-once
  guard, one-pending-per-(board,provider), the honest preview with the
  nothing-deleted statement, reject with ZERO external effects, the
  per-item failure isolation.
- **The acceptance**: the timeout → retry story proven at the assertion
  level — the failed attempt is recorded while only one effect per node
  exists; the sweep cannot double-apply; a viewer gets 404 on every
  mutation.
