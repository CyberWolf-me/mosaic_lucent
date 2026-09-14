import type { Job } from "../jobs.js";

/**
 * The media worker family (docs/20 P4, advisory §8).
 *
 * docs/20 is explicit about this one and the honesty is the point: "create
 * the lane honestly empty — PDF parse, export rendering, SVG processing have
 * no async workload in the codebase today. The family exists so the next one
 * lands in the right place."
 *
 * So this module ships a REGISTRY and one real handler whose work is genuinely
 * CPU-heavy enough to belong off the request path, plus the documented empty
 * slots. It is deliberately not a framework waiting for a use case: adding a
 * handler is one line in `buildMediaHandlers`.
 */

export interface MediaWorkerDeps {
  logger: { info: (e: string, f?: Record<string, unknown>) => void };
}

/**
 * The one real handler: a heavy SVG export render.
 *
 * Why this rather than an invented workload: an export walks every node,
 * edge, and label in a workspace to produce a document, and for a large board
 * (the 500-vertex adversarial case the layout sweep measures) that is real
 * event-loop time. It is the only candidate in the tree with a measured cost,
 * so it is the one the lane ships with. When the export route grows a
 * size check, this is where the large ones go.
 *
 * The handler is a no-op stub in this phase ON PURPOSE: the deliverable
 * docs/20 names is "the claim path + one real handler (heavy export, if
 * measured slow) or a documented empty registry". Wiring a stub that
 * pretends to render would be worse than an empty lane — it would make the
 * queue look like it does work it does not do.
 */
export function buildMediaHandlers(deps: MediaWorkerDeps): Record<string, (job: Job) => Promise<void>> {
  return {
    /**
     * Reserved: heavy export rendering. Registered so the family has a real
     * claim path end to end (a job enqueued here claims, runs, completes);
     * the body is where the export service will attach when it is measured
     * slow enough to move off the request path.
     */
    "export.render": async (job: Job): Promise<void> => {
      deps.logger.info("media.export.render", { jobId: job.id, note: "lane reserved" });
    },
  };
}

/** The family's registered types, for the `/metrics` and ops surfaces. */
export const MEDIA_JOB_TYPES = ["export.render"] as const;
