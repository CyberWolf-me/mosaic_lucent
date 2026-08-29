# Deploy

Ship a new build. Read [rollback.md](./rollback.md) before you start, not after.

## Before you begin

- [ ] CI is green on the commit you are shipping — all four jobs (`verify`,
      `lint`, `audit`, `build-image`) plus CodeQL. `build-image` proves the image
      boots and serves `/health`; `verify` proves the tests pass against a real
      Postgres.
- [ ] You know whether this build contains a migration:
      `ls packages/server/migrations/*.sql | tail -3` on the new commit versus
      the running one. If it does, read "Deploys that carry a migration" below.
- [ ] A fresh backup exists (`sh scripts/backup.sh`), and you know its filename.
      Deploying without one means a bad migration has no floor under it.

## The sequence

1. **Build and tag the image** from the exact commit:

   ```sh
   docker build --build-arg NODE_VERSION=22 --tag lucent:<git-sha> .
   ```

   Tag by commit sha, never `latest`. `rollback.md` needs the previous tag to
   still mean something specific.

2. **Take the backup** if you have not:

   ```sh
   LUCENT_DATABASE_URL=<prod-url> sh scripts/backup.sh
   ```

   It verifies the archive and records the schema version in a `.manifest`
   sidecar. Note the printed `schema NNNN`.

3. **Migrate.** The server migrates on boot, so for most deploys you can simply
   start the new image — `packages/server/src/db/migrate.ts` holds a session-level
   advisory lock (`1279479111`), so a rolling deploy with several instances
   booting at once is safe: the first migrates, the rest read a complete ledger
   and do nothing.

   Run it ahead of the deploy instead when the migration is slow (more than the
   60s `LOCK_WAIT_MS`, or anything that rewrites a large table):

   ```sh
   LUCENT_DATABASE_URL=<prod-url> npm -w @lucent/server run db:migrate
   ```

   That path takes the same lock, so booting instances still cannot overlap it.

4. **Start the new image.** Minimum environment (see `.env.example` for the full
   list, and note that the server refuses to boot in production without a
   session secret of 16+ characters):

   ```sh
   docker run -d --name lucent \
     -p 4387:4387 \
     -e LUCENT_HOST=0.0.0.0 \
     -e LUCENT_WEB_ORIGIN=https://<your-host> \
     -e LUCENT_DATABASE_URL=<prod-url> \
     -e LUCENT_SESSION_SECRET=<32-byte hex> \
     lucent:<git-sha>
   ```

   `LUCENT_WEB_ORIGIN` must be the URL the browser actually hits: it drives the
   CORS allowlist, the CSRF origin check, and the links in verification, reset
   and invite emails. Getting it wrong makes logins fail and emails point
   somewhere useless.

5. **Verify, in this order.** Stop and roll back at the first failure.

   - `curl -fsS https://<host>/health` → `200`. Deliberately minimal; it leaks
     nothing about versions or providers.
   - Boot log names the mode: `[lucent] …  auth: required …`. If it says
     `auth: optional`, `LUCENT_REQUIRE_AUTH` is set to `0` and every board is
     readable by anyone who can reach the port. That is a stop-the-deploy defect
     in production.
   - Log in as a real user, open a board, make an edit, reload. That exercises
     sessions, CSRF, the op log and the snapshot path in one pass.
   - Two browsers on one board: an edit in one appears in the other. Realtime is
     the feature most likely to break silently, because HTTP keeps working.
   - `curl -fsS -b <session-cookie> https://<host>/metrics/prometheus | head` →
     `lucent_http_requests_total` present, and the `status="5xx"` series not
     climbing. Both metrics endpoints require a session unless auth is disabled.

6. **Watch for ten minutes.** 5xx rate and p95 latency from
   `lucent_http_request_duration_seconds`, plus the log stream for
   `unhandled_request_error`. Every response carries `x-request-id` and every
   5xx logs that id, so a user-reported failure is greppable.

## Deploys that carry a migration

The constraint that decides whether you can roll back: **the old build must be
able to run against the new schema.** Nothing enforces this, so it is a review
question on the PR that adds the migration.

- Additive migrations (new table, new nullable column, new index) satisfy it
  automatically. Prefer them.
- A destructive change (drop, rename, `NOT NULL` on a column the old build does
  not write) does not. Split it across two deploys: ship the code that tolerates
  both shapes first, then the migration, then the cleanup. If you ship it in one
  go, rollback means a restore, and `rollback.md` will tell you the same thing
  under more pressure.

## Shutdown

`SIGTERM` and `SIGINT` are handled (`packages/server/src/main.ts:285`): the
WebSocket server closes, then the HTTP listener, then the pool. Give the
container at least a few seconds to stop before killing it, or you drop live
editors mid-op instead of letting them reconnect.
