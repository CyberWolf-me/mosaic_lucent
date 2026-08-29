import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";

/**
 * Postgres client wrapper. `createDb(url)` returns a Drizzle handle plus the
 * underlying Pool, so the caller can `await pool.end()` on shutdown.
 *
 * The Pool is intentionally not closed here — it lives for the lifetime of the
 * process. `db:close` is the explicit teardown for tests and graceful
 * shutdown paths.
 */
export interface Db {
  /** Drizzle handle, scoped to this process's schema. */
  db: ReturnType<typeof drizzle<typeof schema>>;
  /** Underlying pg Pool, exposed for health checks and `end()`. */
  pool: Pool;
  /** The URL the Pool was opened with; surfaced for error messages. */
  url: string;
}

export function createDb(url: string): Db {
  const pool = new Pool({ connectionString: url, max: 10 });
  // Surface a connection failure at boot rather than at first query.
  pool.on("error", (err) => {
    console.error("[lucent] postgres pool error:", err);
  });
  const db = drizzle(pool, { schema });
  return { db, pool, url };
}

export async function closeDb(target: Db): Promise<void> {
  await target.pool.end();
}
