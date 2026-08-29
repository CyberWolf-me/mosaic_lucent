# Upgrade

Move an existing deployment to a new image. Different from `deploy.md`
because the bar is higher: state may need to migrate, breaking changes
need to be sequenced, and a partial rollout can leave the deployment
in an inconsistent shape.

## Before you begin

- [ ] Read the release notes in CHANGELOG.md for the version range you are
      skipping over. Each entry says whether the release carries a migration,
      a config change, or a feature flag flip.
- [ ] Confirm the cluster has room for one extra pod during the rollout. The
      chart's `PodDisruptionBudget` keeps the deployment at `minAvailable: 1`,
      so the rolling update creates a new pod, waits for it to be Ready, then
      kills an old pod — never simultaneously — but a cluster at capacity will
      not let the new pod schedule.
- [ ] Confirm the Postgres backup is fresh (`sh scripts/backup.sh`). Migrations
      are forward-only; an upgrade that needs to roll back to the previous
      image is precisely the case the backup is for.
- [ ] Confirm the new image's `LUCENT_DATABASE_URL` matches the running one.
      Two deployments writing to the same database with different migration
      ledgers has been the source of every cross-version data loss we have
      seen.

## The sequence

1. **Bump the image tag**. Always pinned by commit sha; never `latest`.

   ```sh
   NEW=$(git rev-parse --short HEAD)
   helm upgrade lucent charts/lucent/ \
     --set image.tag=$NEW \
     --reuse-values
   ```

   `--reuse-values` carries over every override you set on `helm install`
   and every `kubectl create secret` adjustment. Confirm the rendered
   manifest looks right with `--dry-run=client -o yaml | less` before
   pushing.

2. **Watch the rollout** with both the new and old pods in flight:

   ```sh
   kubectl rollout status deployment/lucent --timeout=10m
   kubectl get pods -l app.kubernetes.io/name=lucent -o wide
   ```

   A Lucent pod boot that carries a migration takes the advisory lock and
   runs the migration; the rest wait on the lock and skip. Two simultaneous
   boots are safe because only one holds the lock at a time. Three is the
   minimum chart replica count, so two are already held back.

3. **Smoke the new pods** before the old ones die. The chart's readiness
   probe already pings `/health`; for a stronger check:

   ```sh
   POD=$(kubectl get pod -l app.kubernetes.io/name=lucent -o jsonpath='{.items[0].metadata.name}')
   kubectl exec $POD -- curl -sf http://localhost:4387/health
   kubectl exec $POD -- curl -sf http://localhost:4387/metrics/prometheus | head
   ```

   Expected: HTTP 200, then Prometheus-style metric lines. A pod that
   boots, fails the probe, and crashes `BackOff`-loops is "the new image
   is broken"; proceed to `rollback.md`.

4. **Verify the migration applied** if the release includes a new SQL file
   under `packages/server/migrations/`:

   ```sh
   kubectl exec $POD -- npm run -w @lucent/server db:migrate
   ```

   The output should list the new migrations:
   `[lucent] applied N migration(s): 0013, 0014` (or whatever the range is).
   If it says `database is up to date`, the boot already ran them.

5. **Test through the real API**. Two checks that catch the most common
   upgrade regressions (broken migration or broken first-request):

   ```sh
   DOMAIN=$(kubectl get ingress lucent -o jsonpath='{.spec.rules[0].host}')
   curl -sf https://$DOMAIN/health
   curl -sf -c cookies.txt -b cookies.txt \
        -H "Origin: https://$DOMAIN" \
        https://$DOMAIN/api/auth/csrf
   ```

   The CSRF call sets a `lucent_csrf` cookie; if it lands, the cookie
   origin-gate is wired correctly.

6. **Watch error rates for 30 minutes**. The cheapest signal is the
   Prometheus query from `docs/reliability/slo.md`'s error-rate SLO; a
   three-times-bigger spike than baseline is the threshold for "roll
   back, do not investigate".

## What "safe to roll back" means

If the new image carries a migration, rolling back the image alone is
**not safe**: the schema already moved forward. The correct order is:

1. Restore the database from the pre-upgrade backup (see `restore.md`).
2. Roll the image back.

Doing step 2 without step 1 leaves the server reading rows that look like
the old image but the new schema, which is exactly where the worst bugs
hide. If a backup isn't available, the rollback is "investigate and
forward-fix" — not "revert".

## Helm chart version vs. app version

`Chart.yaml` carries both. `version` is the chart itself (must be bumped
on every chart change), `appVersion` is the Lucent release the chart is
tested against. Operators pin `appVersion` (the image tag) and ride
`version` forward more freely; the README of each chart version lists
which `appVersion`s it has been tested against.

## When the upgrade fails

- **One pod in CrashLoopBackOff, others healthy**: that pod has bad config
  (often a Secret key the chart can't templete). Delete the pod, fix the
  Secret, watch it reschedule.
- **All pods crash after a migration**: the migration is bad. Stop the
  rollout (`kubectl rollout undo`), restore the DB, file a bug.
- **Readiness probe failing but `/health` answers 200 from `exec`**: the
  `Service` routing or `Ingress` rewrite is mismatched. Check the
  ingress annotation set, not the deployment.
- **`OOMKilled` on boot**: the chart's resources.limits are too low. Bump
  memory for the chart and re-run the upgrade; file a bug if it recurs
  at default settings (a regression).

## Pointers

- `docs/runbooks/deploy.md` — first-time deploy.
- `docs/runbooks/rollback.md` — what to do when this runbook failed.
- `docs/runbooks/incident.md` — once an alert is firing.
- `docs/runbooks/restore.md` — DB restore from backup.
