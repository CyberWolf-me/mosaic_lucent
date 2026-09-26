import { randomUUID } from "node:crypto";
import type { Job, JobFamily, JobQueue } from "./jobs.js";

/**
 * The worker and scheduler roles (docs/20 P3, advisory §8/§9).
 *
 * `LUCENT_ROLE` selects what this process does:
 *
 *   - `all` (default) — HTTP + WebSocket + in-process scheduler and worker.
 *     This is single-process dev and the compose file's one-server mode, and
 *     it must keep behaving exactly as it did before this phase existed.
 *   - `api`  — HTTP + WebSocket only. No sweep timers, no job claiming.
 *   - `worker` — no HTTP listener. Claims jobs by family and runs them.
 *   - `scheduler` — no HTTP listener. Enqueues the recurring jobs.
 *
 * WHY THE SPLIT (advisory §9): a `setInterval` in the API process means N
 * instances run N sweeps. The ledger sweep is idempotent per row so N copies
 * are merely wasteful, but a sweep that emails or hits a rate-limited
 * provider is N-fold work against a third party. Moving the timers into
 * claimed jobs makes "exactly one instance runs this" a property of the
 * queue's claim rather than of luck.
 *
 * The scheduler is deliberately leaderless: it enqueues with a `dedupeKey`,
 * and the key's partial unique index makes a second scheduler's enqueue a
 * no-op. No leader election, no lease table.
 */

export const LUCENT_ROLES = ["all", "api", "worker", "scheduler"] as const;
export type LucentRole = (typeof LUCENT_ROLES)[number];

export function parseRole(raw: string | undefined): LucentRole {
  if (raw === undefined || raw === "") return "all";
  const normalized = raw.trim().toLowerCase();
  if ((LUCENT_ROLES as readonly string[]).includes(normalized)) return normalized as LucentRole;
  // An unrecognised role is a deployment typo. Failing loudly beats silently
  // behaving as `all` and running sweeps on every replica — the exact defect
  // this phase exists to remove.
  throw new Error(
    `LUCENT_ROLE="${raw}" is not a known role (expected one of: ${LUCENT_ROLES.join(", ")})`,
  );
}

/** Does this role serve HTTP/WebSocket traffic? */
export function servesHttp(role: LucentRole): boolean {
  return role === "all" || role === "api";
}

/** Does this role claim and run jobs? */
export function runsJobs(role: LucentRole): boolean {
  return role === "all" || role === "worker";
}

/** Does this role enqueue the recurring jobs? */
export function runsScheduler(role: LucentRole): boolean {
  return role === "all" || role === "scheduler";
}

/* -------------------------------------------------------------------------- */
/* The recurring-job schedule                                                 */
/* -------------------------------------------------------------------------- */

export interface RecurringJob {
  /** Dedupe key: one live job per key, so N schedulers enqueue one job. */
  key: string;
  family: JobFamily;
  type: string;
  /** Interval in ms, mirroring the `setInterval` this job replaced. */
  everyMs: number;
  payload?: Record<string, unknown>;
}

/**
 * The sweeps `main.ts:551–807` used to run on timers, as a schedule.
 *
 * Each entry names the interval its `setInterval` used, so the move is a
 * like-for-like translation rather than a retuning. `sweep-stripe` and
 * `sweep-execution`/`sweep-webhooks` were 5-minute ticks; the prune arms ran
 * on the 10-minute timer.
 */
export const RECURRING_JOBS: RecurringJob[] = [
  {
    key: "sweep-stripe",
    family: "integration",
    type: "sweep-stripe",
    everyMs: 5 * 60_000,
  },
  {
    key: "sweep-execution",
    family: "integration",
    type: "sweep-execution",
    everyMs: 5 * 60_000,
  },
  {
    key: "sweep-webhooks",
    family: "integration",
    type: "sweep-webhooks",
    everyMs: 5 * 60_000,
  },
  {
    key: "prune-jobs",
    family: "maintenance",
    type: "prune-jobs",
    everyMs: 10 * 60_000,
  },
  {
    key: "prune-outbox",
    family: "maintenance",
    type: "prune-outbox",
    everyMs: 10 * 60_000,
  },
  {
    key: "prune-usage",
    family: "maintenance",
    type: "prune-usage",
    everyMs: 10 * 60_000,
  },
  // docs/24 Phase H: transcript retention is coarse (day granularity), so an
  // hourly sweep is plenty — retention deletes history, and history deletion
  // should never race the meeting it deletes by minutes.
  {
    key: "sweep-retention",
    family: "maintenance",
    type: "sweep-retention",
    everyMs: 60 * 60_000,
  },
  // docs/28 F14: an abandoned capture is ended once it has been silent for
  // IDLE_CAPTURE_MS (12 h); a 15-minute tick is precise enough for that.
  {
    key: "sweep-idle-captures",
    family: "maintenance",
    type: "sweep-idle-captures",
    everyMs: 15 * 60_000,
  },
];

/**
 * Enqueue every due recurring job. Called on the scheduler's tick.
 *
 * The dedupe key is what makes this safe to call from N schedulers: the
 * second enqueue loses the unique index and returns the existing row. A job
 * still queued or running from the previous interval therefore means this
 * tick is a no-op — the queue self-throttles to the worker's actual
 * throughput, which is strictly better than a timer that piles up work it
 * cannot finish.
 */
export async function enqueueRecurring(
  queue: JobQueue,
  schedule: RecurringJob[] = RECURRING_JOBS,
  now: number = Date.now(),
): Promise<string[]> {
  const enqueued: string[] = [];
  for (const entry of schedule) {
    const job = await queue.enqueue({
      family: entry.family,
      type: entry.type,
      ...(entry.payload ? { payload: entry.payload } : {}),
      dedupeKey: entry.key,
      runAfter: now,
    });
    enqueued.push(job.id);
  }
  return enqueued;
}

/* -------------------------------------------------------------------------- */
/* Worker identity                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A stable-ish identity for this worker's claims. The hostname plus a random
 * suffix: unique per process (so two workers on one host are distinct, which
 * the stale-window recovery depends on) while still readable in `claimed_by`
 * when an operator asks "which worker is holding this job?".
 */
export function workerId(prefix = "worker"): string {
  const host = process.env.HOSTNAME ?? process.env.COMPUTERNAME ?? "local";
  return `${prefix}-${host}-${randomUUID().slice(0, 8)}`;
}

/** Conventional family sets, for the process-per-family scaling in §8. */
export function familiesFor(role: LucentRole, env: string | undefined): JobFamily[] | undefined {
  if (role === "worker" && env) {
    const requested = env
      .split(",")
      .map((f) => f.trim().toLowerCase())
      .filter(
        (f): f is JobFamily =>
          f === "ai" || f === "media" || f === "integration" || f === "maintenance",
      );
    if (requested.length > 0) return requested;
  }
  // `all` and an unconfigured worker serve everything.
  return undefined;
}

/** The handler registry a worker builds: type → body. */
export type JobHandlers = Record<string, (job: Job) => void | Promise<void>>;
