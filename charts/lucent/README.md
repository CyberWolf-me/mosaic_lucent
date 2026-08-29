# Lucent Helm chart

Minimal Kubernetes deployment for the Lucent server + web SPA.

## TL;DR

```sh
helm repo add lucent https://lucent.example.com/charts
helm install lucent lucent/lucent \
  --set image.tag=$(git rev-parse --short HEAD) \
  --set existingSecret=lucent-secrets
```

## What this chart installs

| Resource              | Purpose                                                                |
| --------------------- | ---------------------------------------------------------------------- |
| `Deployment`          | Lucent server pods (default 2 replicas, soft anti-affinity)            |
| `Service`             | ClusterIP on port 80 → container port `4387`                           |
| `Ingress` (optional)  | Public-facing TLS terminator                                           |
| `PodDisruptionBudget` | `minAvailable: 1` so a node drain during rollout stays safe            |
| `ServiceMonitor`      | Scrape `/metrics/prometheus` when the Prometheus operator is installed |

## Required secret keys

When you set `existingSecret` (recommended), supply these keys:

| Key                            | Example                                            |
| ------------------------------ | -------------------------------------------------- |
| `LUCENT_DATABASE_URL`          | `postgres://lucent:...@db.example.com:5432/lucent` |
| `LUCENT_AI_TIMEOUT_MS`         | `90000`                                            |
| `LUCENT_LLM_API_KEY`           | (only if not using BYO keys per request)           |
| `LUCENT_STRIPE_SECRET_KEY`     | (only when Stripe billing is enabled)              |
| `LUCENT_STRIPE_WEBHOOK_SECRET` | (only when Stripe billing is enabled)              |
| `LUCENT_SCIM_TOKEN`            | (only when SCIM provisioning is enabled)           |
| `LUCENT_S3_*`                  | (only when asset backend is S3)                    |

Never put cleartext secrets in `values.yaml`. The chart reads them only
from the Secret, never from the inline `env` map.

## Postgres

The chart does **not** manage Postgres. Run a managed instance (RDS, Cloud
SQL, Crunchy) and grant Lucent the connection. Migrations run on every
Lucent boot, serialized by an advisory lock — `docs/runbooks/upgrade.md`
documents the rolling-restart order.

## Upgrades

Read [`docs/runbooks/upgrade.md`](../../docs/runbooks/upgrade.md) before
running `helm upgrade`. In short:

1. Inspect the new chart version's `values.yaml` for new keys.
2. If the new image carries a migration, ensure replicas stay at >=2 and
   let one pod migrate before the next restarts (the boot-time advisory
   lock handles this automatically; do not pin `replicaCount: 1`).
3. `helm upgrade lucent lucent/lucent -f values.yaml --set image.tag=...`.

## Where to read more

- `docs/runbooks/deploy.md` — rollout steps + smoke checks.
- `docs/runbooks/rollback.md` — what to do when the deploy broke.
- `docs/runbooks/upgrade.md` — version-aware migrations and helm notes.
- `docs/runbooks/incident.md` — oncall entry point.
- `docs/runbooks/restore.md` — restore from backup.
- `docs/reliability/slo.md` — what "doing OK" means in numbers.
- `docs/runbooks/oncall.md` — first five minutes of an alert.
