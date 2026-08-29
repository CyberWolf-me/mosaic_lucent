import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import type { PoolClient } from "pg";
import { createDb, type Db } from "./client.js";

/**
 * Idempotent migration runner (docs/06). Reads the SQL files emitted by
 * drizzle-kit in commit order, tracks which have run in a `_lucent_migrations`
 * table, and runs the missing ones inside a single transaction.
 *
 * Why hand-rolled rather than `drizzle-orm/node-postgres/migrator`:
 *   - we want to ship the generated SQL to disk with `drizzle-kit generate`,
 *     and the runtime shouldn't need a build step to find it.
 *   - we want a single, opinionated runner that fails loud and writes nothing
 *     partial if any statement errors.
 *
 * Mutual exclusion: main.ts runs this on every boot, so "two processes migrate
 * at once" is not an edge case. It is what a rolling deploy does (old instance
 * still serving, new one booting) and it is guaranteed under any process
 * manager that starts N workers from one image. Unsynchronised, both read the
 * same ledger, both conclude the same file is pending, and both run it: the
 * lucky outcome is `relation already exists` crash-looping half the fleet on
 * boot, the unlucky one is two interleaved partial applications of a
 * multi-statement file, which no ledger row then describes. So the entire run
 * - ledger creation, ledger read and every pending file - happens under one
 * session-level Postgres advisory lock. The second booter blocks, then reads a
 * ledger that already lists everything and does nothing.
 */

const here = dirname(fileURLToPath(import.meta.url));
/** `src/db` → repo-root `packages/server` → `migrations/` (sibling of `src/`). */
const migrationsDir = join(here, "..", "..", "migrations");

/**
 * Advisory-lock key for the migration run: `0x4c434d47`, the big-endian reading
 * of the ASCII bytes `LCMG` ("LuCent MiGrations"), 1279479111 in decimal. Both
 * spellings are recorded so the derivation is checkable by eye and so
 * `select * from pg_locks where locktype = 'advisory' and objid = 1279479111`
 * during an incident matches something greppable in the source.
 *
 * The key is a hard-coded constant, deliberately not derived from anything
 * observable at runtime. Advisory locks are a single flat 64-bit keyspace per
 * database with no registry, so two sessions exclude each other only when they
 * compute the *same* integer - and every runtime input that looks like it would
 * make a "better", more specific key can differ between two instances of one
 * deployment: the connection URL (the same database reached by a different host
 * alias, or an env var with a trailing slash), a hash of the migrations
 * directory (the instance still running the previous image has a different set,
 * which is precisely when this lock matters most), the schema name, the pod id.
 * Any of those produces two keys, two locks that never contend, and the same
 * race as before - except it now looks synchronised. A literal cannot drift.
 *
 * Exported so tests and operators can hold or inspect the same lock. It is the
 * only advisory lock the server takes, so nothing else can collide with it.
 */
export const MIGRATION_LOCK_KEY = 0x4c434d47;

/**
 * How long to wait for another instance's run before refusing to continue.
 *
 * Bounded rather than a blocking `pg_advisory_lock`: an unbounded wait on a lock
 * held by a wedged session (or by a run that is itself stuck) hangs boot with no
 * output for as long as the orchestrator tolerates it, and a hung boot is the
 * one failure a health check cannot tell apart from a slow one. 60s comfortably
 * covers this schema's migrations, which are DDL on small tables; on timeout we
 * throw and main.ts exits non-zero, so the process manager retries - the correct
 * loop for "someone else is mid-run", because the retry finds the work done. A
 * migration expected to take longer belongs in
 * `npm -w @lucent/server run db:migrate` ahead of the deploy; that path takes
 * this same lock, so booting instances still cannot overlap it.
 */
const LOCK_WAIT_MS = 60_000;
/** Poll interval for the try-lock loop; one boolean per attempt. */
const LOCK_POLL_MS = 250;

export interface MigrateOptions {
  /**
   * Override the lock wait. Exists for the tests, which have to observe the
   * "another instance is migrating" path inside a test timeout rather than
   * spending a real minute in it.
   */
  lockWaitMs?: number;
}

