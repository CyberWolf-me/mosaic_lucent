import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "./db/client.js";
import { outboxEvents } from "./db/schema.js";

/**
 * The transactional outbox (docs/20 P2, advisory §18/§19).
 *
 * WHY THIS EXISTS. Every interesting change in Lucent already commits
 * durably — an op log entry, a meeting ending, an external task syncing — and
 * several of those commits imply "something else should now happen" (send the
 * invite email, invalidate the search corpus, bump a product counter). Doing
 * that work inline makes the response slower and, worse, makes it LOSSY: if
 * the process dies between the commit and the side effect, the change is real
 * and its announcement never happened. Doing it in the other order is worse
 * still — an email about a change that then rolled back.
 *
 * The outbox closes that window the standard way: the announcement is a ROW,
 * written in the SAME transaction as the state change. Committing the change
 * commits the announcement; a rollback takes both. A separate dispatcher
 * reads undispatched rows and delivers them at-least-once, so the only failure
 * mode left is duplicate delivery — which consumers absorb by keying on
 * `event.id`.
 *
 * WHAT IT IS NOT. `payload` is notification-shaped and small: an id, a seq, a
 * name. Never an op payload, never board content. Same rule the realtime
 * fanout follows (`FANOUT_MAX_PAYLOAD_BYTES`), and ADR 0040's taxonomy:
 * a projection never becomes a second database.
 *
 * The codebase already names this future — `email/http.ts` says "a durable
 * outbox is the right answer and belongs with the job runner, not here."
 * This is that outbox; P3's job runner is what will consume it.
 */

/**
 * The event vocabulary. FIXED AND SMALL on purpose, the same discipline
 * `telemetry.ts` applies to its own union and `PRODUCT_EVENTS` applies to
 * counters: a new event is a deliberate one-line act here, never a dynamic
 * string assembled at a call site. A free-form `type` would make every
 * consumer's switch silently incomplete.
 */
export const OUTBOX_EVENT_TYPES = [
  /** An op batch committed to a board. Carries `{boardId, seq}` — the same
   * shape the pg_notify fanout carries, and for the same reason: subscribers
   * resync from the op log rather than trusting a payload copy. */
  "BoardOperationCommitted",
  /** A meeting's transcript finished processing. */
  "MeetingEnded",
  /** A pending external proposal was approved (the human gate cleared). */
  "ProposalApproved",
  /** An external task (Linear/GitHub/Jira) was updated from a Lucent change. */
  "ExternalTaskSynced",
  /** A scheduled provider sync (inbound or outbound) completed. */
  "IntegrationSyncCompleted",
  /** A Stripe webhook event was applied to billing state. */
  "StripeEventApplied",
  /** An asset finished uploading and its metadata committed. */
  "AssetStored",
  /** A person approved decisions in Review (docs/26 A5): `{nodeIds, by}`. */
  "DecisionApproved",
] as const;

export type OutboxEventType = (typeof OUTBOX_EVENT_TYPES)[number];

export interface OutboxEvent {
  id: string;
  type: OutboxEventType;
  boardId?: string;
  orgId?: string;
  /** Small, notification-shaped. Ids and seqs, never content. */
  payload: Record<string, unknown>;
  createdAt: number;
  dispatchedAt?: number;
  attempts: number;
  lastError?: string;
}

/** What a caller hands the store; `id`/`createdAt`/`attempts` are ours. */
export interface NewOutboxEvent {
  type: OutboxEventType;
  boardId?: string;
  orgId?: string;
  payload?: Record<string, unknown>;
}

/**
 * A consumer of delivered events. Returning normally means "handled";
 * throwing records the failure and leaves the row for a retry.
 *
 * CONSUMERS MUST BE IDEMPOTENT BY `event.id`. Delivery is at-least-once by
 * design — that is the trade the outbox makes, and it is the right one: a
 * duplicate email is a nuisance, a lost one is a bug the user reports.
 */
export type OutboxConsumer = (event: OutboxEvent) => void | Promise<void>;

export interface OutboxStore {
  /**
   * Append an event.
   *
   * `tx` is the whole point: when a caller passes the transaction that is
   * changing state, the row commits atomically with it. Omit it only for
   * events that describe something already durably committed, where the
   * window this closes does not exist.
   */
  append(event: NewOutboxEvent, tx?: unknown): Promise<OutboxEvent>;
  /** Undispatched rows, oldest first. Bounded by `limit`. */
  pending(limit: number): Promise<OutboxEvent[]>;
  /** Mark delivered. Returns false when another dispatcher got there first. */
  markDispatched(id: string, now?: number): Promise<boolean>;
  /** Record a failed attempt; the row stays pending for the retry. */
  markFailed(id: string, error: string): Promise<void>;
  /** Visible-for-tests count of undispatched rows. */
  pendingCount(): Promise<number>;
}

/** How many delivery attempts before a row is left alone as poison. */
export const OUTBOX_MAX_ATTEMPTS = 8;

/** Rows the dispatcher claims per tick. Bounds one tick's work. */
export const OUTBOX_BATCH_SIZE = 50;

