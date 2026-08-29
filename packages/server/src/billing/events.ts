/**
 * The Stripe webhook idempotency ledger (M4.3): interface, in-memory
 * implementation, and the vocabulary a handler answers in.
 *
 * Stripe redelivers an event until it sees a 2xx, and can deliver the same event
 * more than once even after one. A handler that grants seats or flips a
 * subscription to `active` therefore has to be exactly-once *in effect*, and the
 * only durable way to get that is to write the event id and let a unique primary
 * key refuse the second writer. `db/schema.ts:822` is that table; this is the
 * contract over it, with the Postgres half in `store/pg-stripe-events.ts` per
 * ADR 0006.
 *
 * The subtle part is not the duplicate -- it is the crash. A worker that claims
 * an event and then dies leaves a `received` row that no primary key will ever
 * refuse again, so a ledger whose only rule is "insert wins" turns one crash into
 * an event that is never processed. Hence `claim` returns three outcomes rather
 * than a boolean:
 *
 *   claimed    -- this caller owns the event; do the work;
 *   duplicate  -- it already reached a terminal status; do nothing, answer 200;
 *   in_flight  -- someone else claimed it moments ago and has not finished.
 *
 * A `received` row older than `staleAfterMs` is treated as abandoned and can be
 * re-claimed, which is what makes a crash recoverable without a separate
 * lease table. `failed` rows are re-claimable immediately: they represent work
 * that ran and lost, and the whole point of recording the failure is to retry it.
 */

/** Mirrors the `status` column enum in `db/schema.ts`. */
export type StripeEventStatus = "received" | "processed" | "ignored" | "failed";

export interface StripeEventRecord {
  /** Stripe's `evt_…` id, and the primary key that does the deduplication. */
  id: string;
  type: string;
  /** Resolved from the payload when it resolves at all; see `handlers.ts`. */
  orgId: string | null;
  livemode: "live" | "test";
  status: StripeEventStatus;
  /** How many times work has been *started* on this event. First claim is 1. */
  attempts: number;
  /** The last failure message, truncated by the writer. Null while healthy. */
  error: string | null;
  /**
   * When the current attempt started -- not when the event first arrived. The
   * stale check needs a "work began at" instant and this column is it; Stripe's
   * own dashboard is the record of delivery times, and this table is an
   * idempotency guard rather than a second copy of it.
   */
  receivedAt: number;
  processedAt: number | null;
}

/** What a verified envelope contributes to a new ledger row. */
export interface NewStripeEvent {
  id: string;
  type: string;
  livemode: "live" | "test";
}

export type StripeEventClaim =
  | { outcome: "claimed"; record: StripeEventRecord }
  | { outcome: "duplicate"; record: StripeEventRecord }
  | { outcome: "in_flight"; record: StripeEventRecord };

/**
 * How long a `received` row is assumed to be someone else's live work. Handling
 * an event is two or three store writes, so a minute is generous by an order of
 * magnitude; the cost of setting it too low is processing one event twice, which
 * is the thing this module exists to prevent.
 */
export const DEFAULT_STALE_AFTER_MS = 60_000;

/** Longest error text stored. The column is unbounded; a stack trace is not data. */
export const MAX_ERROR_CHARS = 500;

/**
 * What a handler did with an event. `processed` and `ignored` are the two honest
 * successes and they map straight onto ledger statuses, which is why this type
 * lives here rather than with the handlers: an outcome that has no status to
 * record is an outcome the ledger cannot explain later.
 *
 * A handler signals failure by throwing. There is no `failed` outcome, because a
 * handler that returns "I failed" and one that throws would be two paths to the
 * same row, and only one of them survives an unexpected exception.
 */
export type DispatchOutcome =
  | {
      kind: "processed";
      /** The org the event touched, when it resolved. Written to the row. */
      orgId: string | null;
      /** One line for the log, e.g. `pro seats=3 status=active`. */
      detail?: string;
    }
  | {
      kind: "ignored";
      /** Why, e.g. `no handler for customer.discount.created`. */
      detail?: string;
    };

export interface StripeEventStore {
  /**
   * Take ownership of an event, or report why we cannot. Must be atomic against
   * a concurrent caller: two deliveries of the same event that race here have to
   * produce exactly one `claimed`.
   */
  claim(event: NewStripeEvent, now: number, staleAfterMs?: number): Promise<StripeEventClaim>;
  get(id: string): Promise<StripeEventRecord | undefined>;
  /** Terminal success. `orgId` is recorded when the handler resolved one. */
  markProcessed(id: string, orgId: string | null, now: number): Promise<void>;
  /** Terminal no-op: an event type we do not act on, recorded rather than dropped. */
  markIgnored(id: string, now: number): Promise<void>;
  /** Non-terminal failure: the row stays re-claimable and carries the reason. */
  markFailed(id: string, error: string, now: number): Promise<void>;
  /**
   * The retry sweep, oldest first: `failed` rows, plus `received` rows old enough
   * to be abandoned. The only reason a crashed delivery gets picked up when
   * Stripe has already stopped redelivering it.
   */
  pending(
    now: number,
    opts?: { staleAfterMs?: number; limit?: number },
  ): Promise<StripeEventRecord[]>;
  /**
   * Drop terminal rows older than `before`, returning how many went. `failed`
   * rows are kept: they are the record of money that did not move.
   */
  prune(before: number): Promise<number>;
}

