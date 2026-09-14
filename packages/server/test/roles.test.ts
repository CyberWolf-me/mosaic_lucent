import { describe, expect, it } from "vitest";
import {
  enqueueRecurring,
  familiesFor,
  parseRole,
  RECURRING_JOBS,
  runsJobs,
  runsScheduler,
  servesHttp,
  workerId,
  type RecurringJob,
} from "../src/roles.js";
import { InMemoryJobQueue } from "../src/jobs.js";

/**
 * P3 (docs/20 P3, advisory §8/§9) — the roles and the recurring schedule.
 *
 * The point of the role split is that "exactly one instance runs this sweep"
 * becomes a property of the queue's claim, not of how many processes happen
 * to be running. These tests pin the two halves of that: the role matrix
 * (which process does what) and the recurring enqueue (N schedulers, one
 * job).
 */

describe("parseRole", () => {
  it("defaults to `all` and accepts every known role", () => {
    expect(parseRole(undefined)).toBe("all");
    expect(parseRole("")).toBe("all");
    expect(parseRole("api")).toBe("api");
    expect(parseRole("worker")).toBe("worker");
    expect(parseRole("scheduler")).toBe("scheduler");
    expect(parseRole("all")).toBe("all");
  });

  it("normalises case and whitespace", () => {
    expect(parseRole("  WORKER  ")).toBe("worker");
  });

  it("THROWS on an unknown role rather than silently becoming `all`", () => {
    // The defect this phase exists to remove is N replicas running N sweeps.
    // A typo'd role must not reproduce it silently.
    expect(() => parseRole("wroker")).toThrow(/not a known role/);
  });
});

describe("the role matrix", () => {
  it("only `all` and `api` serve HTTP", () => {
    expect(servesHttp("all")).toBe(true);
    expect(servesHttp("api")).toBe(true);
    expect(servesHttp("worker")).toBe(false);
    expect(servesHttp("scheduler")).toBe(false);
  });

  it("only `all` and `worker` claim jobs", () => {
    expect(runsJobs("all")).toBe(true);
    expect(runsJobs("worker")).toBe(true);
    expect(runsJobs("api")).toBe(false);
    expect(runsJobs("scheduler")).toBe(false);
  });

  it("only `all` and `scheduler` enqueue the recurring jobs", () => {
    expect(runsScheduler("all")).toBe(true);
    expect(runsScheduler("scheduler")).toBe(true);
    expect(runsScheduler("api")).toBe(false);
    expect(runsScheduler("worker")).toBe(false);
  });
});

describe("the recurring schedule", () => {
  it("mirrors the intervals the setInterval sweeps used", () => {
    const byKey = Object.fromEntries(RECURRING_JOBS.map((j) => [j.key, j]));
    // The three 5-minute sweeps and the 10-minute prune arms.
    expect(byKey["sweep-stripe"]!.everyMs).toBe(5 * 60_000);
    expect(byKey["sweep-execution"]!.everyMs).toBe(5 * 60_000);
    expect(byKey["sweep-webhooks"]!.everyMs).toBe(5 * 60_000);
    expect(byKey["prune-jobs"]!.everyMs).toBe(10 * 60_000);
  });

  it("every entry has a dedupe key, so N schedulers cannot pile up work", () => {
    for (const job of RECURRING_JOBS) {
      expect(job.key).toBeTruthy();
      expect(job.key).toBe(job.type);
    }
  });

  it("N scheduler ticks enqueue ONE job per key", async () => {
    // Three schedulers all fire at once. The dedupe key is what makes this
    // one job rather than three — and it is enforced by the database's
    // partial unique index, so it holds across processes too.
    const queue = new InMemoryJobQueue();
    await Promise.all([
      enqueueRecurring(queue),
      enqueueRecurring(queue),
      enqueueRecurring(queue),
    ]);
    const depth = await queue.depth();
    const total = Object.values(depth).reduce((a, b) => a + b, 0);
    expect(total).toBe(RECURRING_JOBS.length);
  });

  it("a still-queued sweep means the next tick is a no-op (self-throttling)", async () => {
    // A worker that cannot keep up does not accumulate a backlog of sweeps:
    // the previous one is still queued, so the next enqueue loses the key.
    const queue = new InMemoryJobQueue();
    await enqueueRecurring(queue);
    const before = await queue.depth();
    await enqueueRecurring(queue);
    expect(await queue.depth()).toEqual(before);
  });

  it("a finished sweep may be enqueued again on the next tick", async () => {
    const queue = new InMemoryJobQueue();
    await enqueueRecurring(queue);
    const claimed = await queue.claim(["integration", "maintenance"], "w1", 10);
    for (const job of claimed) await queue.complete(job.id);
    // Now the keys are free again: the recurring work really recurs.
    await enqueueRecurring(queue);
    const depth = await queue.depth();
    expect(Object.values(depth).reduce((a, b) => a + b, 0)).toBe(RECURRING_JOBS.length);
  });

  it("honours a custom schedule", async () => {
    const queue = new InMemoryJobQueue();
    const schedule: RecurringJob[] = [
      { key: "custom", family: "media", type: "custom", everyMs: 1_000 },
    ];
    const ids = await enqueueRecurring(queue, schedule);
    expect(ids).toHaveLength(1);
    expect((await queue.depth()).media).toBe(1);
  });
});

describe("worker identity and families", () => {
  it("mints distinct ids per process, so two workers on one host differ", () => {
    const a = workerId();
    const b = workerId();
    expect(a).not.toBe(b);
    // Readable in `claimed_by`: "which worker is holding this?".
    expect(a.startsWith("worker-")).toBe(true);
  });

  it("a worker honours LUCENT_JOB_FAMILIES; a misconfigured one serves all", () => {
    expect(familiesFor("worker", "ai,media")).toEqual(["ai", "media"]);
    // Unknown family names are dropped; an all-invalid list falls back to all.
    expect(familiesFor("worker", "nonsense")).toBeUndefined();
    expect(familiesFor("worker", undefined)).toBeUndefined();
    // Only `worker` has a family restriction: `all` always serves everything.
    expect(familiesFor("all", "ai")).toBeUndefined();
  });
});
