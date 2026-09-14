import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Db } from "./db/client.js";
import { jobs } from "./db/schema.js";

/**
 * The job system (docs/20 P3, advisory §7/§9).
 *
 * The advisory's §9: `setInterval` in the API process means N instances run N
 * sweeps. §7: expensive AI work runs on the request path and occupies a
 * connection slot a user is waiting on. This is the substrate both fixes need
 * — a durable queue with a claim that is proven, not invented.
 *
 * THE CLAIM IS THE EXECUTION LEDGER'S, GENERALIZED. `integrations/ledger.ts`
 * already solved "two workers, one row, exactly one may act" with a triad:
 *
 *   1. first-INSERT-wins on a unique key (`.onConflictDoNothing().returning()`);
 *   2. a status-guarded re-claim whose WHERE restates the stale rule, so the
 *      loser's UPDATE matches zero rows and it learns it lost;
 *   3. a stale window that makes a dead worker's claim reclaimable.
 *
 * docs/20 says explicitly: "do not invent a new concurrency model." So this
 * module is that triad with `job` in place of `execution`, and the same
 * `isReclaimable`-shaped predicate inlining the staleness test.
 *
 * WHAT IT IS NOT: not Redis (ADR 0004's stance holds until a measured need),
 * not a second scheduler, not a microservice. Workers are processes from the
 * same image with `LUCENT_ROLE=worker`.
 */

/**
 * The worker families (advisory §8). A worker claims only the families it
 * serves, so an AI worker never picks up a billing sweep.
 */
export const JOB_FAMILIES = ["ai", "media", "integration", "maintenance"] as const;
export type JobFamily = (typeof JOB_FAMILIES)[number];

export type JobStatus = "queued" | "claimed" | "done" | "failed";

export interface Job {
  id: string;
  family: JobFamily;
  type: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  attempts: number;
  runAfter: number;
  claimedBy?: string;
  claimedAt?: number;
  result?: unknown;
  lastError?: string;
  createdAt: number;
  finishedAt?: number;
  dedupeKey?: string;
}

export interface NewJob {
  family: JobFamily;
  type: string;
  payload?: Record<string, unknown>;
  /** Earliest run time; defaults to now. */
  runAfter?: number;
  /** One live job per key. Re-enqueuing a live key is a no-op. */
  dedupeKey?: string;
}

/** How long a claim is honoured before another worker may take the job. */
export const DEFAULT_JOB_STALE_MS = 5 * 60_000;

/** Attempts before a job is left alone as poison. */
export const DEFAULT_JOB_MAX_ATTEMPTS = 5;

export interface JobQueue {
  /**
   * Enqueue. With a `dedupeKey` that a live job already holds, this is a
   * no-op returning the existing row — which is what makes a recurring
   * sweep safe to enqueue on every scheduler tick.
   */
  enqueue(job: NewJob): Promise<Job>;
  /**
   * Claim up to `limit` ready jobs from the given families for this worker.
   * Returns only jobs this caller won.
   */
  claim(families: JobFamily[], workerId: string, limit: number): Promise<Job[]>;
  /** Record success and release the claim. */
  complete(id: string, result?: unknown): Promise<void>;
  /**
   * Record a failure. The job goes back to `queued` with a backoff, unless
   * it has exhausted its attempts, in which case it is terminal `failed`.
   */
  fail(id: string, error: string): Promise<void>;
  /** Queue depth per family, for the metrics surface. */
  depth(families?: JobFamily[]): Promise<Record<string, number>>;
  /** Age of the oldest ready job, in ms — the "is the queue stalled?" signal. */
  oldestReadyAge(now?: number): Promise<number>;
  /**
   * Test/debug hook: make a job immediately runnable again, whatever its
   * backoff says. A retry backoff is measured in seconds and a test cannot
   * wait for it, so this is how the retry ladder is exercised without
   * mocking the clock. Not used by production paths.
   */
  requeueNow(id: string): Promise<void>;
  /** Test/debug hook: read one job's raw record, whatever its status. */
  raw(id: string): Promise<Job | undefined>;
}