function toEvent(row: {
  id: string;
  type: string;
  boardId: string | null;
  orgId: string | null;
  payload: unknown;
  createdAt: number;
  dispatchedAt: number | null;
  attempts: number;
  lastError: string | null;
}): OutboxEvent {
  return {
    id: row.id,
    type: row.type as OutboxEventType,
    ...(row.boardId !== null ? { boardId: row.boardId } : {}),
    ...(row.orgId !== null ? { orgId: row.orgId } : {}),
    payload: (row.payload as Record<string, unknown>) ?? {},
    createdAt: row.createdAt,
    ...(row.dispatchedAt !== null ? { dispatchedAt: row.dispatchedAt } : {}),
    attempts: row.attempts,
    ...(row.lastError !== null ? { lastError: row.lastError } : {}),
  };
}

/* -------------------------------------------------------------------------- */
/* In-memory twin (no LUCENT_DATABASE_URL — ADR 0006's optional-store rule)   */
/* -------------------------------------------------------------------------- */

/**
 * The dev/test store. `tx` is accepted and ignored: with no database there is
 * no transaction to join, which is exactly the honest degradation — the
 * in-memory path was never able to lose a commit to a crash, so it has
 * nothing to close.
 */
export class InMemoryOutbox implements OutboxStore {
  private readonly rows = new Map<string, OutboxEvent>();
  /** Stable insertion order, so `pending` is deterministic in tests. */
  private readonly order: string[] = [];

  async append(event: NewOutboxEvent): Promise<OutboxEvent> {
    const row: OutboxEvent = {
      id: randomUUID(),
      type: event.type,
      ...(event.boardId !== undefined ? { boardId: event.boardId } : {}),
      ...(event.orgId !== undefined ? { orgId: event.orgId } : {}),
      payload: event.payload ?? {},
      createdAt: Date.now(),
      attempts: 0,
    };
    this.rows.set(row.id, row);
    this.order.push(row.id);
    return row;
  }

  async pending(limit: number): Promise<OutboxEvent[]> {
    const out: OutboxEvent[] = [];
    for (const id of this.order) {
      if (out.length >= limit) break;
      const row = this.rows.get(id);
      if (row && row.dispatchedAt === undefined) out.push(row);
    }
    return out;
  }

  async markDispatched(id: string, now: number = Date.now()): Promise<boolean> {
    const row = this.rows.get(id);
    // First-wins, the same discipline the Postgres twin gets from a
    // status-guarded UPDATE: a second dispatcher's mark matches nothing.
    if (!row || row.dispatchedAt !== undefined) return false;
    this.rows.set(id, { ...row, dispatchedAt: now });
    return true;
  }

  async markFailed(id: string, error: string): Promise<void> {
    const row = this.rows.get(id);
    if (!row) return;
    this.rows.set(id, { ...row, attempts: row.attempts + 1, lastError: error });
  }

  async pendingCount(): Promise<number> {
    let n = 0;
    for (const row of this.rows.values()) if (row.dispatchedAt === undefined) n += 1;
    return n;
  }
}

/* -------------------------------------------------------------------------- */
/* Postgres twin                                                              */
/* -------------------------------------------------------------------------- */

export class PostgresOutbox implements OutboxStore {
  constructor(private readonly db: Db) {}

  async append(event: NewOutboxEvent, tx?: unknown): Promise<OutboxEvent> {
    // `tx` is the caller's Drizzle transaction handle when they have one.
    // Joining it is the entire point: the row then commits with the state
    // change it describes. Typed as unknown at the seam because the
    // transaction's exact Drizzle type is awkward to name across modules;
    // the call site passes `db.transaction(...)`'s handle.
    const runner = (tx ?? this.db.db) as Db["db"];
    const [row] = await runner
      .insert(outboxEvents)
      .values({
        id: randomUUID(),
        type: event.type,
        boardId: event.boardId ?? null,
        orgId: event.orgId ?? null,
        payload: event.payload ?? {},
        createdAt: Date.now(),
      })
      .returning();
    return toEvent(row!);
  }

  async pending(limit: number): Promise<OutboxEvent[]> {
    const rows = await this.db.db
      .select()
      .from(outboxEvents)
      .where(isNull(outboxEvents.dispatchedAt))
      .orderBy(asc(outboxEvents.createdAt))
      .limit(limit);
    // A poison row (one that fails every time) must not block the queue
    // forever: past the attempt ceiling it is skipped, and the operator
    // finds it by its recorded last_error rather than by a stalled pipeline.
    return rows.map(toEvent).filter((e) => e.attempts < OUTBOX_MAX_ATTEMPTS);
  }

  async markDispatched(id: string, now: number = Date.now()): Promise<boolean> {
    // Status-guarded: the WHERE restates "not yet dispatched", so when two
    // dispatchers race the loser's UPDATE matches zero rows and learns it
    // lost — the same first-wins discipline as the execution ledger's
    // re-claim (`reclaimGuard`).
    const updated = await this.db.db
      .update(outboxEvents)
      .set({ dispatchedAt: now })
      .where(and(eq(outboxEvents.id, id), isNull(outboxEvents.dispatchedAt)))
      .returning({ id: outboxEvents.id });
    return updated.length > 0;
  }

