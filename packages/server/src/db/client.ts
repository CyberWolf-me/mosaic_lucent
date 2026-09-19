import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type ClientConfig } from "pg";
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

export function pgConfigFromUrl(url: string): ClientConfig {
  const isRemote = !url.includes("localhost") && !url.includes("127.0.0.1");
  const hasSslParam = url.includes("sslmode=") || url.includes("ssl=");
  const needsSsl = isRemote || hasSslParam;
  const ssl = needsSsl
    ? { rejectUnauthorized: process.env.LUCENT_DATABASE_SSL_REJECT_UNAUTHORIZED === "true" }
    : undefined;
  return {
    connectionString: url,
    ...(ssl ? { ssl } : {}),
  };
}

export function createDb(url: string): Db {
  const max = process.env.LUCENT_DATABASE_POOL_MAX
    ? Math.max(1, parseInt(process.env.LUCENT_DATABASE_POOL_MAX, 10))
    : 10;
  const pool = new Pool({ ...pgConfigFromUrl(url), max });
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
