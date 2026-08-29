import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, type Db } from "../src/db/client.js";
import { MIGRATION_LOCK_KEY, migrate } from "../src/db/migrate.js";

/**
 * Migration mutual exclusion (docs/06). `migrate` is called on every boot, so
 * two instances migrating at once is the normal case on a rolling deploy and the
 * guaranteed case under a process manager that starts N workers. Before the
 * advisory lock, both read the same ledger, both found the same file pending and
 * both ran it - a duplicate-object error that crash-loops half the fleet, or two
 * partial applications of one multi-statement file.
 *
 * Gated on LUCENT_TEST_DATABASE_URL like the other pg suites, and it takes no
 * TRUNCATE: it only ever reads the ledger and takes/releases one advisory lock,
 * so it is safe to run in parallel with its siblings (they will simply wait for
 * the lock during the one test that holds it, well inside the 60s default).
 */

const URL = process.env.LUCENT_TEST_DATABASE_URL;
const describeIf = URL ? describe : describe.skip;

const LOCK = "SELECT pg_advisory_lock($1)";
const UNLOCK = "SELECT pg_advisory_unlock($1)";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describeIf("migration advisory lock", () => {
  let db: Db;

  beforeAll(async () => {
    if (!URL) return;
    db = createDb(URL);
    // Bring the schema up once here so every assertion below runs against an
    // up-to-date database and can expect `[]` from a further run. That is also
    // the state a second booter finds in production: blocked, then nothing to do.
    await migrate(db);
  });

  afterAll(async () => {
    if (db) await closeDb(db);
  });

  it("refuses, rather than skipping, when another session holds the lock", async () => {
    const holder = await db.pool.connect();
    try {
      await holder.query(LOCK, [MIGRATION_LOCK_KEY]);
      // The bound is a parameter only so this assertion fits in a test timeout;
      // production waits LOCK_WAIT_MS. What matters is the shape of the failure:
      // a throw that names the situation, never a silent return that would let
      // the process serve traffic against an unverified schema.
      await expect(migrate(db, { lockWaitMs: 300 })).rejects.toThrow(
        /another instance is migrating/,
      );
    } finally {
      await holder.query(UNLOCK, [MIGRATION_LOCK_KEY]);
      holder.release();
    }
  });

  it("waits for the holder and then runs, instead of running alongside it", async () => {
    // The property the fix exists for, observed directly: while another session
    // holds the key this call must still be pending, and it must complete once
    // the key is free. A lock taken on a pooled connection and handed straight
    // back - the bug this replaces - would let it finish immediately.
    const holder = await db.pool.connect();
    await holder.query(LOCK, [MIGRATION_LOCK_KEY]);
    let settled = false;
    const run = migrate(db, { lockWaitMs: 10_000 });
    // Both outcomes marked, so a rejection here cannot surface as an unhandled
    // one between the sleep and the await below.
    void run.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      // Several poll intervals (250ms) of the try-lock loop.
      await sleep(600);
      expect(settled).toBe(false);
    } finally {
      await holder.query(UNLOCK, [MIGRATION_LOCK_KEY]);
      holder.release();
    }
    // Nothing to do, because the holder's turn is over and the ledger is full.
    expect(await run).toEqual([]);
  });

  it("releases the lock when the run finishes", async () => {
    await migrate(db);
    // A different session can take the key immediately afterwards. This is the
    // assertion that catches a `finally` that forgot to unlock, and a run that
    // returned a still-locked connection to the pool - Postgres only drops a
    // session-level advisory lock when the session ends, so a leak here would
    // stall every later migration for the pool's lifetime.
    const probe = await db.pool.connect();
    try {
      const { rows } = await probe.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock($1) AS locked",
        [MIGRATION_LOCK_KEY],
      );
      expect(rows[0]?.locked).toBe(true);
    } finally {
      await probe.query(UNLOCK, [MIGRATION_LOCK_KEY]);
      probe.release();
    }
  });

  it("serialises two concurrent runners without either failing", async () => {
    // Two Db handles = two pools = two sessions, which is as close as one process
    // gets to two booting instances. Both must resolve, and no migration id may
    // appear in both lists: each pending file is applied exactly once, by
    // whichever runner won the lock.
    //
    // Honest about its own strength: `beforeAll` has already brought the schema
    // up, so on a migrated database both lists are empty and the disjointness is
    // trivially true. What this still proves is that the lock does not deadlock
    // two concurrent runners and that neither one throws - the crash the
    // unsynchronised version produced on a rolling deploy.
    const a = createDb(URL!);
    const b = createDb(URL!);
    try {
      const [ranA, ranB] = await Promise.all([
        migrate(a, { lockWaitMs: 30_000 }),
        migrate(b, { lockWaitMs: 30_000 }),
      ]);
      expect(ranA.filter((id) => ranB.includes(id))).toEqual([]);
    } finally {
      await closeDb(a);
      await closeDb(b);
    }
  });
});
