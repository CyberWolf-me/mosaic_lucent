import { describe, it, expect } from "vitest";
import { DEFAULT_LIMITS, UsageTracker, limitsFromEnv } from "../src/usage.js";
import { Telemetry } from "../src/telemetry.js";

/**
 * Usage limits and local telemetry. Both are in-memory per process, which is
 * correct for the current single-process deployment; the tests pin the behaviour
 * a shared store would have to reproduce.
 */

const T0 = Date.UTC(2026, 0, 15, 12, 0, 0);

describe("rate limiting", () => {
  it("allows requests up to the window limit", () => {
    const usage = new UsageTracker({ perWindow: 3, windowMs: 1000, perDay: 100 }, T0);
    for (let i = 0; i < 3; i++) {
      expect(usage.check("a", T0 + i).allowed, `request ${i}`).toBe(true);
    }
  });

  it("refuses the request past the limit and says when to retry", () => {
    const usage = new UsageTracker({ perWindow: 2, windowMs: 1000, perDay: 100 }, T0);
    usage.check("a", T0);
    usage.check("a", T0 + 100);
    const decision = usage.check("a", T0 + 200);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("rate");
    expect(decision.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("allows again once the window slides past the old hits", () => {
    const usage = new UsageTracker({ perWindow: 2, windowMs: 1000, perDay: 100 }, T0);
    usage.check("a", T0);
    usage.check("a", T0 + 100);
    expect(usage.check("a", T0 + 200).allowed).toBe(false);
    expect(usage.check("a", T0 + 1200).allowed).toBe(true);
  });

  it("meters each client independently", () => {
    const usage = new UsageTracker({ perWindow: 1, windowMs: 1000, perDay: 100 }, T0);
    expect(usage.check("a", T0).allowed).toBe(true);
    expect(usage.check("a", T0 + 1).allowed).toBe(false);
    // One noisy client must not lock everyone else out.
    expect(usage.check("b", T0 + 1).allowed).toBe(true);
  });
});

describe("daily quota", () => {
  it("refuses once the day's allowance is spent", () => {
    const usage = new UsageTracker({ perWindow: 100, windowMs: 1000, perDay: 2 }, T0);
    expect(usage.check("a", T0).allowed).toBe(true);
    expect(usage.check("a", T0 + 1).allowed).toBe(true);
    const decision = usage.check("a", T0 + 2);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("quota");
    expect(decision.remainingToday).toBe(0);
  });

  it("reports how much of the quota is left", () => {
    const usage = new UsageTracker({ perWindow: 100, windowMs: 1000, perDay: 5 }, T0);
    expect(usage.check("a", T0).remainingToday).toBe(4);
    expect(usage.check("a", T0 + 1).remainingToday).toBe(3);
  });

  it("points at the next UTC midnight when the quota is spent", () => {
    const usage = new UsageTracker({ perWindow: 100, windowMs: 1000, perDay: 1 }, T0);
    usage.check("a", T0);
    const decision = usage.check("a", T0 + 1);
    // T0 is noon, so roughly 12 hours remain.
    expect(decision.retryAfterSeconds).toBeGreaterThan(11 * 3600);
    expect(decision.retryAfterSeconds).toBeLessThanOrEqual(12 * 3600 + 1);
  });

  it("resets on a new UTC day", () => {
    const usage = new UsageTracker({ perWindow: 100, windowMs: 1000, perDay: 1 }, T0);
    usage.check("a", T0);
    expect(usage.check("a", T0 + 1).allowed).toBe(false);
    const nextDay = T0 + 24 * 3600 * 1000;
    expect(usage.check("a", nextDay).allowed).toBe(true);
  });

  it("refuses on quota before the rate limit when both are exceeded", () => {
    const usage = new UsageTracker({ perWindow: 1, windowMs: 1000, perDay: 1 }, T0);
    usage.check("a", T0);
    // The quota is the more informative refusal: retrying in a second won't help.
    expect(usage.check("a", T0 + 1).reason).toBe("quota");
  });
});

describe("usage snapshot and pruning", () => {
  it("counts allowed and refused requests for /metrics", () => {
    const usage = new UsageTracker({ perWindow: 1, windowMs: 1000, perDay: 5 }, T0);
    usage.check("a", T0);
    usage.check("a", T0 + 1); // rate refusal
    const snap = usage.snapshot();
    expect(snap.clients).toBe(1);
    expect(snap.allowedToday).toBe(1);
    expect(snap.refusedToday.rate).toBe(1);
    expect(snap.refusedToday.quota).toBe(0);
  });

  it("drops stale clients so memory stays bounded", () => {
    const usage = new UsageTracker({ perWindow: 5, windowMs: 1000, perDay: 5 }, T0);
    usage.check("old", T0);
    usage.prune(T0 + 48 * 3600 * 1000);
    expect(usage.snapshot().clients).toBe(0);
  });

  it("keeps a client that is still active", () => {
    const usage = new UsageTracker({ perWindow: 5, windowMs: 10_000, perDay: 5 }, T0);
    usage.check("live", T0);
    usage.prune(T0 + 1000);
    expect(usage.snapshot().clients).toBe(1);
  });
});

describe("limitsFromEnv", () => {
  it("falls back to defaults when nothing is set", () => {
    expect(limitsFromEnv({})).toEqual(DEFAULT_LIMITS);
  });

  it("reads overrides from the environment", () => {
    expect(
      limitsFromEnv({
        LUCENT_RATE_PER_MINUTE: "5",
        LUCENT_RATE_WINDOW_MS: "2000",
        LUCENT_QUOTA_PER_DAY: "50",
      }),
    ).toEqual({ perWindow: 5, windowMs: 2000, perDay: 50 });
  });

  it("ignores nonsense values rather than disabling the limit", () => {
    expect(limitsFromEnv({ LUCENT_RATE_PER_MINUTE: "0" }).perWindow).toBe(DEFAULT_LIMITS.perWindow);
    expect(limitsFromEnv({ LUCENT_QUOTA_PER_DAY: "abc" }).perDay).toBe(DEFAULT_LIMITS.perDay);
    expect(limitsFromEnv({ LUCENT_RATE_PER_MINUTE: "-3" }).perWindow).toBe(
      DEFAULT_LIMITS.perWindow,
    );
  });
});

describe("telemetry", () => {
  it("counts requests and totals operations emitted", () => {
    const t = new Telemetry();
    t.record({ kind: "generate", ms: 100, provider: "mock", operations: 3 });
    t.record({ kind: "generate", ms: 200, provider: "mock", operations: 2 });
    t.record({ kind: "image", ms: 50, provider: "mock-image" });
    const snap = t.snapshot();
    expect(snap.requests).toEqual({ generate: 2, image: 1, ask: 0, aiPropose: 0 });
    expect(snap.operationsEmitted).toBe(5);
  });

  it("reports latency percentiles", () => {
    const t = new Telemetry();
    for (const ms of [10, 20, 30, 40, 100]) {
      t.record({ kind: "generate", ms, provider: "mock", operations: 1 });
    }
    const snap = t.snapshot();
    expect(snap.latencyMs.generateMax).toBe(100);
    expect(snap.latencyMs.generateP50).toBeGreaterThan(0);
    expect(snap.latencyMs.generateP95).toBeGreaterThanOrEqual(snap.latencyMs.generateP50);
  });

  it("keeps recent errors, newest first, grouped by status", () => {
    const t = new Telemetry();
    t.record({ kind: "error", route: "/api/generate", status: 502, message: "provider failed" });
    t.record({ kind: "error", route: "/api/generate", status: 422, message: "validation" });
    t.record({
      kind: "error",
      route: "/api/generate",
      status: 502,
      message: "provider failed again",
    });
    const snap = t.snapshot();
    expect(snap.errors.total).toBe(3);
    expect(snap.errors.byStatus["502"]).toBe(2);
    expect(snap.recentErrors[0]?.message).toBe("provider failed again");
  });

  it("truncates a very long error message", () => {
    const t = new Telemetry();
    t.record({ kind: "error", route: "/api/generate", status: 502, message: "x".repeat(5000) });
    expect(t.snapshot().recentErrors[0]?.message.length).toBeLessThanOrEqual(300);
  });

  it("bounds the error buffer", () => {
    const t = new Telemetry();
    for (let i = 0; i < 60; i++) {
      t.record({ kind: "error", route: "/api/generate", status: 500, message: `e${i}` });
    }
    const snap = t.snapshot();
    expect(snap.errors.total).toBe(60);
    expect(snap.recentErrors.length).toBeLessThanOrEqual(20);
  });

  it("counts refusals by cause", () => {
    const t = new Telemetry();
    t.record({ kind: "refused", route: "/api/generate", reason: "rate" });
    t.record({ kind: "refused", route: "/api/generate", reason: "quota" });
    t.record({ kind: "refused", route: "/api/generate", reason: "quota" });
    expect(t.snapshot().refusals).toEqual({ rate: 1, quota: 2, plan: 0 });
  });

  it("counts a plan refusal apart from a quota refusal", () => {
    // A plan ceiling is revenue to collect, a quota is capacity to raise. Folded
    // into one counter the two are indistinguishable, so this is the assertion
    // that keeps the entitlement gate's refusals out of the quota series.
    const t = new Telemetry();
    t.record({ kind: "refused", route: "/api/generate", reason: "plan:ai.generationsPerMonth" });
    t.record({ kind: "refused", route: "/api/boards", reason: "plan:boards" });
    t.record({ kind: "refused", route: "/api/generate", reason: "quota" });
    expect(t.snapshot().refusals).toEqual({ rate: 0, quota: 1, plan: 2 });
  });

  it("keeps a csrf refusal in the quota bucket", () => {
    // The fall-through predates plan gating; narrowing on the `plan:` prefix
    // must not have moved `csrf:*` out from under it.
    const t = new Telemetry();
    t.record({ kind: "refused", route: "/api/boards", reason: "csrf:missing" });
    expect(t.snapshot().refusals).toEqual({ rate: 0, quota: 1, plan: 0 });
  });

  it("forwards events to an optional external sink", () => {
    const seen: string[] = [];
    const t = new Telemetry((e) => seen.push(e.kind));
    t.record({ kind: "generate", ms: 1, provider: "mock", operations: 0 });
    t.record({ kind: "refused", route: "/x", reason: "rate" });
    expect(seen).toEqual(["generate", "refused"]);
  });

  it("starts empty", () => {
    const snap = new Telemetry().snapshot();
    expect(snap.requests).toEqual({ generate: 0, image: 0, ask: 0, aiPropose: 0 });
    expect(snap.errors.total).toBe(0);
    expect(snap.recentErrors).toEqual([]);
  });
});
