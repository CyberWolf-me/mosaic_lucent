import { and, eq, lte, sql } from "drizzle-orm";
import type { Db } from "./db/client.js";
import { rateCounters } from "./db/schema.js";
import type { LimiterDecision } from "./limiter.js";
import type { UsageDecision, UsageLimits } from "./usage.js";

/**
 * Postgres-backed rate limiting (docs/20 P5, advisory §12/§26).
 *
 * THE GAP. `Limiter` and `UsageTracker` are per-process Maps. Behind two API
 * instances that means 2× the configured limit — the auth limiter too, which
 * is the brute-force guard. docs/20: "a second instance never grants
 * 2 × perWindow".
 *
 * WHY FIXED-WINDOW SQL RATHER THAN A SLIDING LOG. The in-memory classes keep
 * a list of timestamps because memory is free and the list is exact. In
 * Postgres the same shape would mean one row per request, and a sweep to
 * delete them — an unindexed, forever-growing table on the hottest path in
 * the system. A fixed window is one row per (key, window) and one atomic
 * upsert, which is the right trade for a limiter: the difference between a
 * sliding and a fixed window is a burst allowance at a boundary, and the
 * alternative is a table that grows with traffic.
 *
 * THE COUNTER IS INCREMENTED AND READ IN ONE STATEMENT. `insert ... on
 * conflict do update ... returning` is atomic, so two instances racing the
 * same key cannot both see "under the limit" — the same one-statement
 * discipline the op-log allocator uses. Doing SELECT-then-INSERT here would
 * reintroduce exactly the race this exists to close.
 *
 * Redis stays out: ADR 0004's stance holds until a measured need, and
 * docs/20 §12 says the same.
 */

/** A fixed window's identity: the key plus which window it belongs to. */
function windowStart(now: number, windowMs: number): number {
  return Math.floor(now / windowMs) * windowMs;
}

export interface PgRateLimiterOptions {
  perWindow: number;
  windowMs: number;
}

/**
 * Drop-in for `Limiter`'s decision shape, backed by Postgres.
 *
 * Async, unlike the in-memory class: a shared counter has to be read. The
 * call sites are already inside `async` handlers (they await auth and body
 * parsing before rate limiting), so this is a signature change at the
 * boundary and not a restructure of the route.
 */
export class PostgresRateLimiter {
  constructor(
    private readonly db: Db,
    private readonly options: PgRateLimiterOptions,
  ) {}

  async check(key: string, now: number = Date.now()): Promise<LimiterDecision> {
    const start = windowStart(now, this.options.windowMs);
    // One statement: increment if present, insert otherwise, and return the
    // post-increment count. Two instances cannot both read "before".
    const rows = await this.db.db
      .insert(rateCounters)
      .values({ key, windowStart: start, hits: 1 })
      .onConflictDoUpdate({
        target: [rateCounters.key, rateCounters.windowStart],
        set: { hits: sql`${rateCounters.hits} + 1` },
      })
      .returning({ hits: rateCounters.hits });

    const hits = rows[0]?.hits ?? 1;
    if (hits > this.options.perWindow) {
      // Over the limit. `retryAfter` is until the window rolls, which is the
      // honest answer for a fixed window: the earliest a retry can succeed.
      const resetsAt = start + this.options.windowMs;
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((resetsAt - now) / 1000)),
        remaining: 0,
      };
    }
    return { allowed: true, retryAfterSeconds: 0, remaining: this.options.perWindow - hits };
  }

  /** Retention: drop windows that have rolled past. */
  async prune(now: number = Date.now()): Promise<number> {
    const cutoff = windowStart(now, this.options.windowMs) - this.options.windowMs;
    const removed = await this.db.db
      .delete(rateCounters)
      .where(lte(rateCounters.windowStart, cutoff))
      .returning({ key: rateCounters.key });
    return removed.length;
  }

  /** Distinct keys with a live window; for tests and /metrics. */
  async size(now: number = Date.now()): Promise<number> {
    const start = windowStart(now, this.options.windowMs);
    const rows = await this.db.db
      .select({ key: rateCounters.key })
      .from(rateCounters)
      .where(eq(rateCounters.windowStart, start));
    return rows.length;
  }
}

/**
 * The daily-quota half: one row per (key, UTC day).
 *
 * Separate from the per-window counter because the two answer different
 * questions and have different lifetimes — a minute window is disposable, a
 * day's quota is the thing a paid tier actually meters, and collapsing them
 * would mean either losing the day's count on every window roll or keeping
 * every window for a day.
 */
export class PostgresDailyQuota {
  constructor(
    private readonly db: Db,
    private readonly perDay: number,
  ) {}

  async check(clientKey: string, now: number = Date.now()): Promise<UsageDecision> {
    const day = new Date(now).toISOString().slice(0, 10);
    const rows = await this.db.db
      .insert(rateCounters)
      .values({ key: `day:${clientKey}`, windowStart: Date.parse(`${day}T00:00:00.000Z`), hits: 1 })
      .onConflictDoUpdate({
        target: [rateCounters.key, rateCounters.windowStart],
        set: { hits: sql`${rateCounters.hits} + 1` },
      })
      .returning({ hits: rateCounters.hits });

    const hits = rows[0]?.hits ?? 1;
    if (hits > this.perDay) {
      const midnight = Date.parse(`${day}T00:00:00.000Z`) + 24 * 60 * 60 * 1000;
      return {
        allowed: false,
        reason: "quota",
        retryAfterSeconds: Math.max(1, Math.ceil((midnight - now) / 1000)),
        remainingToday: 0,
      };
    }
    return { allowed: true, remainingToday: this.perDay - hits };
  }

  async reset(clientKey: string, now: number = Date.now()): Promise<void> {
    const day = new Date(now).toISOString().slice(0, 10);
    await this.db.db
      .delete(rateCounters)
      .where(
        and(
          eq(rateCounters.key, `day:${clientKey}`),
          eq(rateCounters.windowStart, Date.parse(`${day}T00:00:00.000Z`)),
        ),
      );
  }
}

/** Read the shared-window limits from the environment (same names as local). */
export function sharedLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): UsageLimits {
  const num = (value: string | undefined, fallback: number) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
  };
  return {
    perWindow: num(env.LUCENT_RATE_PER_MINUTE, 20),
    windowMs: num(env.LUCENT_RATE_WINDOW_MS, 60_000),
    perDay: num(env.LUCENT_QUOTA_PER_DAY, 500),
  };
}