interface MigrationFile {
  id: string;
  sql: string;
}

async function loadMigrations(): Promise<MigrationFile[]> {
  let names: string[];
  try {
    names = (await readdir(migrationsDir)).filter((n) => n.endsWith(".sql")).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `no migrations directory at ${migrationsDir}; run \`drizzle-kit generate\` first`,
      );
    }
    throw err;
  }
  const out: MigrationFile[] = [];
  for (const name of names) {
    // Files look like `0000_init.sql`; the id is the leading digits.
    const id = name.split("_")[0]!;
    const sql = await readFile(join(migrationsDir, name), "utf8");
    out.push({ id, sql });
  }
  return out;
}

async function ensureMigrationsTable(conn: PoolClient): Promise<void> {
  // Deliberately NOT drizzle's own ledger, which is `__drizzle_migrations` in a
  // `drizzle` schema with `(id serial, hash text, created_at bigint)`. The two
  // runners are therefore not interchangeable: point `drizzle-kit migrate` at a
  // database this runner has already migrated and it finds an empty ledger and
  // replays 0000 onward. That fails on the first CREATE TABLE rather than
  // corrupting data, but the only supported path is
  // `npm -w @lucent/server run db:migrate`.
  //
  // IF NOT EXISTS is not itself concurrency-safe: two sessions running this
  // statement in the same instant can trip a unique violation on the system
  // catalogue instead of one of them no-opping. The advisory lock is taken
  // before this runs, which is why that cannot happen here.
  await conn.query(`
    CREATE TABLE IF NOT EXISTS _lucent_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function appliedIds(conn: PoolClient): Promise<Set<string>> {
  const { rows } = await conn.query<{ id: string }>(
    `SELECT id FROM _lucent_migrations ORDER BY id ASC`,
  );
  return new Set(rows.map((r) => r.id));
}

/**
 * Take the migration lock on `conn`, polling until `waitMs` has elapsed.
 *
 * `pg_try_advisory_lock` in a loop rather than the blocking `pg_advisory_lock`
 * because the blocking form offers no bound and no place to say what we are
 * waiting for; see LOCK_WAIT_MS. Failing loud is the point: skipping the
 * migrations and starting anyway would leave the process serving traffic against
 * a schema nothing verified, which shows up later as arbitrary SQL errors on
 * user requests instead of one refusal at boot.
 */
async function acquireMigrationLock(conn: PoolClient, waitMs: number): Promise<void> {
  const deadline = Date.now() + waitMs;
  let announced = false;
  for (;;) {
    const { rows } = await conn.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock($1) AS locked`,
      [MIGRATION_LOCK_KEY],
    );
    if (rows[0]?.locked === true) {
      if (announced) console.log("[lucent] migration lock acquired");
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `another instance is migrating: could not acquire the migration advisory lock ` +
          `(${MIGRATION_LOCK_KEY}) within ${waitMs}ms. Retry once that run finishes; if ` +
          `nothing is running, an abandoned session still holds it (see pg_locks where ` +
          `locktype = 'advisory').`,
      );
    }
    if (!announced) {
      announced = true;
      console.log("[lucent] another instance is migrating; waiting for the migration lock");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, LOCK_POLL_MS));
  }
}

/**
 * Release the lock. Answers false when the release did not visibly land, in
 * which case the session must not go back into the pool: Postgres drops a
 * session-level advisory lock only when the session ends, so a pooled connection
 * still holding it would block every later run for the pool's lifetime.
 *
 * Never throws. It runs from a `finally`, and a throw there would replace a real
 * migration failure with a plumbing one - the migration error is the one the
 * operator needs. The unlock can legitimately fail: if a migration threw and its
 * ROLLBACK also failed, this connection sits in an aborted transaction and
 * rejects every statement.
 */
async function releaseMigrationLock(conn: PoolClient): Promise<boolean> {
  try {
    const { rows } = await conn.query<{ released: boolean }>(
      `SELECT pg_advisory_unlock($1) AS released`,
      [MIGRATION_LOCK_KEY],
    );
    if (rows[0]?.released === true) return true;
    // false means "this session did not hold that lock", which is a bug here
    // rather than an operational state, so it gets said out loud.
    console.error(`[lucent] migration lock ${MIGRATION_LOCK_KEY} was not held at release`);
    return false;
  } catch (err) {
    console.error("[lucent] failed to release the migration lock:", (err as Error).message);
    return false;
  }
}

