# 0007 — Stripe webhook delivery runs through an idempotency ledger

- Status: Accepted
- Date: 2026-08-28

## Context

Stripe redelivers a webhook until it sees a 2xx, and can deliver the same event
more than once even after a success. A handler that grants seats or flips a
subscription to `active` therefore has to be exactly-once _in effect_, and a
worker that claims an event and crashes must not strand it.

## Decision

Every verified delivery is claimed through a ledger keyed by the Stripe event id
(`stripe_events` table; in-memory twin in `billing/events.ts`). `claim` answers
`claimed` / `duplicate` / `in_flight`; a `received` row older than the stale
window (60s) is re-claimable, which is what makes a crash recoverable without a
separate lease table. Handlers throw to mean "retry me"; an unrecognised
subscription status or an unresolvable org is a throw, never a guess. A sweep
(`sweepStripeEvents`) replays `failed` and abandoned rows from Stripe's own
event store — the ledger deliberately keeps no payload, so Stripe's 30-day
window is the only copy of what a failed delivery said.

## Consequences

- Duplicate and out-of-order deliveries are no-ops in effect; two app instances
  cannot both run a handler (the primary key decides races).
- The ledger is a second store of event _metadata_ only — ids, statuses, error
  text — which keeps the compliance surface small.
- An endpoint subscribed to a type with no handler records `ignored` rows, so a
  missing handler is visible in the ledger rather than silent.
