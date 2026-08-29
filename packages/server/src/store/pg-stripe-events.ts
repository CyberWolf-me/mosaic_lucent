import { and, asc, eq, inArray, lte, lt, or } from "drizzle-orm";
import { stripeEvents } from "../db/schema.js";
import type { Db } from "../db/client.js";
import {
  DEFAULT_STALE_AFTER_MS,
  isReclaimable,
  truncateError,
  type NewStripeEvent,
  type StripeEventClaim,
  type StripeEventRecord,
  type StripeEventStore,
  type StripeEventStatus,
} from "../billing/events.js";

/**
 * Postgres half of the Stripe webhook idempotency ledger (M4.3, ADR 0006).
 *
 * The contract and its in-memory twin live in `billing/events.ts`; the point of
 * this file is that the two are observably identical, which
 * `test/billing-events.test.ts` asserts by running the same suite over both.
 * The differences are all about who decides a race:
 *
 *  - The in-memory store decides races by event-loop ordering. Here the
 *    primary key on `id` decides them: the first INSERT wins, every loser
 *    reads the winner's row and answers `duplicate` / `in_flight`.
 *  - A re-claim is not a blind write. It is a status-guarded UPDATE whose
 *    WHERE clause restates `isReclaimable`, so two workers that both decide a
 *    stale row is theirs still produce exactly one `claimed` -- the loser's
 *    UPDATE matches zero rows.
 *
 * `error` text is capped by `truncateError` before it reaches the column, and
 * epoch-millisecond integers go in as numbers: the columns are bigint with
 * `mode: "number"` (schema.ts), so no string round trip exists to get wrong.
 */
export class PostgresStripeEventStore implements StripeEventStore {
  constructor(private readonly target: Db) {}

