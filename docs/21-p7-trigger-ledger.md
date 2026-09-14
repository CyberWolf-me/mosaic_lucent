# P7 — Later, evidence-gated: the trigger ledger

> **Status: nothing built, by design.** docs/20 P7 names four things and says
> outright that none of them is built "until a measurement demands it — the
> advisory's own stance, and docs/17's Gate D."
>
> This document is P7's actual deliverable: not infrastructure, but the
> **trigger ledger** that says which measurement would justify each item and
> where that measurement is read from today. Without it, "we'll split it when
> we need to" is a belief; with it, the decision is a query.

## 1. Why this phase produces a document

The advisory's §35 gives five criteria for splitting a service out of the
monolith: independent scaling, independent deployment, failure isolation,
team ownership, and a different runtime. **None of the five can be evaluated
from a design discussion.** Every one of them is a statement about observed
behaviour, so the honest way to hold the line is to write down what evidence
would change the answer — and then check that the evidence is actually
collectable.

That last check is the useful part of this document. A trigger you cannot
measure is not a trigger.

## 2. The four items, with their triggers

### 2.1 pgvector behind the retrieval seam

- **What**: semantic search, replacing or supplementing the lexical path.
- **Seam already in place**: ADR 0024 fixes one retrieval boundary
  (`retrieve(query, corpus)`); the implementation behind it is deliberately
  not part of the contract, which is what makes this a swap rather than a
  rewrite.
- **Trigger**: users searching for a concept they cannot name and failing.
  Measurable today as `lucent_product_events_total` is not enough — the
  honest measurement is the search-surface abandonment rate, which is **not
  currently emitted**.
- **Evidence needed**: a search-failure signal. Until it exists this trigger
  cannot fire, and that is the finding: **the gap is instrumentation, not
  vector storage.**

### 2.2 Read replicas

- **What**: route history and metrics reads to a replica.
- **Trigger**: sustained primary read pressure. **Measurable today**:
  `lucent_process_resident_memory_bytes`, `lucent_http_request_duration_seconds`
  by path, and the pool's saturation (`pool.max` is 10, `db/client.ts`).
- **Evidence needed**: request latency rising with read-path load while CPU is
  not saturated — the signature of a connection-bound primary.
- **Status**: the metrics exist. This trigger is live and can fire from the
  P6 alerts without further work.

### 2.3 Op-log partitioning / archival

- **What**: partition or archive the op log as it grows.
- **Trigger**: op-log size or history-query latency, not row count alone.
- **Measurable today**: partially. The op log has a `board_id, seq` index and
  snapshots exist, so history queries do not scan the whole log. There is **no
  emitted gauge for log size or snapshot lag**.
- **Evidence needed**: a size/lag metric. Same finding as §2.1 —
  instrument first.

### 2.4 Redis

- **What**: distributed locks at real worker counts, ephemeral presence at
  scale.
- **ADR 0004's stance**: `pg_notify` over Redis for coordination, and P5
  implemented shared rate limiting in Postgres rather than Redis on the same
  reasoning.
- **Trigger**: a measured need that Postgres **cannot** serve — not "Redis is
  faster". The honest candidates are lock contention at a worker count where
  `FOR UPDATE SKIP LOCKED` shows up as contention, and presence write volume
  where the `presence` table's TTL sweep cannot keep up.
- **Measurable today**: `lucent_realtime_rooms` for presence volume; the job
  queue's claim rate is **not yet emitted** (P6 records the same gap).
- **Status**: blocked on the same instrumentation as the queue alerts.

## 3. The finding this document produces

Reading the four triggers together, three of them name the same blocker:
**the metrics the triggers would read are not emitted.** That is a more useful
conclusion than any of the four items, and it is actionable:

| Metric needed | What it would unlock | Status |
| --- | --- | --- |
| Search abandonment / failure rate | P7 §2.1 (pgvector) | not emitted |
| Op-log size, snapshot lag | P7 §2.3 (partition/archive) | not emitted |
| Job queue depth + claim rate | P7 §2.4 (Redis), P6 queue alerts | store supports it, not registered |
| Primary pool saturation | P7 §2.2 (read replicas) | partially: latency exists, saturation does not |

**Recommendation:** the next observability increment is to register the four
above, at which point every P7 trigger becomes observable and P6's commented
queue rules can be enabled. That is a measurement change, not a feature, so
it sits inside docs/17's freeze clause 2 and needs no owner decision.

## 4. What would NOT justify building any of this

Recorded so the ledger cannot be read as a to-do list:

- "The architecture diagram says so." The advisory's own §34 not-build list
  names microservices, Kafka, and Redis-as-truth; nothing here reverses that.
- A load test that saturates one process. A single-process ceiling is what
  replicas address (already available: the chart's `replicaCount` and the HPA
  from P0).
- A benchmark showing Redis is faster than Postgres for counters. P5 already
  made that comparison implicitly, and chose Postgres for the reason that
  matters: one fewer stateful dependency to operate.

## 5. Revisit triggers, restated

Each item has one, and each is a measurement rather than an opinion:

1. **pgvector** — search abandonment rising while lexical search is healthy.
2. **Read replicas** — read-path latency rising with pool saturation near max.
3. **Op-log archival** — log size or snapshot lag growing without bound.
4. **Redis** — measurable contention in the Postgres claim path, or presence
   write volume the sweep cannot keep up with.

Until one of those readings appears, the correct state of P7 is this file.
