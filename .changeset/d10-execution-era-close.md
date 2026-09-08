---
"@lucent/server": patch
---

Stage D10 — the execution era's close (ADR 0036).

- **Telemetry**: the `ai-propose` event is counted at last — a request
  count, a P50/P95 latency lane, and Prometheus mirrors
  (`lucent_ai_propose_total`, `lucent_ai_propose_duration_seconds`)
  with zero dynamic labels (the cardinality rule, pinned by test).
- **Link GC**: the sweeper collects dead Lucent→external links (board
  missing or node missing), bounded at 500 links per org per run.
- **Terminal prune**: 30-day-old terminal rows are pruned on both the
  webhook-event and inbound-change stores (bounded at 1000 rows per
  run; `failed` is retryable and never pruned; the cutoff uses the
  terminal timestamp, never `createdAt`).
- **The recovery contract**: the sync route and the approve executor
  call `recoverCreate(marker)` before creating a task for an unlinked
  action node — an existing external task is relinked by its stable
  marker (`<!-- lucent-action:key -->`), never duplicated. A failed
  lookup falls through to the create.
- **Fix**: the approve executor's timeout race now starts fresh per
  create; previously the race was constructed before the recovery, so
  a slow recovery consumed the create's timeout and rejected it.
- **The era regression**: one-process, isolated-harness spine tests
  over the D1→D9 stage contracts.