  async claim(
    event: NewStripeEvent,
    now: number,
    staleAfterMs = DEFAULT_STALE_AFTER_MS,
  ): Promise<StripeEventClaim> {
    // First writer takes the row. ON CONFLICT DO NOTHING rather than DO UPDATE:
    // the loser must not disturb the winner's `received_at`, which is what the
    // stale window and the in-flight answer are both computed from.
    const inserted = await this.target.db
      .insert(stripeEvents)
      .values({
        id: event.id,
        type: event.type,
        orgId: null,
        livemode: event.livemode,
        status: "received",
        attempts: 1,
        error: null,
        receivedAt: now,
        processedAt: null,
      })
      .onConflictDoNothing({ target: stripeEvents.id })
      .returning();

    if (inserted.length > 0) {
      return { outcome: "claimed", record: rowToRecord(inserted[0]!) };
    }

    // The row exists. Re-read it: the values the claim decision needs
    // (`status`, `received_at`, `attempts`) may have moved on since the
    // conflict, and a decision made from stale values would answer
    // `in_flight` about a row that has since gone reclaimable.
    //
    // One retry covers the only other race here -- a prune deleting the row
    // between the failed insert and this select -- by falling through to a
    // second insert attempt, which then simply wins. Two prunes in that exact
    // window is not a real schedule; a loop would be unchecked complexity.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const existing = await this.readRow(event.id);
      if (!existing) {
        const again = await this.target.db
          .insert(stripeEvents)
          .values({
            id: event.id,
            type: event.type,
            orgId: null,
            livemode: event.livemode,
            status: "received",
            attempts: 1,
            error: null,
            receivedAt: now,
            processedAt: null,
          })
          .onConflictDoNothing({ target: stripeEvents.id })
          .returning();
        if (again.length > 0) return { outcome: "claimed", record: rowToRecord(again[0]!) };
        continue; // Someone else re-inserted between the delete and us.
      }
      if (existing.status === "processed" || existing.status === "ignored") {
        return { outcome: "duplicate", record: existing };
      }
      if (!isReclaimable(existing, now, staleAfterMs)) {
        return { outcome: "in_flight", record: existing };
      }
      // Re-claim. `error` is deliberately left in place -- while the retry
      // runs, the reason the last attempt lost is the most useful thing the
      // row can say (same rule as the in-memory store).
      const reclaimed = await this.target.db
        .update(stripeEvents)
        .set({
          status: "received",
          attempts: existing.attempts + 1,
          receivedAt: now,
          processedAt: null,
        })
        .where(reclaimGuard(event.id, now - staleAfterMs))
        .returning();
      if (reclaimed.length > 0) return { outcome: "claimed", record: rowToRecord(reclaimed[0]!) };
      // The guard matched nothing: a concurrent worker re-claimed between our
      // read and our update. That is `in_flight`, honestly reported.
      const winner = await this.readRow(event.id);
      if (winner) return { outcome: "in_flight", record: winner };
    }
    // Unreachable in practice (see the loop comment); a throw here fails the
    // delivery with a 5xx, which asks Stripe to try again rather than losing it.
    throw new Error(`stripe_events: could not claim ${event.id}`);
  }

  async get(id: string): Promise<StripeEventRecord | undefined> {
    const row = await this.readRow(id);
    return row;
  }

  async markProcessed(id: string, orgId: string | null, now: number): Promise<void> {
    await this.patch(id, { status: "processed", orgId, error: null, processedAt: now });
  }

  async markIgnored(id: string, now: number): Promise<void> {
    await this.patch(id, { status: "ignored", error: null, processedAt: now });
  }

  async markFailed(id: string, error: string, now: number): Promise<void> {
    await this.patch(id, { status: "failed", error: truncateError(error), processedAt: now });
  }

  async pending(
    now: number,
    opts: { staleAfterMs?: number; limit?: number } = {},
  ): Promise<StripeEventRecord[]> {
    const staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    const rows = await this.target.db
      .select()
      .from(stripeEvents)
      .where(reclaimableFilter(now - staleAfterMs))
      .orderBy(asc(stripeEvents.receivedAt))
      .limit(opts.limit ?? 50);
    return rows.map(rowToRecord);
  }

  async prune(before: number): Promise<number> {
    const removed = await this.target.db
      .delete(stripeEvents)
      .where(
        and(
          inArray(stripeEvents.status, ["processed", "ignored"] satisfies StripeEventStatus[]),
          lt(stripeEvents.receivedAt, before),
        ),
      )
      .returning({ id: stripeEvents.id });
    return removed.length;
  }

  private async readRow(id: string): Promise<StripeEventRecord | undefined> {
    const rows = await this.target.db
      .select()
      .from(stripeEvents)
      .where(eq(stripeEvents.id, id))
      .limit(1);
    return rows.length > 0 ? rowToRecord(rows[0]!) : undefined;
  }

  /**
   * Writing to a row that is not there is silently ignored rather than thrown
   * on. The only way it happens is a prune between the claim and the mark, and
   * failing the webhook -- which would make Stripe redeliver work we finished
   * -- is a worse answer than losing one ledger row. Same rule, and same
   * reasoning, as `InMemoryStripeEventStore.patch`.
   */
  private async patch(id: string, fields: Partial<StripeEventRecord>): Promise<void> {
    await this.target.db.update(stripeEvents).set(fields).where(eq(stripeEvents.id, id));
  }
}

/**
 * `status`/`received_at` guard that restates `isReclaimable` in SQL:
 * `now - receivedAt >= staleAfterMs` is `receivedAt <= now - staleAfterMs`
 * over integer epoch milliseconds.
 */
function reclaimGuard(id: string, staleBefore: number) {
  return and(
    eq(stripeEvents.id, id),
    or(
      eq(stripeEvents.status, "failed"),
      and(eq(stripeEvents.status, "received"), lte(stripeEvents.receivedAt, staleBefore)),
    ),
  );
}

/** The sweep's WHERE clause: every row `pending()` may hand back. */
function reclaimableFilter(staleBefore: number) {
  return or(
    eq(stripeEvents.status, "failed"),
    and(eq(stripeEvents.status, "received"), lte(stripeEvents.receivedAt, staleBefore)),
  );
}

function rowToRecord(row: typeof stripeEvents.$inferSelect): StripeEventRecord {
  return {
    id: row.id,
    type: row.type,
    orgId: row.orgId,
    livemode: row.livemode,
    status: row.status,
    attempts: row.attempts,
    error: row.error,
    receivedAt: row.receivedAt,
    processedAt: row.processedAt,
  };
}
