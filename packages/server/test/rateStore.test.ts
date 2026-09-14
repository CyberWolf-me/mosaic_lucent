import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, type Db } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { rateCounters } from "../src/db/schema.js";
import { PostgresDailyQuota, PostgresRateLimiter } from "../src/rateStore.js";

/**
 * P5 (docs/20, advisory §12/§26) — shared rate limiting.
 *
 * The acceptance docs/20 fixes: "a second instance never grants
 * 2 × perWindow". These tests are written as two INSTANCES sharing one
 * database, because that is the failure the in-process Maps have: each
 * counter is separate, so the limit doubles.
 */

const TEST_URL = process.env.LUCENT_TEST_DATABASE_URL;

describe.skipIf(!TEST_URL)("PostgresRateLimiter", () => {
  let target: Db;

  beforeAll(async () => {
    target = createDb(TEST_URL!);
    await migrate(target);
    await target.db.delete(rateCounters);
  });

  afterAll(async () => {
    await target.db.delete(rateCounters);
    await closeDb(target);
  });

  async function reset(): Promise<void> {
    await target.db.delete(rateCounters);
  }

  it("allows up to the limit, then refuses with a retry-after", async () => {
    await reset();
    const limiter = new PostgresRateLimiter(target, { perWindow: 3, windowMs: 60_000 });
    const now = Date.now();
    expect((await limiter.check("k1", now)).allowed).toBe(true);
    expect((await limiter.check("k1", now)).allowed).toBe(true);
    expect((await limiter.check("k1", now)).allowed).toBe(true);
    const refused = await limiter.check("k1", now);
    expect(refused.allowed).toBe(false);
    expect(refused.remaining).toBe(0);
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("THE ACCEPTANCE: two instances share one limit, not two", async () => {
    // The whole point. Two separate limiter objects — as two API processes
    // would have — counting against the same store.
    await reset();
    const instanceA = new PostgresRateLimiter(target, { perWindow: 4, windowMs: 60_000 });
    const instanceB = new PostgresRateLimiter(target, { perWindow: 4, windowMs: 60_000 });
    const now = Date.now();

    // Alternate between the instances, exactly as a load balancer would.
    const decisions = [];
    for (let i = 0; i < 6; i += 1) {
      const limiter = i % 2 === 0 ? instanceA : instanceB;
      decisions.push((await limiter.check("shared", now)).allowed);
    }
    // Four allowed, two refused — NOT six allowed (2 × 4 would have been 8).
    expect(decisions.filter(Boolean)).toHaveLength(4);
    expect(decisions.slice(4)).toEqual([false, false]);
  });

  it("a CONCURRENT burst cannot both see 'under the limit'", async () => {
    // The race the one-statement upsert closes. Ten parallel checks against
    // a limit of 3 must allow exactly 3.
    await reset();
    const limiter = new PostgresRateLimiter(target, { perWindow: 3, windowMs: 60_000 });
    const now = Date.now();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => limiter.check("burst", now)),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(3);
  });

  it("keys are independent", async () => {
    await reset();
    const limiter = new PostgresRateLimiter(target, { perWindow: 1, windowMs: 60_000 });
    const now = Date.now();
    expect((await limiter.check("alice", now)).allowed).toBe(true);
    expect((await limiter.check("alice", now)).allowed).toBe(false);
    // Bob is unaffected by Alice's limit.
    expect((await limiter.check("bob", now)).allowed).toBe(true);
  });

  it("a new window resets the count", async () => {
    await reset();
    const limiter = new PostgresRateLimiter(target, { perWindow: 1, windowMs: 60_000 });
    const now = Date.now();
    expect((await limiter.check("win", now)).allowed).toBe(true);
    expect((await limiter.check("win", now)).allowed).toBe(false);
    // One window later: the key has a fresh counter.
    expect((await limiter.check("win", now + 60_000)).allowed).toBe(true);
  });

  it("prune drops rolled-past windows and leaves live ones", async () => {
    await reset();
    const limiter = new PostgresRateLimiter(target, { perWindow: 5, windowMs: 60_000 });
    const now = Date.now();
    await limiter.check("old", now - 5 * 60_000);
    await limiter.check("live", now);
    const removed = await limiter.prune(now);
    expect(removed).toBe(1);
    expect(await limiter.size(now)).toBe(1);
  });
});

describe.skipIf(!TEST_URL)("PostgresDailyQuota", () => {
  let target: Db;

  beforeAll(async () => {
    target = createDb(TEST_URL!);
    await migrate(target);
    await target.db.delete(rateCounters);
  });

  afterAll(async () => {
    await target.db.delete(rateCounters);
    await closeDb(target);
  });

  it("counts the day's usage and refuses past the ceiling", async () => {
    await target.db.delete(rateCounters);
    const quota = new PostgresDailyQuota(target, 3);
    const now = Date.now();
    expect((await quota.check("q1", now)).allowed).toBe(true);
    expect((await quota.check("q1", now)).allowed).toBe(true);
    // The third consumes the last of the three, so it reports 0 remaining.
    const third = await quota.check("q1", now);
    expect(third.allowed).toBe(true);
    expect(third.remainingToday).toBe(0);
    const refused = await quota.check("q1", now);
    expect(refused.allowed).toBe(false);
    expect(refused.reason).toBe("quota");
    // The retry is at midnight, so it is a real number of seconds.
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("the day's quota is shared across instances too", async () => {
    await target.db.delete(rateCounters);
    const a = new PostgresDailyQuota(target, 2);
    const b = new PostgresDailyQuota(target, 2);
    const now = Date.now();
    expect((await a.check("shared-day", now)).allowed).toBe(true);
    expect((await b.check("shared-day", now)).allowed).toBe(true);
    // The third request, whichever instance takes it, is over.
    expect((await a.check("shared-day", now)).allowed).toBe(false);
  });

  it("resets on the next UTC day", async () => {
    await target.db.delete(rateCounters);
    const quota = new PostgresDailyQuota(target, 1);
    const now = Date.now();
    expect((await quota.check("q2", now)).allowed).toBe(true);
    expect((await quota.check("q2", now)).allowed).toBe(false);
    // 24 hours later is a different window key entirely.
    expect((await quota.check("q2", now + 24 * 60 * 60 * 1000)).allowed).toBe(true);
  });
});
