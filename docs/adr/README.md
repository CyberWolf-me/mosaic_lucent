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
| [0007](0007-stripe-idempotency-ledger.md)   | Stripe events settle through an idempotent ledger table                | Accepted |
| [0008](0008-oauth-linking-by-verified-email.md) | OAuth links accounts by verified email, never by address guess     | Accepted |
| [0009](0009-durable-seq-allocation.md)      | Sequence numbers allocated by the database, not a counter in memory    | Accepted |
| [0010](0010-snapshots-over-op-log.md)        | Snapshots bound replay; the op log is pruned only below the floor       | Accepted |
| [0011](0011-bounded-repair-round.md)        | Exactly one repair round on validation failure                          | Accepted |
| [0012](0012-prompt-identity-response-cache.md) | Responses cached by prompt identity (id, version, rendered hash)     | Accepted |
| [0013](0013-saml-verification-without-framework.md) | SAML verified in-house from the spec, no SAML framework       | Accepted |
| [0014](0014-groups-as-diagram-regions.md)   | Groups carry an optional diagram kind; one board, many lenses           | Accepted |
| [0015](0015-spatial-additivity-and-live-meetings.md) | Scoped relayout + live meeting capture, one Stage A decision     | Accepted |
| [0016](0016-operation-protocol-idempotency.md) | requestId replay guard runs before validation (Stage B1)             | Accepted |
| [0017](0017-operation-actor-model.md)        | user/ai/system + initiatedBy/approvedBy on every log entry (Stage B2)  | Accepted |
| [0018](0018-proposals-are-server-records.md) | Proposals are database records with a transition guard (Stage B3)      | Accepted |
| [0019](0019-history-depth-query-boundary.md) | history.depth bounds reads, never deletes (Stage C1)                    | Accepted |
| [0020](0020-answer-call-type.md)            | generateAnswer: citations validated at the boundary (Stage C1)         | Accepted |
| [0021](0021-statements-live-on-nodes.md) | Statements live on nodes as validated operations (Stage C2)         | Accepted |
| [0022](0022-provenance-rides-the-operation.md) | Provenance is a field of the originating operation (Stage C2)     | Accepted |
