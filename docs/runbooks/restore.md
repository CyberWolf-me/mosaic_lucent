# Restore

Bring the database back from a backup. Also: the drill you run on a schedule so
that this page is not being read for the first time during an outage.

## Where backups live

`scripts/backup.sh` writes to `$LUCENT_BACKUP_DIR` (default `./backups`) and
keeps `$LUCENT_BACKUP_KEEP` (default 14) of them. Each dump has two sidecars:

| File         | Contains                                                     |
| ------------ | ------------------------------------------------------------ |
| `*.dump`     | Postgres custom-format archive of the whole database         |
| `*.manifest` | `created_at`, `schema_at` (migration id), `bytes`, dump tool |
| `*.sha256`   | Digest, checked by `restore.sh` before it restores anything  |

**Fill this in for your deployment** — nothing in the repo can know it:

- Off-host copy: _where the dumps are replicated to, and how_
- Schedule: _what invokes `backup.sh`, how often_
- Retention: _`LUCENT_BACKUP_KEEP` in use_
- PITR: _whether WAL archiving is enabled on the managed instance_

Until off-host copies exist, the recovery point is "the last dump that survived
whatever broke the host", which for a host-level failure is none of them.

## Restore

`restore.sh` ignores `LUCENT_DATABASE_URL` on purpose — the target must be typed,
so a script run on the production host cannot default to overwriting production.

**1. Restore into a scratch database first.** Always, even in an incident: it is
two minutes, it proves the dump is good, and it lets you see what the data looks
like before you commit to it.

```sh
createdb lucent_verify
sh scripts/restore.sh --target postgres://…/lucent_verify backups/lucent-<stamp>.dump
```

The script checks the digest, parses the archive's table of contents, compares
the dump's `schema_at` against the newest migration in your working tree,
refuses a non-empty target without `--force`, restores in a single transaction
with `--exit-on-error`, and then prints row counts for `users`,
`organizations`, `boards` and `op_log`. Those counts are the point: a restore
that "succeeded" into an empty `boards` table is the failure mode this catches.

**2. Restore into the real database.** Stop the app first so nothing writes
during the restore and no client observes a half-populated schema.

```sh
docker stop lucent
sh scripts/restore.sh --target <prod-url> --force backups/lucent-<stamp>.dump
```

`--force` allows `pg_restore --clean --if-exists` to drop the existing objects.
You will be asked to type the database name; that check exists because the
mistake it guards against is a wrong URL, and someone about to make that mistake
answers "yes" to anything.

**3. Migrate forward if the schema line differed.**

```sh
LUCENT_DATABASE_URL=<prod-url> npm -w @lucent/server run db:migrate
```

**4. Start the app and verify** as in [deploy.md](./deploy.md) step 5. Add one
check specific to a restore: open a board that existed before the backup and
confirm its content and its collaborators are both there. Boards and their
membership live in different tables, and a partial restore can bring back one
without the other.

**5. Record the recovery point.** Everything written between the backup's
`created_at` and now is gone. That window is the number users need, so state it
explicitly rather than saying "we restored from backup".

## The drill

Run this quarterly, and after any change to the schema, the backup script, or
the database provider. It is the only thing that turns a backup into a restore.

1. Take a fresh backup from production.
2. Restore it into a throwaway database (step 1 above).
3. Point a local server at that database and open a board:

   ```sh
   LUCENT_DATABASE_URL=postgres://…/lucent_verify \
   LUCENT_SESSION_SECRET=drill-secret-not-a-real-one \
   npm -w @lucent/server run dev
   ```

4. Note the wall-clock time from "decided to restore" to "board opened". That
   number is your real RTO; the one you assumed is not.
5. `dropdb lucent_verify`.

If any step fails, the finding is a bug in the backup path, not a bad drill.
Fix it before the next deploy.
