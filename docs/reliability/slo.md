# SLOs

Service Level Objectives for the Lucent server, written so that
"doing OK" and "not doing OK" mean the same thing to everyone reading
this — engineering, oncall, customer success, and finance.

Every SLO is named for a user-facing capability, has a single number to
meet, and has a measurement a Prometheus query can compute from the
metrics already emitted (`/metrics/prometheus`). If the metric does not
exist, the SLO does not exist.

## Tier 1: must hold, every quarter

### API availability

- **SLO**: 99.9% of HTTP requests succeed (2xx/3xx) over 30 days.
- **Why**: the entire product is over this API; "down" is "the product
  is down". 99.9% is roughly 43 minutes of downtime per month, which
  is a realistic budget that includes planned migrations and capacity
  events.
- **Measure**:
  `sum(rate(lucent_http_requests_total{status!~"5..|4.."}[30d]))
/ sum(rate(lucent_http_requests_total[30d]))`.
- **Burn alert**: alert on a 2% error-rate spike over 15 minutes; route
  to "primary oncall" with a 5-minute response SLA. The point is to
  catch outages before the 30-day window counts them.

### Realtime reachability

- **SLO**: 99.5% of websocket connections stay connected at least
  5 minutes.
- **Why**: collaborative editing depends on presence + op-sync; an
  edge that drops every 30 seconds destroys the product even though
  `/health` is green. 5-minute connection time is the floor where
  edits feel stable to a human.
- **Measure**:
  `lucent_realtime_connection_duration_seconds{le="300"}` over the rate
  of new connections.

### AI generation latency

- **SLO**: P95 of `/api/generate` responses under 30 seconds, over the
  rolling 7-day window.
- **Why**: the user-facing promise is "talk → editable diagram".
  Anything longer than a coffee break is a different product. Excluding
  cold starts (first request after deploy) from this measurement,
  because cold models are their own measure.
- **Measure**:
  `histogram_quantile(0.95, sum(rate(lucent_http_request_duration_seconds_bucket{path="/api/generate"}[7d])) by (le))`.

## Tier 2: should hold, any quarter

### Error budget burn rate

- **SLO**: 1-hour error budget burn rate under 1.0 means "tracking"
  (consumption matches expectation). Burn rate over 4.0 means
  "fast-burn": the 30-day budget is gone in a week and the team should
  pause new feature work until the SLO recovers.
- **Measure**: standard multi-window burn-rate alert, see
  `ops/alerts.yaml` if you have access.

### Migration safety

- **SLO**: 100% of forward migrations complete on first boot of a pod;
  no manual recovery needed.
- **Why**: the migration lock is the safety net. If it fails twice in
  a row, the team's confidence (and oncall's pager volume) both
  crater.
- **Measure**: `_lucent_migrations` rows in Postgres match the
  filenames on the deployed commit sha.

## Tier 3: nice-to-have

### Asset upload success rate

- **SLO**: 99% of `POST /api/assets` succeed.
- **Why**: uploading is the hot path for image-rich diagrams; this
  is currently tier 3 because the surface is recent and we don't yet
  have enough signal on its baseline. Promote to tier 2 once a
  baseline is known.

### Cold-start latency

- **SLO**: P95 of `/health` under 200ms once the readiness probe
  is green. A container that is "ready" but slow to answer health
  is suspect (event-loop blocked); this catches that.

## What this document is not

This is not a list of _features_ we promise, and not a list of _bugs_
we will investigate first. It is the user-facing capability → the
budget for it. A feature flag that's off has no SLO; a flag that's on
has the SLO of the capability it enables.

For the alerts that ride on these SLOs, see `ops/alerts.yaml`. For
the first five minutes of an alert, see `docs/runbooks/oncall.md`.
