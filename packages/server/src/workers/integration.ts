import type { Job } from "../jobs.js";

/**
 * The integration worker family (docs/20 P4, advisory §8).
 *
 * "The P3 sweeps live here; add provider polling and reconciliation jobs
 * (recovery-first retry already implemented in the sweep body — it moves,
 * not changes)."
 *
 * The sweeps themselves are registered by `main.ts` (they close over the
 * stores), so this module owns the parts that are the family's own: the
 * polling/reconciliation job types and the retry discipline they inherit.
 */

export interface IntegrationWorkerDeps {
  logger: { info: (e: string, f?: Record<string, unknown>) => void };
}

/**
 * How a provider poll decides what to fetch.
 *
 * The recovery-first doctrine (ADR 0032) is the family's spine: reconcile
 * before acting. A poll that finds an external task already carrying our
 * idempotency marker adopts it rather than creating a duplicate — which is
 * the same rule the execution sweep's `recoverCreate` implements, applied to
 * a scheduled poll instead of a stuck row.
 */
export interface ProviderPollRequest {
  orgId: string;
  provider: string;
  /** Only tasks this link set knows about; a full-account scan is the provider's job. */
  externalIds?: string[];
  /** Bounds one poll so a large org cannot monopolize a worker. */
  limit?: number;
}

export const INTEGRATION_JOB_TYPES = ["integration.poll", "integration.reconcile"] as const;

export function buildIntegrationHandlers(
  deps: IntegrationWorkerDeps,
): Record<string, (job: Job) => Promise<void>> {
  return {
    /**
     * Reserved: a scheduled provider poll (pull changes we did not get a
     * webhook for). Linear has no fetch-by-event-id API, so inbound recovery
     * today is triggered by a stale delivery; a poll is the complement for
     * providers whose webhooks can be dropped entirely.
     */
    "integration.poll": async (job: Job): Promise<void> => {
      deps.logger.info("integration.poll", { jobId: job.id, note: "lane reserved" });
    },
    /**
     * Reserved: reconcile a board's links against the provider's current
     * truth. The execution sweep already does this per stuck row; a
     * scheduled reconcile covers drift that never left a stuck row behind.
     */
    "integration.reconcile": async (job: Job): Promise<void> => {
      deps.logger.info("integration.reconcile", { jobId: job.id, note: "lane reserved" });
    },
  };
}