/**
 * Is a claimed job reclaimable? The ledger's `isReclaimable`, restated.
 *
 * A `queued` job is ready by definition. A `claimed` job is only reclaimable
 * once its claim is older than the stale window — that is what makes a worker
 * that died mid-job recoverable without a heartbeat protocol.
 */
export function isJobReclaimable(job: Job, now: number, staleMs: number): boolean {
  if (job.status === "queued") return true;
  if (job.status === "claimed") return (job.claimedAt ?? 0) <= now - staleMs;
  return false;
}

/** Exponential-ish backoff for a retry: 2^attempts seconds, capped at 5 min. */
export function backoffFor(attempts: number): number {
  return Math.min(2 ** attempts * 1_000, 5 * 60_000);
}

function toJob(row: typeof jobs.$inferSelect): Job {
  return {
    id: row.id,
    family: row.family as JobFamily,
    type: row.type,
    payload: (row.payload as Record<string, unknown>) ?? {},
    status: row.status as JobStatus,
    attempts: row.attempts,
    runAfter: row.runAfter,
    ...(row.claimedBy !== null ? { claimedBy: row.claimedBy } : {}),
    ...(row.claimedAt !== null ? { claimedAt: row.claimedAt } : {}),
    ...(row.result !== null ? { result: row.result } : {}),
    ...(row.lastError !== null ? { lastError: row.lastError } : {}),
    createdAt: row.createdAt,
    ...(row.finishedAt !== null ? { finishedAt: row.finishedAt } : {}),
    ...(row.dedupeKey !== null ? { dedupeKey: row.dedupeKey } : {}),
  };
}

/**
 * pg returns BIGINT as a string (it cannot know a JS number is safe) and raw
 * `execute` returns the column's snake_case name, not the schema's property
 * name. The typed Drizzle query builder hides both; the raw claim statement
 * does not, so the row is mapped and coerced here.
 *
 * This is not cosmetic: `claimedAt` as a string would make
 * `claimedAt <= now - staleMs` compare a string to a number and silently
 * never reclaim a dead worker's job.
 */
