# Runbooks

Procedures for operating a Lucent deployment. Each one is written to be followed
under pressure by someone who did not write the code: exact commands, what
"working" looks like, and what to do when it doesn't.

| Runbook                                  | Use it when                                                             |
| ---------------------------------------- | ----------------------------------------------------------------------- |
| [deploy.md](./deploy.md)                 | Shipping a new build, including one that carries a migration            |
| [rollback.md](./rollback.md)             | The build you just shipped is bad                                       |
| [restore.md](./restore.md)               | Data is lost, corrupted, or you are running the quarterly restore drill |
| [rotate-secrets.md](./rotate-secrets.md) | A credential leaked, or it is time for scheduled rotation               |
| [incident.md](./incident.md)             | Something is broken in production and you are the one holding it        |

## What these assume

- Postgres is configured (`LUCENT_DATABASE_URL`). Without it the server runs the
  in-memory stores (ADR [0006](../adr/0006-optional-postgres.md)) and nothing
  here about backups, restores or migrations applies — there is nothing to
  restore, by design.
- The unit of deployment is the container image built by the root `Dockerfile`
  (`ENTRYPOINT tini`, `CMD node packages/server/dist/main.js`, `EXPOSE 4387`,
  non-root `lucent` user). It serves the built web app same-origin, so there is
  one artifact and one thing to roll back.
- `scripts/backup.sh` and `scripts/restore.sh` are POSIX `sh` and need
  `pg_dump` / `pg_restore` / `psql` on PATH. They are meant for the deploy host
  or a container beside the database, and are deliberately not npm scripts:
  developers on Windows would find that out at the worst moment.

## What is honestly missing

Stated here rather than discovered mid-incident:

- **No deploy automation.** CI builds and smoke-tests the image
  (`.github/workflows/ci.yml`, `build-image`) but nothing pushes or promotes it.
  `deploy.md` describes the manual sequence; the ordering constraints in it are
  real regardless of what eventually automates them.
- **No feature flags.** There is no per-org or per-user rollout switch, so a bad
  feature cannot be turned off without shipping a build. Rollback is image-level
  only, which is why `rollback.md` leans on migration compatibility.
- **No error tracker and no distributed tracing.** Diagnosis is structured JSON
  logs (`packages/server/src/obs/logger.ts`) plus `/metrics/prometheus`. There is
  no Sentry and no OpenTelemetry; `incident.md` works with what exists.
- **Point-in-time recovery is your database provider's job.** `backup.sh` gives
  you periodic snapshots, which bounds data loss to the interval between them.
  If you need tighter, enable PITR/WAL archiving on the managed instance and
  record it in `restore.md` under "Where backups live".
