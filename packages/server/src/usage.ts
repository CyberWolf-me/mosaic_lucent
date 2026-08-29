/**
 * Usage limits for the AI endpoints (docs/08 SaaS tiers).
 *
 * Two independent guards, both in-memory and framework-free so they run under
 * the Node server, Vite middleware, or a serverless handler:
 *
 *  - a sliding-window rate limit, so one client can't hammer the provider;
 *  - a daily quota, which is what a paid tier actually meters.
 *
 * In-memory means per-process, which is correct for the current single-process
 * deployment and honest about what it is: a shared store (Redis/Postgres) is the
 * swap-in when multiple instances exist, behind this same interface.
 */

export interface UsageLimits {
  /** Requests allowed inside the rolling window. */
  perWindow: number;
  windowMs: number;
  /** Requests allowed per calendar day, UTC. */
  perDay: number;
}

export const DEFAULT_LIMITS: UsageLimits = {
  perWindow: 20,
  windowMs: 60_000,
  perDay: 500,
};

export interface UsageDecision {
  allowed: boolean;
  /** Why it was refused, for the response body. */
  reason?: "rate" | "quota";
  /** Seconds until the caller may retry; drives Retry-After. */
  retryAfterSeconds?: number;
  /** Requests left in the day's quota after this decision. */
  remainingToday: number;
}

export interface UsageSnapshot {
  /** Distinct clients seen since the process started. */
  clients: number;
  /** Requests allowed today, across all clients. */
  allowedToday: number;
  /** Requests refused today, split by cause. */
  refusedToday: { rate: number; quota: number };
}

interface ClientRecord {
  /** Timestamps inside the current rolling window. */
  hits: number[];
  /** UTC day key the daily counter belongs to. */
  day: string;
  dayCount: number;
}

const dayKey = (now: number) => new Date(now).toISOString().slice(0, 10);

/**
 * Tracks usage per client key. The key is caller-supplied — an API key, a
 * session id, or the remote address — so this layer never has to know how
 * identity works.
 */
export class UsageTracker {
  private readonly limits: UsageLimits;
  private readonly clients = new Map<string, ClientRecord>();
  private allowedToday = 0;
  private refusedRate = 0;
  private refusedQuota = 0;
  private statsDay: string;

  constructor(limits: Partial<UsageLimits> = {}, now: number = Date.now()) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.statsDay = dayKey(now);
  }

  /** Record an attempt and say whether it may proceed. */
  check(clientKey: string, now: number = Date.now()): UsageDecision {
    const today = dayKey(now);
    if (today !== this.statsDay) {
      // A new UTC day resets the aggregate counters as well as per-client ones.
      this.statsDay = today;
      this.allowedToday = 0;
      this.refusedRate = 0;
      this.refusedQuota = 0;
    }

    const record = this.clients.get(clientKey) ?? { hits: [], day: today, dayCount: 0 };
    if (record.day !== today) {
      record.day = today;
      record.dayCount = 0;
    }

    // Drop timestamps that have aged out of the window.
    const cutoff = now - this.limits.windowMs;
    record.hits = record.hits.filter((t) => t > cutoff);

    if (record.dayCount >= this.limits.perDay) {
      this.clients.set(clientKey, record);
      this.refusedQuota += 1;
      const midnight = Date.UTC(
        new Date(now).getUTCFullYear(),
        new Date(now).getUTCMonth(),
        new Date(now).getUTCDate() + 1,
      );
      return {
        allowed: false,
        reason: "quota",
        retryAfterSeconds: Math.max(1, Math.ceil((midnight - now) / 1000)),
        remainingToday: 0,
      };
    }

    if (record.hits.length >= this.limits.perWindow) {
      this.clients.set(clientKey, record);
      this.refusedRate += 1;
      const oldest = record.hits[0]!;
      return {
        allowed: false,
        reason: "rate",
        retryAfterSeconds: Math.max(1, Math.ceil((oldest + this.limits.windowMs - now) / 1000)),
        remainingToday: this.limits.perDay - record.dayCount,
      };
    }

    record.hits.push(now);
    record.dayCount += 1;
    this.clients.set(clientKey, record);
    this.allowedToday += 1;
    return { allowed: true, remainingToday: this.limits.perDay - record.dayCount };
  }

  /** Aggregate counters for the /metrics endpoint. */
  snapshot(): UsageSnapshot {
    return {
      clients: this.clients.size,
      allowedToday: this.allowedToday,
      refusedToday: { rate: this.refusedRate, quota: this.refusedQuota },
    };
  }

  /** Drop client records with no recent activity, so memory stays bounded. */
  prune(now: number = Date.now()): void {
    const today = dayKey(now);
    for (const [key, record] of this.clients) {
      const stale = record.hits.every((t) => t <= now - this.limits.windowMs);
      if (stale && record.day !== today) this.clients.delete(key);
    }
  }
}

/** Read limits from the environment so a deployment can tune them. */
export function limitsFromEnv(env: NodeJS.ProcessEnv = process.env): UsageLimits {
  const num = (value: string | undefined, fallback: number) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
  };
  return {
    perWindow: num(env.LUCENT_RATE_PER_MINUTE, DEFAULT_LIMITS.perWindow),
    windowMs: num(env.LUCENT_RATE_WINDOW_MS, DEFAULT_LIMITS.windowMs),
    perDay: num(env.LUCENT_QUOTA_PER_DAY, DEFAULT_LIMITS.perDay),
  };
}
