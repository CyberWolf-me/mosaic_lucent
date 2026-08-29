# Architecture decision records

Each file records one decision, the forces behind it, and what it costs us. The
format is deliberately short: context, decision, consequences, status. An ADR is
never edited to change its decision — it is superseded by a later one that links
back to it.

| ADR                                         | Decision                                                               | Status   |
| ------------------------------------------- | ---------------------------------------------------------------------- | -------- |
| [0001](0001-op-log-over-crdt.md)            | Server-authoritative sequenced op log, not a CRDT                      | Accepted |
| [0002](0002-framework-free-http.md)         | `node:http` + a small typed router, no web framework                   | Accepted |
| [0003](0003-cookie-sessions-over-bearer.md) | httpOnly cookie sessions for browsers, bearer for programmatic clients | Accepted |
| [0004](0004-postgres-fanout-over-redis.md)  | Postgres `LISTEN/NOTIFY` for cross-instance fanout, not Redis          | Accepted |
| [0005](0005-operations-as-ai-contract.md)   | AI emits validated semantic operations, never pixels or free text      | Accepted |
| [0006](0006-optional-postgres.md)           | Postgres optional; in-memory stores are a first-class implementation   | Accepted |
