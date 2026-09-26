import type { Job } from "./jobs.js";
import { effectiveSettings } from "./classification.js";
import type { StoredOrg } from "./orgs.js";
import type { MeetingStore } from "./meetings.js";

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
  /** Transcript retention (docs/24 Phase H): org enumeration + expiry delete. */
  retention?: {
    sweepTranscripts: () => Promise<{ orgsChecked: number; transcriptsDeleted: number }>;
  };
  /** Abandoned captures (docs/28 F14): end transcripts left open. */
  captures?: {
    endIdle: () => Promise<number>;
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

    async "sweep-retention"(): Promise<void> {
      if (!ctx.retention) return;
      const { orgsChecked, transcriptsDeleted } = await ctx.retention.sweepTranscripts();
      if (transcriptsDeleted > 0) {
        ctx.logger.info("retention.swept-transcripts", { orgsChecked, transcriptsDeleted });
      }
    },

    async "sweep-idle-captures"(): Promise<void> {
      if (!ctx.captures) return;
      const ended = await ctx.captures.endIdle();
      if (ended > 0) ctx.logger.info("meetings.ended-idle", { ended });
    },
  };
}

/**
 * How long a capture may go unheard before the sweep ends it (docs/28 F14).
 * Long enough that no real meeting's silence trips it — a capture ended
 * under a live tab would refuse that tab's next line — and short enough
 * that "in progress" stops meaning "someone closed the tab yesterday".
 */
export const IDLE_CAPTURE_MS = 12 * 60 * 60 * 1000;

/** End every capture unheard for `idleMs` (default {@link IDLE_CAPTURE_MS}). */
export async function sweepIdleCaptures(deps: {
  meetings: MeetingStore;
  now?: () => number;
  idleMs?: number;
  batch?: number;
}): Promise<number> {
  const now = deps.now ?? Date.now;
  return deps.meetings.endIdle(now() - (deps.idleMs ?? IDLE_CAPTURE_MS), deps.batch ?? 100);
}

/**
 * Delete per-org expired transcripts (docs/24 Phase H). One pass: every org
 * whose retention policy names a transcript lifetime loses the ended
 * transcripts older than it, oldest first, bounded per org. Orgs without a
 * policy are not even read for deletion — absence means board lifetime, and
 * the sweep must never invent work for them. Running captures are immune by
 * construction (`deleteExpired` only sees ended rows), so a policy turned
 * on mid-meeting strands nothing.
 */
export async function sweepRetentionTranscripts(deps: {
  orgs: { list(): Promise<StoredOrg[]> };
  meetings: MeetingStore;
  now?: () => number;
  batch?: number;
}): Promise<{ orgsChecked: number; transcriptsDeleted: number }> {
  const now = deps.now ?? Date.now;
  const batch = deps.batch ?? 100;
  const at = now();
  let orgsChecked = 0;
  let transcriptsDeleted = 0;
  for (const org of await deps.orgs.list()) {
    const days = effectiveSettings(org).retention.transcriptDays;
    if (days === null) continue;
    orgsChecked += 1;
    transcriptsDeleted += await deps.meetings.deleteExpired(
      org.id,
      at - days * 24 * 60 * 60 * 1000,
      batch,
    );
  }
  return { orgsChecked, transcriptsDeleted };
}
