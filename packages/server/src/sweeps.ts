import type { Job } from "./jobs.js";

/**
 * The sweep handlers (docs/20 P3, advisory §9).
 *
 * These bodies used to be inline `setInterval` closures in `main.ts:551–807`.
 * They are moved here for two reasons the advisory states directly:
 *
 *   - §9: a timer in the API process means N instances run N sweeps. As jobs,
 *     "exactly one instance runs this" is the queue's claim, not luck.
 *   - §22: a sweep with a name can be measured. Queue depth, duration, and
 *     failure counts per handler are the metrics that were impossible when
 *     the work was an anonymous closure.
 *
 * THE BODIES ARE UNCHANGED. Each is the same code, taking its collaborators
 * from a context object instead of closing over `main.ts`'s locals — the
 * move docs/20 asks for ("their bodies are already pure, testable functions
 * ... each becomes a job handler registered against a family"). Where a body
 * needs one of `main.ts`'s many stores, it arrives through the context.
 */

/** Everything a sweep needs, supplied by the process that owns the stores. */
export interface SweepContext {
  /** Structured logger, same shape main.ts uses. */
  logger: {
    info: (event: string, fields?: Record<string, unknown>) => void;
    error: (event: string, fields?: Record<string, unknown>) => void;
  };
  /** The billing sweep's collaborators, absent when Stripe is unconfigured. */
  billing?: {
    sweepStripeEvents: () => Promise<unknown>;
    pruneEvents: (cutoff: number) => Promise<number>;
  };
  /** The integration sweep's collaborators. */
  integrations?: {
    /** Re-claim and re-run stuck execution-ledger rows. */
    sweepExecution: () => Promise<void>;
    /** Retry pending webhook deliveries by refetching current truth. */
    sweepWebhooks: () => Promise<void>;
    /** Collect links whose board or node is gone. */
    collectDeadLinks: () => Promise<void>;
    /** Drop terminal webhook/inbound rows past retention. */
    pruneTerminal: (cutoff: number) => Promise<{ prunedEvents: number; prunedChanges: number }>;
  };
  /** Retention arms that belong to no integration surface. */
  maintenance?: {
    pruneJobs: (olderThanMs: number) => Promise<number>;
    pruneOutbox: (olderThanMs: number) => Promise<number>;
    pruneUsage: () => Promise<void> | void;
  };
}

/** Terminal-row retention: 30 days, the window the prune arms already used. */
const TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Build the handler registry a job runner consumes.
 *
 * A handler whose collaborators are absent (no billing configured, no
 * integrations) completes as a no-op rather than failing: an unconfigured
 * deployment must not accumulate a permanent queue backlog of work that can
 * never succeed. That is the same judgement the routes make when they answer
 * 503 for an unconfigured integration surface.
 */
export function buildSweepHandlers(ctx: SweepContext): Record<string, (job: Job) => Promise<void>> {
  return {
    async "sweep-stripe"(): Promise<void> {
      if (!ctx.billing) return;
      await ctx.billing.sweepStripeEvents();
      // Terminal Stripe rows older than the window; Stripe serves an event
      // for ~30 days, so an older failed row can never be replayed.
      await ctx.billing.pruneEvents(Date.now() - TERMINAL_RETENTION_MS);
    },

    async "sweep-execution"(): Promise<void> {
      if (!ctx.integrations) return;
      await ctx.integrations.sweepExecution();
    },

    async "sweep-webhooks"(): Promise<void> {
      if (!ctx.integrations) return;
      await ctx.integrations.sweepWebhooks();
      // The link-GC arm rode the same timer and belongs to the same family.
      await ctx.integrations.collectDeadLinks();
      const { prunedEvents, prunedChanges } = await ctx.integrations.pruneTerminal(
        Date.now() - TERMINAL_RETENTION_MS,
      );
      if (prunedEvents > 0 || prunedChanges > 0) {
        ctx.logger.info("integrations.prune", { prunedEvents, prunedChanges });
      }
    },

    async "prune-jobs"(): Promise<void> {
      if (!ctx.maintenance) return;
      // Finished jobs are a hand-off record, not history: the op log and the
      // audit trail are where history lives (ADR 0040).
      const removed = await ctx.maintenance.pruneJobs(TERMINAL_RETENTION_MS);
      if (removed > 0) ctx.logger.info("jobs.pruned", { removed });
    },

    async "prune-outbox"(): Promise<void> {
      if (!ctx.maintenance) return;
      const removed = await ctx.maintenance.pruneOutbox(TERMINAL_RETENTION_MS);
      if (removed > 0) ctx.logger.info("outbox.pruned", { removed });
    },

    async "prune-usage"(): Promise<void> {
      if (!ctx.maintenance) return;
      await ctx.maintenance.pruneUsage();
    },
  };
}