function fromRawJob(row: Record<string, unknown>): Job {
  const num = (v: unknown): number | undefined => {
    if (v === null || v === undefined) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const str = (v: unknown): string | undefined =>
    v === null || v === undefined ? undefined : String(v);
  const claimedBy = str(row.claimed_by);
  const claimedAt = num(row.claimed_at);
  const result = row.result;
  const lastError = str(row.last_error);
  const finishedAt = num(row.finished_at);
  const dedupeKey = str(row.dedupe_key);
  return {
    id: String(row.id),
    family: String(row.family) as JobFamily,
    type: String(row.type),
    payload: (row.payload as Record<string, unknown>) ?? {},
    status: String(row.status) as JobStatus,
    attempts: num(row.attempts) ?? 0,
    runAfter: num(row.run_after) ?? 0,
    ...(claimedBy !== undefined ? { claimedBy } : {}),
    ...(claimedAt !== undefined ? { claimedAt } : {}),
    ...(result !== null && result !== undefined ? { result } : {}),
    ...(lastError !== undefined ? { lastError } : {}),
    createdAt: num(row.created_at) ?? 0,
    ...(finishedAt !== undefined ? { finishedAt } : {}),
    ...(dedupeKey !== undefined ? { dedupeKey } : {}),
  };
}

/* -------------------------------------------------------------------------- */
/* In-memory twin (no LUCENT_DATABASE_URL)                                    */
/* -------------------------------------------------------------------------- */

export class InMemoryJobQueue implements JobQueue {
  private readonly rows = new Map<string, Job>();
  private readonly order: string[] = [];

  constructor(
    private readonly staleMs: number = DEFAULT_JOB_STALE_MS,
    private readonly maxAttempts: number = DEFAULT_JOB_MAX_ATTEMPTS,
  ) {}

  async enqueue(job: NewJob): Promise<Job> {
    // Only one live job per dedupe key (queued or claimed).
    if (job.dedupeKey !== undefined) {
      for (const existing of this.rows.values()) {
        if (
          existing.dedupeKey === job.dedupeKey &&
          (existing.status === "queued" || existing.status === "claimed")
        ) {
          return existing;
        }
      }
    }
    const row: Job = {
      id: randomUUID(),
      family: job.family,
      type: job.type,
      payload: job.payload ?? {},
      status: "queued",
      attempts: 0,
      runAfter: job.runAfter ?? Date.now(),
      createdAt: Date.now(),
      ...(job.dedupeKey !== undefined ? { dedupeKey: job.dedupeKey } : {}),
    };
    this.rows.set(row.id, row);
    this.order.push(row.id);
    return row;
  }

  async claim(families: JobFamily[], workerId: string, limit: number): Promise<Job[]> {
    const now = Date.now();
    const claimed: Job[] = [];
    for (const id of this.order) {
      if (claimed.length >= limit) break;
      const row = this.rows.get(id);
      if (!row) continue;
      if (!families.includes(row.family)) continue;
      if (row.runAfter > now) continue;
      if (!isJobReclaimable(row, now, this.staleMs)) continue;
      if (row.attempts >= this.maxAttempts) continue;
      // Status-guarded, like the SQL twin: we only take it if it is still
      // in the state we just observed.
      const next: Job = {
        ...row,
        status: "claimed",
        attempts: row.attempts + 1,
        claimedBy: workerId,
        claimedAt: now,
      };
      this.rows.set(id, next);
      claimed.push(next);
    }
    return claimed;
  }

  async complete(id: string, result?: unknown): Promise<void> {
    const row = this.rows.get(id);
    if (!row) return;
    this.rows.set(id, {
      ...row,
      status: "done",
      finishedAt: Date.now(),
      ...(result !== undefined ? { result } : {}),
      claimedBy: undefined,
      claimedAt: undefined,
    });
  }

  async fail(id: string, error: string): Promise<void> {
    const row = this.rows.get(id);
    if (!row) return;
    const exhausted = row.attempts >= this.maxAttempts;
    this.rows.set(id, {
      ...row,
      status: exhausted ? "failed" : "queued",
      lastError: error,
      runAfter: exhausted ? row.runAfter : Date.now() + backoffFor(row.attempts),
      claimedBy: undefined,
      claimedAt: undefined,
      ...(exhausted ? { finishedAt: Date.now() } : {}),
    });
  }

  async depth(families?: JobFamily[]): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const row of this.rows.values()) {
      if (families && !families.includes(row.family)) continue;
      if (row.status !== "queued" && row.status !== "claimed") continue;
      counts[row.family] = (counts[row.family] ?? 0) + 1;
    }
    return counts;
  }

  async oldestReadyAge(now: number = Date.now()): Promise<number> {
    let oldest = Infinity;
    for (const row of this.rows.values()) {
      if (row.status !== "queued") continue;
      if (row.runAfter > now) continue;
      oldest = Math.min(oldest, row.runAfter);
    }
    return oldest === Infinity ? 0 : now - oldest;
  }

  async requeueNow(id: string): Promise<void> {
    const row = this.rows.get(id);
    if (!row) return;
    this.rows.set(id, { ...row, runAfter: Date.now() });
  }

  async raw(id: string): Promise<Job | undefined> {
    return this.rows.get(id);
  }
}

/* -------------------------------------------------------------------------- */
/* Postgres twin                                                              */
/* -------------------------------------------------------------------------- */

export class PostgresJobQueue implements JobQueue {
  constructor(
    private readonly db: Db,
    private readonly staleMs: number = DEFAULT_JOB_STALE_MS,
    private readonly maxAttempts: number = DEFAULT_JOB_MAX_ATTEMPTS,
  ) {}