/** Cap an error message the way the Postgres writer does, so both agree. */
export function truncateError(message: string): string {
  const oneLine = message.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_ERROR_CHARS ? `${oneLine.slice(0, MAX_ERROR_CHARS)}…` : oneLine;
}

/**
 * Is a row available to be worked on? The single definition of the rule, shared
 * by `claim` and `pending` in both implementations so the sweep can never
 * disagree with the claim about what "abandoned" means.
 */
export function isReclaimable(
  record: StripeEventRecord,
  now: number,
  staleAfterMs: number,
): boolean {
  if (record.status === "failed") return true;
  return record.status === "received" && now - record.receivedAt >= staleAfterMs;
}

/**
 * Process-local ledger: the default, and what every test uses. The claim races
 * are decided by the single-threaded event loop here and by `ON CONFLICT` plus a
 * status-guarded `UPDATE` in Postgres; the observable contract is identical,
 * which is what `test/billing-events.test.ts` runs over both.
 */
export class InMemoryStripeEventStore implements StripeEventStore {
  private readonly rows = new Map<string, StripeEventRecord>();

  async claim(
    event: NewStripeEvent,
    now: number,
    staleAfterMs = DEFAULT_STALE_AFTER_MS,
  ): Promise<StripeEventClaim> {
    const existing = this.rows.get(event.id);
    if (!existing) {
      const record: StripeEventRecord = {
        id: event.id,
        type: event.type,
        orgId: null,
        livemode: event.livemode,
        status: "received",
        attempts: 1,
        error: null,
        receivedAt: now,
        processedAt: null,
      };
      this.rows.set(record.id, record);
      return { outcome: "claimed", record: { ...record } };
    }
    if (existing.status === "processed" || existing.status === "ignored") {
      return { outcome: "duplicate", record: { ...existing } };
    }
    if (!isReclaimable(existing, now, staleAfterMs)) {
      return { outcome: "in_flight", record: { ...existing } };
    }
    // Re-claim. `error` is deliberately left in place: while a retry is running,
    // the reason the last attempt lost is the most useful thing the row can say.
    const next: StripeEventRecord = {
      ...existing,
      status: "received",
      attempts: existing.attempts + 1,
      receivedAt: now,
      processedAt: null,
    };
    this.rows.set(next.id, next);
    return { outcome: "claimed", record: { ...next } };
  }

  async get(id: string): Promise<StripeEventRecord | undefined> {
    const row = this.rows.get(id);
    return row ? { ...row } : undefined;
  }

  async markProcessed(id: string, orgId: string | null, now: number): Promise<void> {
    this.patch(id, { status: "processed", orgId, error: null, processedAt: now });
  }

  async markIgnored(id: string, now: number): Promise<void> {
    this.patch(id, { status: "ignored", error: null, processedAt: now });
  }

  async markFailed(id: string, error: string, now: number): Promise<void> {
    this.patch(id, { status: "failed", error: truncateError(error), processedAt: now });
  }

  async pending(
    now: number,
    opts: { staleAfterMs?: number; limit?: number } = {},
  ): Promise<StripeEventRecord[]> {
    const staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    const due = [...this.rows.values()]
      .filter((row) => isReclaimable(row, now, staleAfterMs))
      .sort((a, b) => a.receivedAt - b.receivedAt)
      .map((row) => ({ ...row }));
    return opts.limit === undefined ? due : due.slice(0, opts.limit);
  }

  async prune(before: number): Promise<number> {
    let removed = 0;
    for (const [id, row] of this.rows) {
      const terminal = row.status === "processed" || row.status === "ignored";
      if (terminal && row.receivedAt < before) {
        this.rows.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  /**
   * Writing to a row that is not there is silently ignored rather than thrown on.
   * The only way it happens is a prune between the claim and the mark, and
   * failing the webhook -- which would make Stripe redeliver work we finished --
   * is a worse answer than losing one ledger row.
   */
  private patch(id: string, fields: Partial<StripeEventRecord>): void {
    const existing = this.rows.get(id);
    if (!existing) return;
    this.rows.set(id, { ...existing, ...fields });
  }
}