  async markFailed(id: string, error: string): Promise<void> {
    await this.db.db
      .update(outboxEvents)
      .set({
        attempts: sql`${outboxEvents.attempts} + 1`,
        // Truncated: a provider error can carry a whole response body.
        lastError: error.slice(0, 500),
      })
      .where(eq(outboxEvents.id, id));
  }

  async pendingCount(): Promise<number> {
    const rows = await this.db.db
      .select({ id: outboxEvents.id })
      .from(outboxEvents)
      .where(isNull(outboxEvents.dispatchedAt));
    return rows.length;
  }

  /**
   * Retention: drop delivered rows older than the window. The outbox is a
   * hand-off buffer, not a history — the audit log and the op log are where
   * history lives (ADR 0040).
   */
  async prune(olderThanMs: number, now: number = Date.now()): Promise<number> {
    const cutoff = now - olderThanMs;
    const removed = await this.db.db
      .delete(outboxEvents)
      .where(
        and(sql`${outboxEvents.dispatchedAt} is not null`, lt(outboxEvents.dispatchedAt, cutoff)),
      )
      .returning({ id: outboxEvents.id });
    return removed.length;
  }
}

/* -------------------------------------------------------------------------- */
/* The dispatcher                                                             */
/* -------------------------------------------------------------------------- */

export interface DispatcherOptions {
  store: OutboxStore;
  /** Consumers by event type. A type with no consumer is marked dispatched. */
  consumers?: Partial<Record<OutboxEventType, OutboxConsumer[]>>;
  /** Injected for tests; defaults to `setInterval`. */
  intervalMs?: number;
  batchSize?: number;
}

/**
 * Drains the outbox. One tick: read a bounded batch of undispatched rows,
 * hand each to its consumers, mark it delivered.
 *
 * DELIVERY SEMANTICS, stated plainly because they are a contract consumers
 * rely on: at-least-once, in `createdAt` order within a batch, and a row whose
 * consumer throws is left undispatched for the next tick. A consumer that
 * runs twice must be harmless — that is why every consumer keys on
 * `event.id`.
 *
 * An event type with NO registered consumer is marked dispatched rather than
 * left pending. Otherwise a vocabulary entry added before its consumer would
 * accumulate forever, and the queue's depth metric would read as a backlog
 * that no work can clear.
 */
export class OutboxDispatcher {
  private readonly consumers: Partial<Record<OutboxEventType, OutboxConsumer[]>>;
  private readonly batchSize: number;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  /** Facts for the metrics surface (P3 wires them into Prometheus). */
  private delivered = 0;
  private failed = 0;

  constructor(private readonly options: DispatcherOptions) {
    this.consumers = options.consumers ?? {};
    this.batchSize = options.batchSize ?? OUTBOX_BATCH_SIZE;
    this.intervalMs = options.intervalMs ?? 1_000;
  }

  /** Register a consumer after construction (routes/services attach late). */
  subscribe(type: OutboxEventType, consumer: OutboxConsumer): () => void {
    const list = this.consumers[type] ?? [];
    list.push(consumer);
    this.consumers[type] = list;
    return () => {
      const current = this.consumers[type];
      if (!current) return;
      const index = current.indexOf(consumer);
      if (index >= 0) current.splice(index, 1);
    };
  }

  /**
   * One drain pass. Exposed (not private) because tests and the worker
   * process both drive it directly — a dispatcher that can only run on a
   * timer is untestable without waiting on the clock.
   *
   * Never throws: a dispatcher that dies takes every undelivered event with
   * it. Per-event failures are recorded on the row and the pass continues.
   */
  async tick(): Promise<{ delivered: number; failed: number }> {
    // Re-entrancy guard: a slow consumer must not have a second pass
    // overlapping it and double-delivering the same batch.
    if (this.ticking) return { delivered: 0, failed: 0 };
    this.ticking = true;
    let deliveredNow = 0;
    let failedNow = 0;
    try {
      const rows = await this.options.store.pending(this.batchSize);
      for (const event of rows) {
        const handlers = this.consumers[event.type] ?? [];
        let ok = true;
        for (const handler of handlers) {
          try {
            await handler(event);
          } catch (err) {
            ok = false;
            this.failed += 1;
            failedNow += 1;
            await this.options.store.markFailed(event.id, (err as Error).message);
            // One failing consumer dooms the row: the others may already
            // have run, which is precisely why they must be idempotent.
            break;
          }
        }
        if (ok) {
          await this.options.store.markDispatched(event.id);
          this.delivered += 1;
          deliveredNow += 1;
        }
      }
    } catch {
      // A store-level failure (database down): leave the rows alone and let
      // the next tick retry. Nothing here is worth crashing the process for.
    } finally {
      this.ticking = false;
    }
    return { delivered: deliveredNow, failed: failedNow };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    // Never hold the process open for the drain loop.
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  stats(): { delivered: number; failed: number } {
    return { delivered: this.delivered, failed: this.failed };
  }
}
