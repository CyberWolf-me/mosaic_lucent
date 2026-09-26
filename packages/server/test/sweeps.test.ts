import { describe, expect, it } from "vitest";
import { buildSweepHandlers, type SweepContext } from "../src/sweeps.js";
import type { Job } from "../src/jobs.js";

/**
 * P3 (docs/20 P3, advisory §9) — the sweep handlers.
 *
 * These bodies moved out of `main.ts`'s `setInterval` arms. The properties
 * worth pinning are the ones the move was supposed to buy:
 *
 *   - an unconfigured deployment's sweep is a NO-OP, not a permanent failure
 *     (otherwise the queue accumulates work that can never succeed);
 *   - each handler drives exactly the collaborators it names — the timers
 *     were coupled by sharing a closure, and that coupling is now explicit;
 *   - a handler that throws propagates to the runner, so the job is retried
 *     rather than silently lost.
 */

const JOB = {
  id: "j1",
  family: "integration",
  type: "x",
  payload: {},
  status: "claimed",
  attempts: 1,
  runAfter: 0,
  createdAt: 0,
} as Job;

function context(overrides: Partial<SweepContext> = {}): SweepContext & { calls: string[] } {
  const calls: string[] = [];
  const ctx = {
    calls,
    logger: {
      info: (event: string) => void calls.push(`log:${event}`),
      error: (event: string) => void calls.push(`err:${event}`),
    },
    ...overrides,
  } as SweepContext & { calls: string[] };
  return ctx;
}

describe("buildSweepHandlers", () => {
  it("registers a handler for every recurring job type", () => {
    const handlers = buildSweepHandlers(context());
    for (const type of [
      "sweep-stripe",
      "sweep-execution",
      "sweep-webhooks",
      "sweep-retention",
      "sweep-idle-captures",
      "prune-jobs",
      "prune-outbox",
      "prune-usage",
    ]) {
      expect(typeof handlers[type]).toBe("function");
    }
  });

  it("an UNCONFIGURED sweep completes as a no-op rather than failing", async () => {
    // With no billing configured the stripe sweep is not work that failed —
    // it is work that does not exist. Leaving it pending would make the
    // queue depth read as a backlog nothing can clear.
    const handlers = buildSweepHandlers(context());
    await expect(handlers["sweep-stripe"]!(JOB)).resolves.toBeUndefined();
    await expect(handlers["sweep-execution"]!(JOB)).resolves.toBeUndefined();
    await expect(handlers["prune-jobs"]!(JOB)).resolves.toBeUndefined();
  });

  it("the stripe sweep drives the sweep and the terminal prune", async () => {
    const calls: number[] = [];
    const handlers = buildSweepHandlers(
      context({
        billing: {
          sweepStripeEvents: async () => void calls.push(1),
          pruneEvents: async (cutoff: number) => {
            calls.push(cutoff);
            return 0;
          },
        },
      }),
    );
    await handlers["sweep-stripe"]!(JOB);
    expect(calls[0]).toBe(1);
    // The cutoff is ~30 days back, the window the timer arm used.
    const cutoff = calls[1]!;
    const ageDays = (Date.now() - cutoff) / (24 * 60 * 60 * 1000);
    expect(ageDays).toBeGreaterThan(29.9);
    expect(ageDays).toBeLessThan(30.1);
  });

  it("the webhook sweep carries the link-GC and terminal-prune arms it shared a timer with", async () => {
    const ran: string[] = [];
    const handlers = buildSweepHandlers(
      context({
        integrations: {
          sweepExecution: async () => void ran.push("execution"),
          sweepWebhooks: async () => void ran.push("webhooks"),
          collectDeadLinks: async () => void ran.push("gc"),
          pruneTerminal: async () => {
            ran.push("prune");
            return { prunedEvents: 0, prunedChanges: 0 };
          },
        },
      }),
    );
    await handlers["sweep-webhooks"]!(JOB);
    // All three arms: the timer ran them together, so the handler must too.
    expect(ran).toEqual(["webhooks", "gc", "prune"]);
  });

  it("logs the prune counts when the terminal prune actually removed rows", async () => {
    const ctx = context({
      integrations: {
        sweepExecution: async () => {},
        sweepWebhooks: async () => {},
        collectDeadLinks: async () => {},
        pruneTerminal: async () => ({ prunedEvents: 3, prunedChanges: 2 }),
      },
    });
    await buildSweepHandlers(ctx)["sweep-webhooks"]!(JOB);
    expect(ctx.calls).toContain("log:integrations.prune");
  });

  it("a failing collaborator propagates, so the runner retries the job", async () => {
    const handlers = buildSweepHandlers(
      context({
        integrations: {
          sweepExecution: async () => {
            throw new Error("provider down");
          },
          sweepWebhooks: async () => {},
          collectDeadLinks: async () => {},
          pruneTerminal: async () => ({ prunedEvents: 0, prunedChanges: 0 }),
        },
      }),
    );
    // Not swallowed: the runner records the failure and requeues with backoff.
    await expect(handlers["sweep-execution"]!(JOB)).rejects.toThrow("provider down");
  });

  it("the maintenance prunes report what they removed", async () => {
    const ctx = context({
      maintenance: {
        pruneJobs: async () => 4,
        pruneOutbox: async () => 0,
        pruneUsage: () => {},
      },
    });
    const handlers = buildSweepHandlers(ctx);
    await handlers["prune-jobs"]!(JOB);
    await handlers["prune-outbox"]!(JOB);
    expect(ctx.calls).toContain("log:jobs.pruned");
    // Zero removed is not worth a log line: the common case is nothing to do.
    expect(ctx.calls).not.toContain("log:outbox.pruned");
  });
});