  async enqueue(job: NewJob): Promise<Job> {
    const id = randomUUID();
    const inserted = await this.db.db
      .insert(jobs)
      .values({
        id,
        family: job.family,
        type: job.type,
        payload: job.payload ?? {},
        status: "queued",
        attempts: 0,
        runAfter: job.runAfter ?? Date.now(),
        createdAt: Date.now(),
        dedupeKey: job.dedupeKey ?? null,
      })
      // First-INSERT-wins on the dedupe key: a live key makes this a no-op.
      .onConflictDoNothing()
      .returning();
    if (inserted.length > 0) return toJob(inserted[0]!);
    // Lost the dedupe race (or the key is live): return the existing row.
    const [existing] = await this.db.db
      .select()
      .from(jobs)
      .where(eq(jobs.dedupeKey, job.dedupeKey!))
      .limit(1);
    if (!existing) throw new Error("job dedupe raced and lost its row");
    return toJob(existing);
  }

  /**
   * Claim ready jobs in one statement, so two workers polling concurrently
   * cannot both take the same row.
   *
   * `FOR UPDATE SKIP LOCKED` inside the subquery is what makes this safe at
   * any worker count: a row another worker is mid-claim on is skipped rather
   * than waited for. The outer status guard restates the reclaim rule, so a
   * job that moved between the SELECT and the UPDATE is not taken twice —
   * the same belt-and-braces shape the ledger's re-claim uses.
   */
  async claim(families: JobFamily[], workerId: string, limit: number): Promise<Job[]> {
    const now = Date.now();
    const staleBefore = now - this.staleMs;
    const rows = await this.db.db.execute(sql`
      with ready as (
        select "id" from ${jobs}
         where "family" = any(${sql.raw(`ARRAY[${families.map((f) => `'${f}'`).join(",")}]::text[]`)})
           and "attempts" < ${this.maxAttempts}
           and "run_after" <= ${now}::bigint
           and (
             "status" = 'queued'
             or ("status" = 'claimed' and "claimed_at" <= ${staleBefore}::bigint)
           )
         order by "run_after" asc
         limit ${limit}
         for update skip locked
      )
      update ${jobs} j
         set "status" = 'claimed',
             "attempts" = j."attempts" + 1,
             "claimed_by" = ${workerId},
             "claimed_at" = ${now}::bigint
        from ready
       where j."id" = ready."id"
         and (
           j."status" = 'queued'
           or (j."status" = 'claimed' and j."claimed_at" <= ${staleBefore}::bigint)
         )
      returning j.*
    `);
    return (rows.rows as Array<Record<string, unknown>>).map(fromRawJob);
  }

  async complete(id: string, result?: unknown): Promise<void> {
    await this.db.db
      .update(jobs)
      .set({
        status: "done",
        finishedAt: Date.now(),
        claimedBy: null,
        claimedAt: null,
        ...(result !== undefined ? { result } : {}),
      })
      .where(eq(jobs.id, id));
  }

  async fail(id: string, error: string): Promise<void> {
    const [row] = await this.db.db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
    if (!row) return;
    const exhausted = row.attempts >= this.maxAttempts;
    await this.db.db
      .update(jobs)
      .set({
        status: exhausted ? "failed" : "queued",
        lastError: error.slice(0, 500),
        runAfter: exhausted ? row.runAfter : Date.now() + backoffFor(row.attempts),
        claimedBy: null,
        claimedAt: null,
        ...(exhausted ? { finishedAt: Date.now() } : {}),
      })
      .where(eq(jobs.id, id));
  }

  async depth(families?: JobFamily[]): Promise<Record<string, number>> {
    const rows = await this.db.db
      .select({ family: jobs.family, status: jobs.status })
      .from(jobs)
      .where(
        families
          ? and(inArray(jobs.family, families), inArray(jobs.status, ["queued", "claimed"]))
          : inArray(jobs.status, ["queued", "claimed"]),
      );
    const counts: Record<string, number> = {};
    for (const row of rows) counts[row.family] = (counts[row.family] ?? 0) + 1;
    return counts;
  }

