import { and, asc, eq, gte, lt, lte, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { plans as plansTable, subscriptions, usageEvents, usageRollups } from "../db/schema.js";
import { parsePlanLimits, type PlanDefinition } from "../plans.js";
import {
  monthWindow,
  dayWindow,
  type Period,
  type StoredPlan,
  type StoredSubscription,
  type SubscriptionStatus,
  type UsageEvent,
  type UsageKind,
  type UsageRollup,
  type UsageStore,
} from "../usageStore.js";

/**
 * Postgres-backed UsageStore (M4.1, M4.2). Same contract as
 * `InMemoryUsageStore`, verified by the same test suite, so the request path
 * cannot tell which one it has.
 *
 * Three things SQL does not say on its own:
 *   - totals are always `SUM(quantity)` over `usage_events`, never a counter, so
 *     any total can be recomputed after a bug and reconciled against an invoice;
 *   - every aggregate reads through the `(org_id, kind, at)` index, which is why
 *     the window is expressed as `at >= start AND at < end` rather than as a
 *     function of `at` (a `date_trunc` in the predicate would not be indexable);
 *   - `sum()` and `count()` come back as strings over the wire (Postgres numeric
 *     and int8 have no lossless JS number), so every aggregate is coerced
 *     explicitly rather than trusted to arrive as a number.
 */
export class PostgresUsageStore implements UsageStore {
  constructor(private readonly target: Db) {}

  async seedPlans(defs: readonly PlanDefinition[], now: number): Promise<void> {
    if (defs.length === 0) return;
    await this.target.db
      .insert(plansTable)
      .values(
        defs.map((def) => ({
          code: def.code,
          displayName: def.displayName,
          rank: def.rank,
          limits: def.limits,
          priceCents: def.priceCents,
          annualPriceCents: def.annualPriceCents,
          currency: def.currency,
          updatedAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: plansTable.code,
        // Stripe price ids are deliberately absent: they are per-deployment
        // configuration set by an operator, and a boot-time seed must not
        // reset them to null.
        set: {
          displayName: sql`excluded.display_name`,
          rank: sql`excluded.rank`,
          limits: sql`excluded.limits`,
          priceCents: sql`excluded.price_cents`,
          annualPriceCents: sql`excluded.annual_price_cents`,
          currency: sql`excluded.currency`,
          updatedAt: sql`excluded.updated_at`,
        },
      });
  }

  async plan(code: string): Promise<StoredPlan | undefined> {
    const rows = await this.target.db
      .select()
      .from(plansTable)
      .where(eq(plansTable.code, code))
      .limit(1);
    return rows[0] ? rowToStoredPlan(rows[0]) : undefined;
  }

  async plans(): Promise<StoredPlan[]> {
    const rows = await this.target.db.select().from(plansTable).orderBy(asc(plansTable.rank));
    // A row whose `limits` JSONB will not parse is dropped rather than served
    // half-formed: an entitlement resolved from garbage fails open, and a
    // missing row already has a defined meaning (fall back to Free).
    return rows.map(rowToStoredPlan).filter((p): p is StoredPlan => p !== undefined);
  }

  async putPlan(plan: StoredPlan): Promise<void> {
    // Unlike `seedPlans` this does write the Stripe ids: the caller is an
    // operator or an admin route, and this is the only way they get set.
    const values = {
      code: plan.code,
      displayName: plan.displayName,
      rank: plan.rank,
      limits: plan.limits,
      priceCents: plan.priceCents,
      annualPriceCents: plan.annualPriceCents,
      currency: plan.currency,
      stripePriceId: plan.stripePriceId,
      stripeAnnualPriceId: plan.stripeAnnualPriceId,
      updatedAt: plan.updatedAt,
    };
    await this.target.db
      .insert(plansTable)
      .values(values)
      .onConflictDoUpdate({ target: plansTable.code, set: values });
  }

  async subscription(orgId: string): Promise<StoredSubscription | undefined> {
    const rows = await this.target.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.orgId, orgId))
      .limit(1);
    return rows[0] ? rowToSubscription(rows[0]) : undefined;
  }

  async putSubscription(sub: StoredSubscription): Promise<void> {
    await this.target.db
      .insert(subscriptions)
      .values({
        orgId: sub.orgId,
        plan: sub.plan,
        status: sub.status,
        seats: sub.seats,
        periodStart: sub.periodStart,
        periodEnd: sub.periodEnd,
        cancelAt: sub.cancelAt,
        trialEndsAt: sub.trialEndsAt,
        stripeCustomerId: sub.stripeCustomerId,
        stripeSubscriptionId: sub.stripeSubscriptionId,
        createdAt: sub.createdAt,
        updatedAt: sub.updatedAt,
      })
      // org_id is the PK, so a webhook arriving twice updates rather than
      // duplicating -- and `createdAt` is left alone so the first row's history
      // survives an update.
      .onConflictDoUpdate({
        target: subscriptions.orgId,
        set: {
          plan: sub.plan,
          status: sub.status,
          seats: sub.seats,
          periodStart: sub.periodStart,
          periodEnd: sub.periodEnd,
          cancelAt: sub.cancelAt,
          trialEndsAt: sub.trialEndsAt,
          stripeCustomerId: sub.stripeCustomerId,
          stripeSubscriptionId: sub.stripeSubscriptionId,
          updatedAt: sub.updatedAt,
        },
      });
  }

  async subscriptionByStripeId(
    kind: "customer" | "subscription",
    id: string,
  ): Promise<StoredSubscription | undefined> {
    const column =
      kind === "customer" ? subscriptions.stripeCustomerId : subscriptions.stripeSubscriptionId;
    const rows = await this.target.db.select().from(subscriptions).where(eq(column, id)).limit(1);
    return rows[0] ? rowToSubscription(rows[0]) : undefined;
  }

  async record(event: UsageEvent): Promise<boolean> {
    // The PK on `id` is the idempotency guard: a retried request inserts
    // nothing and RETURNING comes back empty, which is the false.
    const inserted = await this.target.db
      .insert(usageEvents)
      .values({
        id: event.id,
        orgId: event.orgId,
        kind: event.kind,
        quantity: event.quantity,
        at: event.at,
        metadata: event.metadata ?? null,
      })
      .onConflictDoNothing({ target: usageEvents.id })
      .returning({ id: usageEvents.id });
    return inserted.length > 0;
  }

  async total(orgId: string, kind: UsageKind, period: Period): Promise<number> {
    const rows = await this.target.db
      .select({ total: sql<string>`coalesce(sum(${usageEvents.quantity}), 0)` })
      .from(usageEvents)
      .where(
        and(
          eq(usageEvents.orgId, orgId),
          eq(usageEvents.kind, kind),
          gte(usageEvents.at, period.start),
          lt(usageEvents.at, period.endExclusive),
        ),
      );
    return toNumber(rows[0]?.total);
  }

  async monthToDate(orgId: string, kind: UsageKind, now: number): Promise<number> {
    return this.total(orgId, kind, monthWindow(now));
  }

  async totalsByKind(orgId: string, period: Period): Promise<Record<string, number>> {
    const rows = await this.target.db
      .select({
        kind: usageEvents.kind,
        total: sql<string>`coalesce(sum(${usageEvents.quantity}), 0)`,
      })
      .from(usageEvents)
      .where(
        and(
          eq(usageEvents.orgId, orgId),
          gte(usageEvents.at, period.start),
          lt(usageEvents.at, period.endExclusive),
        ),
      )
      .groupBy(usageEvents.kind);
    const totals: Record<string, number> = {};
    for (const row of rows) totals[row.kind] = toNumber(row.total);
    return totals;
  }

  async rollupDay(day: string, now: number): Promise<number> {
    const { start, endExclusive } = dayWindow(day);
    // Delete-then-insert inside one transaction: a rebuild has to be able to
    // lower a total (events can disappear with a deleted org), which an upsert
    // alone cannot do, and no reader should ever see the day half-rebuilt.
    return this.target.db.transaction(async (tx) => {
      await tx.delete(usageRollups).where(eq(usageRollups.day, day));
      // Raw SQL because this is an INSERT ... SELECT: the aggregation happens
      // server-side, so rolling up a busy day never pulls its events into the
      // process. Parameters are cast explicitly -- in a SELECT list Postgres has
      // no column to infer a placeholder's type from.
      const inserted = await tx.execute(sql`
        insert into ${usageRollups} (org_id, day, kind, quantity, events, updated_at)
        select ${usageEvents.orgId},
               ${day}::text,
               ${usageEvents.kind},
               sum(${usageEvents.quantity}),
               count(*),
               ${now}::bigint
          from ${usageEvents}
         where ${usageEvents.at} >= ${start} and ${usageEvents.at} < ${endExclusive}
         group by ${usageEvents.orgId}, ${usageEvents.kind}
        returning org_id
      `);
      return inserted.rows.length;
    });
  }

  async rollups(orgId: string, fromDay: string, toDay: string): Promise<UsageRollup[]> {
    // `day` is `YYYY-MM-DD`, so a text range scan is a date range scan, and the
    // composite PK (org_id, day, kind) serves it directly.
    const rows = await this.target.db
      .select()
      .from(usageRollups)
      .where(
        and(
          eq(usageRollups.orgId, orgId),
          gte(usageRollups.day, fromDay),
          lte(usageRollups.day, toDay),
        ),
      )
      .orderBy(asc(usageRollups.day), asc(usageRollups.kind));
    return rows.map((r) => ({
      orgId: r.orgId,
      day: r.day,
      kind: r.kind,
      quantity: r.quantity,
      events: r.events,
      updatedAt: r.updatedAt,
    }));
  }
}
function rowToStoredPlan(row: typeof plansTable.$inferSelect): StoredPlan | undefined {
  // The JSONB is re-parsed on every read (M4.1): a row written by an older
  // build, or edited by hand during an incident, is untrusted input, and a
  // malformed limit set would fail open.
  const limits = parsePlanLimits(row.limits);
  if (!limits) {
    console.warn("[lucent] plan " + row.code + " has unparseable limits; ignoring the row");
    return undefined;
  }
  return {
    code: row.code,
    displayName: row.displayName,
    rank: row.rank,
    limits,
    priceCents: row.priceCents,
    annualPriceCents: row.annualPriceCents,
    currency: row.currency,
    stripePriceId: row.stripePriceId,
    stripeAnnualPriceId: row.stripeAnnualPriceId,
    updatedAt: row.updatedAt,
  };
}

function rowToSubscription(row: typeof subscriptions.$inferSelect): StoredSubscription {
  // No cast on `status`: the column's enum and `SubscriptionStatus` are separate
  // declarations, and this assignment is what makes them fail to compile if they
  // ever drift apart.
  const status: SubscriptionStatus = row.status;
  return {
    orgId: row.orgId,
    plan: row.plan,
    status,
    seats: row.seats,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    cancelAt: row.cancelAt,
    trialEndsAt: row.trialEndsAt,
    stripeCustomerId: row.stripeCustomerId,
    stripeSubscriptionId: row.stripeSubscriptionId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Postgres returns `sum()` as numeric and `count()` as int8, both of which
 * node-postgres hands over as strings to avoid silently losing precision. Every
 * aggregate goes through here rather than being trusted to arrive as a number.
 */
function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}
