# Rollback

The build you just shipped is bad. Get back to the last good one.

There are no feature flags in this codebase, so there is no way to disable one
feature without shipping a build. Rollback is image-level: you run the previous
tag. That makes the schema question the whole problem.

## Decide first: did the bad build migrate?

```sh
LUCENT_DATABASE_URL=<prod-url> psql "$LUCENT_DATABASE_URL" -qtAX \
  -c 'SELECT id, applied_at FROM _lucent_migrations ORDER BY id DESC LIMIT 5'
```

Compare the top id against the newest file in `packages/server/migrations/` on
the **previous** tag.

- **Same id** → no migration ran. Go to "Plain rollback". This is the common case
  and takes about a minute.
- **New id present** → a migration ran. Go to "Rollback across a migration".

## Plain rollback

```sh
docker stop lucent && docker rm lucent
docker run -d --name lucent -p 4387:4387 \
  -e LUCENT_HOST=0.0.0.0 \
  -e LUCENT_WEB_ORIGIN=https://<your-host> \
  -e LUCENT_DATABASE_URL=<prod-url> \
  -e LUCENT_SESSION_SECRET=<same secret as before> \
  lucent:<previous-git-sha>
```

Keep the session secret identical. Changing it invalidates every session and
logs out every user, turning a rollback into a second visible incident.

Then verify exactly as in [deploy.md](./deploy.md) step 5. A rollback is a deploy
and deserves the same checks — including the two-browser realtime check, which is
what usually reveals that you rolled back to the wrong tag.

## Rollback across a migration

There is **no down-migration mechanism**: `migrate.ts` only rolls forward, and
drizzle's generated SQL has no reverse. So there are exactly two honest options.

### Option A — run the old build against the new schema (preferred)

Works when the migration was additive, which is the standard this repo asks for
in `deploy.md`. The old code ignores the new table or column and keeps working.

Do the plain rollback above, then check the log for SQL errors in the first
minute. `column … does not exist` or `null value in column … violates not-null`
means the migration was not backward compatible and Option A is out.

### Option B — restore the pre-deploy backup

Only when Option A fails. This **loses every write since the backup was taken**,
so it is a data-loss event: say so, decide with whoever owns that call, and note
the backup timestamp as the recovery point.

1. Stop the app so nothing writes during the restore.
2. Follow [restore.md](./restore.md) with the backup you took in `deploy.md`
   step 2, `--force` against the production database.
3. Start the previous image (plain rollback above).
4. Verify, then tell users what window of work was lost.

## After any rollback

- The bad image tag stays where it is. Do not delete it and do not retag: the
  build you need to debug is the one that failed.
- Write down what the failing signal actually was (the 5xx series, the log line,
  the user report) before the details fade. `incident.md` has the template.
- The fix ships as a new commit forward, never as a force-push over the bad one.
