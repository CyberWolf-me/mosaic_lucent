/**
 * Per-key sliding-window limiter.
 *
 * Separate from `UsageTracker` because (a) the auth limiter is keyed on
 * `ip+email`, not just identity, so brute-force attempts without a valid
 * email still count, and (b) the bucket needs to outlive the request and be
 * queryable, not be per-process metering that resets on restart.
 *
 * In-memory is correct for a single-instance deployment (docs/06). A
 * shared store (Redis) is the swap-in when multiple instances exist,
 * behind the same interface.
 */

export interface LimiterDecision {
  allowed: boolean;
  /** Seconds until the caller may retry; drives Retry-After. */
  retryAfterSeconds: number;
  /** Remaining attempts in the current window. */
  remaining: number;
}

interface Bucket {
  hits: number[];
}

export class Limiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly perWindow: number,
    private readonly windowMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Test/setter: wipe state. */
  reset(): void {
    this.buckets.clear();
  }

  /** Record an attempt; allowed returns the decision. */
  check(key: string): LimiterDecision {
    const now = this.now();
    const cutoff = now - this.windowMs;
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { hits: [] };
      this.buckets.set(key, bucket);
    }
    bucket.hits = bucket.hits.filter((t) => t > cutoff);
    if (bucket.hits.length >= this.perWindow) {
      const oldest = bucket.hits[0]!;
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000)),
        remaining: 0,
      };
    }
    bucket.hits.push(now);
    return { allowed: true, retryAfterSeconds: 0, remaining: this.perWindow - bucket.hits.length };
  }

  /** Drop empty buckets so memory stays bounded on a long-running process. */
  prune(now: number = this.now()): number {
    const cutoff = now - this.windowMs;
    let removed = 0;
    for (const [key, bucket] of this.buckets) {
      const fresh = bucket.hits.some((t) => t > cutoff);
      if (!fresh) {
        this.buckets.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /** Total tracked buckets; useful for tests and /metrics. */
  size(): number {
    return this.buckets.size;
  }
}