  async oldestReadyAge(now: number = Date.now()): Promise<number> {
    const [row] = await this.db.db
      .select({ runAfter: jobs.runAfter })
      .from(jobs)
      .where(and(eq(jobs.status, "queued"), lte(jobs.runAfter, now)))
      .orderBy(asc(jobs.runAfter))
      .limit(1);
    return row ? now - row.runAfter : 0;
  }

  /** Retention: drop finished jobs older than the window. */
  async prune(olderThanMs: number, now: number = Date.now()): Promise<number> {
    const removed = await this.db.db
      .delete(jobs)
      .where(
        and(
          inArray(jobs.status, ["done", "failed"]),
          lte(jobs.finishedAt, now - olderThanMs),
        ),
      )
      .returning({ id: jobs.id });
    return removed.length;
  }

  async requeueNow(id: string): Promise<void> {
    await this.db.db.update(jobs).set({ runAfter: Date.now() }).where(eq(jobs.id, id));
  }

  async raw(id: string): Promise<Job | undefined> {
    const [row] = await this.db.db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
    return row ? toJob(row) : undefined;
  }
}

/* -------------------------------------------------------------------------- */
/* The runner                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A job handler. Returning normally marks the job done; throwing records the
 * failure and requeues with a backoff (or terminates it as poison).
 *
 * HANDLERS MUST BE IDEMPOTENT. A stale claim means a handler can run twice
 * for one job — the same at-least-once contract the ledger's recovery path
 * already lives with, and the reason every integration handler re-verifies
 * against the provider rather than assuming it is the first attempt.
 */
export type JobHandler = (job: Job) => void | Promise<void>;

export interface JobRunnerOptions {
  queue: JobQueue;
  /** Stable identity for this worker process: who holds the claim. */
  workerId: string;
  /** Handler registry by job type. */
  handlers: Record<string, JobHandler>;
  /** Families this worker serves. Default: all. */
  families?: JobFamily[];
  /** Jobs claimed per tick. */
  batchSize?: number;
  /** How often the worker polls. */
  intervalMs?: number;
}

export class JobRunner {
  private readonly families: JobFamily[];
  private readonly batchSize: number;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  /** Set by `stop()`: a graceful drain finishes the in-flight tick, no more. */
  private draining = false;
  private processed = 0;
  private failures = 0;

  constructor(private readonly options: JobRunnerOptions) {
    this.families = options.families ?? [...JOB_FAMILIES];
    this.batchSize = options.batchSize ?? 10;
    this.intervalMs = options.intervalMs ?? 1_000;
  }

  /**
   * One poll-and-run pass. Never throws: a worker that dies on a bad job
   * takes every future job with it. A job with no registered handler is
   * completed rather than left queued — an unhandled type is a registration
   * bug, and leaving it would make the queue depth read as a stalled
   * backlog no worker can clear. (Same rule as the outbox's unhandled
   * event type.)
   */
  async tick(): Promise<{ claimed: number; completed: number; failed: number }> {
    if (this.running || this.draining) return { claimed: 0, completed: 0, failed: 0 };
    this.running = true;
    let completed = 0;
    let failed = 0;
    try {
      const claimed = await this.options.queue.claim(this.families, this.options.workerId, this.batchSize);
      for (const job of claimed) {
        const handler = this.options.handlers[job.type];
        if (!handler) {
          await this.options.queue.complete(job.id, { skipped: "no handler registered" });
          completed += 1;
          continue;
        }
        try {
          await handler(job);
          await this.options.queue.complete(job.id);
          this.processed += 1;
          completed += 1;
        } catch (err) {
          await this.options.queue.fail(job.id, (err as Error).message);
          this.failures += 1;
          failed += 1;
        }
      }
      return { claimed: claimed.length, completed, failed };
    } catch {
      // A queue-level failure (database down): nothing to record, the next
      // tick tries again.
      return { claimed: 0, completed: 0, failed: 0 };
    } finally {
      this.running = false;
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  stats(): { processed: number; failures: number } {
    return { processed: this.processed, failures: this.failures };
  }
}
