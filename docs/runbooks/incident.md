# Incident response

Something is broken in production and you are holding it. Work top to bottom.

## What you have to work with

- `GET /health` — unauthenticated, minimal, and **does not touch the database**.
  Green here means the process is up, nothing more.
- `GET /metrics/prometheus` — RED metrics: `lucent_http_requests_total`
  (`method`, `route`, `status`), `lucent_http_request_duration_seconds`, an
  in-flight gauge, and an unhandled-error counter. Route labels are bucketed, so
  cardinality stays bounded. Needs a session cookie unless auth is off.
- `GET /metrics` — the same picture as JSON.
- **Structured JSON logs** on stdout/stderr, one object per line with `time`,
  `level`, `msg` and the caller's fields; known secret-shaped keys are redacted
  before serialisation. `error`-level lines go to stderr.
- **`x-request-id` on every response.** A user who reports a failure can read it
  out of their network tab, and every 5xx logs the same id — that is the fastest
  path from "it broke" to the exact line.

There is no error tracker and no distributed tracing. Do not spend the first ten
minutes looking for one.

## 1. Establish what is actually broken (2 minutes)

```sh
curl -fsS -o /dev/null -w '%{http_code}\n' https://<host>/health
curl -fsS -b <session-cookie> https://<host>/metrics/prometheus \
  | grep -E 'lucent_http_requests_total|in_flight|unhandled'
docker logs --tail 200 lucent 2>&1 | grep '"level":"error"'
```

Classify before acting:

| Symptom                               | Look at                                                           |
| ------------------------------------- | ----------------------------------------------------------------- |
| `/health` fails or connection refused | Process down or crash-looping → §2                                |
| `/health` ok, requests 5xx            | Route-level fault → §3                                            |
| Requests fine, edits don't sync       | Realtime → §4                                                     |
| Everything slow                       | Database or an upstream provider → §5                             |
| Users unexpectedly logged out         | Session secret changed → [rotate-secrets.md](./rotate-secrets.md) |
| Users blocked by a plan limit         | Entitlements, not an outage → §6                                  |

## 2. Process down or crash-looping

Read the boot log; the server fails loud on purpose and the reason is usually in
the first ten lines.

- `another instance is migrating: could not acquire the migration advisory lock
(1279479111)` — a previous run's session still holds it. Confirm with
  `SELECT * FROM pg_locks WHERE locktype = 'advisory' AND objid = 1279479111`,
  find the backend, and terminate that session. Do not delete migration ledger
  rows to get past it.
- `migration NNNN failed: …` — the schema is unchanged (each file runs in its own
  transaction, and a failure rolls back), so the previous image still runs
  against this database. Roll back and fix the migration:
  [rollback.md](./rollback.md).
- A config throw (`LUCENT_SESSION_SECRET` too short, missing in production) —
  fix the environment; do not work around it by disabling the check.
- `LUCENT_DATABASE_URL` unreachable — §5.

## 3. Route-level 5xx

Find the route from the metrics labels, then pull the request ids:

```sh
docker logs lucent 2>&1 | grep unhandled_request_error | tail -20
```

Every one of those lines carries the `requestId` also returned to the client in
`x-request-id` and in the error body, so a single user report pins the exact
request. Read the message before theorising; the outermost handler logs the real
error and returns a generic body, so the log has strictly more than the user saw.

If the rate is climbing and the cause is not obvious within a few minutes,
roll back and diagnose from the failing image offline.

## 4. Edits don't sync

HTTP keeps working when realtime breaks, so the app looks healthy while
collaboration is dead. Check, in order:

1. Two browsers on one board: does an edit in A reach B? Reproduce before
   changing anything.
2. Does the WebSocket connect at all? A failed upgrade is usually a proxy that
   does not forward `Upgrade`/`Connection`, or an `LUCENT_WEB_ORIGIN` that does
   not match the browser's origin.
3. `LUCENT_REALTIME_TICKET_TTL_MS` (default 60s): a clock skew or a very slow
   handshake expires the ticket before it is redeemed.
4. Does a reload show the missing edits? If yes, the op log has them and the
   fanout path is the fault. If no, the write itself failed — treat it as §3 and
   check for errors on the commit path.
5. More than one server instance: cross-instance fanout is the first suspect.
   Confirm by pinning both browsers to one instance; if sync returns, the
   instances are not talking.

## 5. Slow, or database trouble

```sh
psql "$LUCENT_DATABASE_URL" -qtAX -c 'SELECT count(*) FROM pg_stat_activity'
psql "$LUCENT_DATABASE_URL" -qtAX \
  -c "SELECT state, count(*) FROM pg_stat_activity GROUP BY state"
```

- Pool exhausted (many `idle in transaction`) — a leaked transaction. Find the
  oldest with `xact_start` and terminate it; the code path that leaked it is the
  bug to file.
- Uniformly slow reads on big boards — check the op-log query plans before
  assuming it is load.
- An upstream AI or image provider stalling shows as latency on the AI routes
  only, with `LUCENT_AI_TIMEOUT_MS` (default 90s) as the ceiling. Lower it or
  switch `LUCENT_AI_PROVIDER=mock` to keep the rest of the product usable while
  the provider is down.

## 6. "Users are blocked" that is not an outage

HTTP 402 with a structured body (`reason`, `limit`, `used`, `resetsAt`,
`suggestedPlan`) is the entitlement system working as designed. Check the org's
plan and usage before changing anything, and never raise a limit globally to
resolve one complaint.

HTTP 429 is the rate limiter (`LUCENT_RATE_PER_MINUTE`,
`LUCENT_QUOTA_PER_DAY`) or the auth limiter (`LUCENT_AUTH_LIMIT_PER_WINDOW`).
A single user hitting the auth limiter repeatedly is worth a look before you
raise it: that is also what a credential-stuffing attempt looks like.

## Also check, whatever the symptom

The boot log states the mode: `auth: required` or `auth: optional`. In
production, `optional` means `LUCENT_REQUIRE_AUTH=0` and **every board is
readable by anyone who can reach the port**, including the metrics endpoints.
That is a security incident, not a performance one — fix the environment and
treat it as an exposure.

## Afterwards

Write it down while the details are fresh:

- Timeline: first bad signal → detection → mitigation → resolution.
- What the signal was. If a user noticed before your dashboards did, that gap is
  a finding worth more than the fix.
- Recovery point, if any data was lost (see [restore.md](./restore.md)).
- What would have caught it earlier: a test, an assertion, a metric, an alert.
  File it. An incident that produces no such change will recur.
