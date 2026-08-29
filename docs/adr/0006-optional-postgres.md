# 0006 — Postgres is optional; in-memory stores are a first-class implementation

- Status: Accepted
- Date: 2026-08-28

## Context

`npm run dev` should work on a laptop with no services running, and the test
suite should not need a database to be meaningful. Production needs durability,
multi-instance fanout and backups.

## Decision

Every persistence concern is an interface (`BoardStore`, `UserStore`,
`SessionStore`, `TokenStore`, `TotpStore`, `OrgStore`, `AssetStore`, …) with two
implementations: an in-memory one used by default and in tests, and a Postgres
one selected when `LUCENT_DATABASE_URL` is set. Migrations run from a
hand-rolled idempotent runner against `_lucent_migrations`.

## Consequences

- Contributors get a working product with one command, and 200+ tests run
  without a container.
- Two implementations of every store means a conformance risk: an in-memory
  store can quietly diverge from SQL semantics (cascade deletes are the classic
  case). Shared conformance tests over both implementations are the mitigation,
  and Postgres-gated tests run in CI where the service exists.
- Some features are honestly unavailable without a database (cross-instance
  fanout, PITR). Those degrade to single-instance behaviour rather than
  pretending to work.