/** Apply the pending files on the already-locked connection. */
async function applyPending(conn: PoolClient): Promise<string[]> {
  await ensureMigrationsTable(conn);
  const have = await appliedIds(conn);
  const all = await loadMigrations();
  const pending = all.filter((m) => !have.has(m.id));
  if (pending.length === 0) return [];

  // Drizzle splits multi-statement SQL with `--> statement-breakpoint`. Honour
  // those so CREATE TABLE ... ; CREATE INDEX ... ; etc. run as separate calls.
  for (const m of pending) {
    const statements = m.sql
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    try {
      await conn.query("BEGIN");
      for (const stmt of statements) {
        await conn.query(stmt);
      }
      await conn.query("INSERT INTO _lucent_migrations (id) VALUES ($1)", [m.id]);
      await conn.query("COMMIT");
    } catch (err) {
      // A failed ROLLBACK must not mask the statement that actually broke; the
      // release path below copes with the aborted session it leaves behind.
      await conn.query("ROLLBACK").catch(() => {});
      throw new Error(`migration ${m.id} failed: ${(err as Error).message}`);
    }
  }
  return pending.map((m) => m.id);
}

/** Apply any missing migrations and return the ids that ran. */
export async function migrate(target: Db, options: MigrateOptions = {}): Promise<string[]> {
  const waitMs = options.lockWaitMs ?? LOCK_WAIT_MS;
  // One connection, checked out of the pool and pinned for the whole run. Two
  // independent reasons it has to be the same connection:
  //
  //   - Advisory locks are *session* scoped, and `pool.query()` picks whichever
  //     connection is idle and hands it straight back. A lock taken that way is
  //     either released the instant the next caller checks that connection out,
  //     or stranded on a session this function never speaks to again. Either
  //     way `pg_try_advisory_lock` answered true and nothing is excluded, which
  //     is worse than no lock at all: the race stays and the safeguard hides it.
  //   - The lock has to outlive the individual transactions. Each pending file
  //     commits separately (that is what makes an interrupted run resumable), so
  //     `pg_advisory_xact_lock` would be released by the first COMMIT and the
  //     rest of the set would race. A session lock spans them all, and survives
  //     the ROLLBACK on the failure path too.
  const conn = await target.pool.connect();
  let stillLocked = false;
  try {
    await acquireMigrationLock(conn, waitMs);
    try {
      return await applyPending(conn);
    } finally {
      // In a `finally` so a thrown migration cannot strand the lock: the next
      // deploy would otherwise wait out LOCK_WAIT_MS and fail with a misleading
      // "another instance is migrating" when the real fault was this run.
      stillLocked = !(await releaseMigrationLock(conn));
    }
  } finally {
    // A truthy argument destroys the connection instead of returning it to the
    // pool - the only way to drop a session lock we could not unlock.
    conn.release(stillLocked);
  }
}

/**
 * Standalone CLI: `npm -w @lucent/server run db:migrate`. Reads
 * LUCENT_DATABASE_URL, applies any missing migrations, exits 0.
 */
async function main(): Promise<void> {
  const url = process.env.LUCENT_DATABASE_URL;
  if (!url) {
    console.error("LUCENT_DATABASE_URL is required");
    process.exit(2);
  }
  const target = createDb(url);
  try {
    const ran = await migrate(target);
    if (ran.length === 0) {
      console.log("[lucent] database is up to date");
    } else {
      console.log(`[lucent] applied ${ran.length} migration(s): ${ran.join(", ")}`);
    }
  } finally {
    await target.pool.end();
  }
}

// `file://${argv[1]}` can never match on Windows - import.meta.url is
// `file:///D:/lucent/...` while argv[1] is `D:lucent...` - so `npm run
// db:migrate` did nothing and exited 0, which for a migration command is worse
// than failing. pathToFileURL handles the drive letter, the separators and the
// characters a path has to escape.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
