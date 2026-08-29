# 0004 — Postgres `LISTEN/NOTIFY` for cross-instance fanout, not Redis

- Status: Accepted
- Date: 2026-08-28

## Context

Rooms, presence and the broadcast socket set are per-process today, so two
instances serving one board diverge. Scaling out needs a message bus. Redis is
the default answer; it is also a second stateful dependency to run, secure,
back up and reason about during an incident.

## Decision

Fan out through the database we already require for durability: a `Fanout`
interface with an in-process implementation for single-instance and tests, and a
Postgres `LISTEN/NOTIFY` implementation for multi-instance. Presence moves to a
table with a TTL sweep. The op log — not the bus — remains the source of truth,
so a dropped notification costs a replay, never a lost edit.

## Consequences

- One stateful dependency instead of two. Operational surface, backup story and
  the security questionnaire all stay smaller.
- `NOTIFY` payloads are capped at 8000 bytes, so notifications carry
  `{boardId, seq}` and receivers read the ops they are missing from the log. That
  extra read is the price of correctness and it is bounded.
- `LISTEN` needs a dedicated connection per instance outside the pool.
- Throughput ceiling is lower than Redis pub/sub. It is far above the load a
  Team-tier board generates; if a deployment outgrows it, `Fanout` has exactly
  one implementation to add, because nothing above it knows how fanout works.
