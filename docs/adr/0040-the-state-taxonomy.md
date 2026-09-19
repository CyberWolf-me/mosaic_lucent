# 0040 — The state taxonomy: canonical, derived, ephemeral

- Status: Accepted
- Date: 2026-09-14
- Drivers: docs/20 (the 2026-09 production-architecture advisory, §2)

## Context

Lucent has accumulated several kinds of state across its stores, caches,
projections, and process-local maps. Each kind already behaves correctly in
isolation — the op log is authoritative, the Intelligence view recomputes,
presence is in-memory — but the _classes_ were never written down as a rule.
That is the kind of gap that closes badly: the first contributor who "just
persists the search index for speed" or "just caches the plan in the
database" has created a second source of truth, and nothing in review names
the violation.

The advisory's §2 states the invariant this ADR formalizes: one canonical
state, not five competing sources of truth.

## Decision

Every piece of state in the system belongs to exactly one of three classes,
and the class dictates what may be done to it.

**Canonical state** — the system of record. Survives restarts, is
transactional, and is the only thing a mutation may write:

- the workspace semantic state and its operation history (op log + board
  snapshots — ADRs 0001, 0009, 0010)
- meeting records: transcripts, provenance, extracted statements
- execution records: actions, the execution ledger, integration links,
  inbound change queue
- integration connections and webhook event ledgers
- identity and organization state: users, sessions, orgs, memberships,
  entitlements, usage events
- asset metadata (bytes are the blob backend's, ADR: assets stay
  content-addressed)

**Derived state** — a pure function of canonical state, recomputable at any
time, never authoritative:

- the search/retrieval corpus (ADR 0024: one seam)
- the Intelligence view and cross-meeting memory (ADR 0026: projection)
- the plan and execution graph (ADR 0028)
- rollups, metrics, telemetry counters
- attention items, the activity feed, dependency calculations

**Ephemeral state** — process-local, disposable by design, and owned by the
process that holds it:

- WebSocket connections and room membership; presence cursors (a room is a
  live projection, not durable truth)
- in-memory caches: the limiter's sliding window, the usage tracker's
  day-counter, the prompt-response cache
- generation progress, temporary UI state
- the in-memory dev stores (ADR 0006's fallback)

The rules, each with a concrete refusal:

1. **A cache never becomes truth.** If a cached value (e.g. a limiter's
   window) is needed cross-instance, the fix is to move the _decision_ to a
   durable store behind the same interface — not to pretend the per-process
   map is shared. The PgTicketStore over the TicketStore seam is the worked
   example.
2. **A projection never becomes a second database.** A derived view may be
   materialized for speed only if it carries a derivation source and can be
   dropped and rebuilt from canonical state without user-visible loss; it
   must never accept writes.
3. **A provider link never enters workspace semantics.** External ids
   (Linear keys, Jira ids) live in the execution/integration domain with
   their own tables; nodes carry semantic `issue` fields only. Inbound
   changes are proposals for human review (ADR 0033), never direct writes.
4. **Ephemeral state is never required for correctness.** Killing any
   process must lose at most in-flight presence, never a committed fact.
   Recovery reads canonical state and clients resync from their `lastSeenSeq`.

## Consequences

- Review now has a vocabulary: "which class is this?" is answerable, and a
  PR that writes derived state from a non-canonical path, or persists
  ephemeral state to fix a race, is visibly wrong.
- The audit table in docs/20 §2 doubles as the class map for current
  stores.
- The outbox (P2) and jobs (P3) land entirely inside this taxonomy: outbox
  events are canonical (transactional, part of the commit), job rows are
  canonical-adjacent (durable, idempotent, owned by the job system), and
  their progress reporting is ephemeral.
- Cost: canonical state gains two more tables, and every new surface must
  answer the class question in its PR description. That is the point.
