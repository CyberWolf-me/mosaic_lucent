import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  InMemoryUsageStore,
  dayWindow,
  monthWindow,
  newUsageEventId,
  usageEventId,
  utcDayKey,
  type StoredSubscription,
  type UsageKind,
  type UsageStore,
} from "../src/usageStore.js";
import { PostgresUsageStore } from "../src/store/pg-usage.js";
import { PLANS, PLAN_LADDER } from "../src/plans.js";
import { closeDb, createDb, type Db } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";

/**
 * UsageStore parity contract (M4.1, M4.2).
 *
 * Every property below is written once and asserted against BOTH
 * implementations, the same shape as `audit-store.test.ts` -- and for the same
 * reason: metering that works in memory and silently no-ops in Postgres is a
 * revenue bug that a green suite would hide. If a limit is enforced from a SUM,
 * the SUM has to mean the same thing in both stores.
 *
 * The Postgres half is gated on LUCENT_TEST_DATABASE_URL, the convention
 * pg-store.test.ts and audit-store.test.ts already use: without the variable it
 * is reported as skipped rather than quietly vanishing. CI supplies a
 * `postgres:16` service and runs `db:migrate` first.
 */

const URL = process.env.LUCENT_TEST_DATABASE_URL;

/** Unique per run, so this file needs no TRUNCATE and cannot race a sibling suite. */
const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** March 2026, UTC. Fixed dates so the month arithmetic is auditable by eye. */
const MAR_1 = Date.UTC(2026, 2, 1);
const MAR_15 = Date.UTC(2026, 2, 15, 12, 0, 0);
const APR_1 = Date.UTC(2026, 3, 1);
const FEB_28 = Date.UTC(2026, 1, 28, 12, 0, 0);
const DAY = "2026-03-15";

interface Harness {
  store: UsageStore;
  /** Create the org row the FKs require. A no-op for the in-memory store. */
  newOrg: (id: string) => Promise<void>;
}

interface Impl {
  name: string;
  enabled: boolean;
  open: () => Promise<Harness>;
  close: () => Promise<void>;
}

let db: Db | undefined;

const impls: Impl[] = [
  {
    name: "InMemoryUsageStore",
    enabled: true,
    open: async () => ({ store: new InMemoryUsageStore(), newOrg: async () => {} }),
    close: async () => {},
  },
  {
    name: "PostgresUsageStore",
    enabled: Boolean(URL),
    open: async () => {
      db = createDb(URL!);
      await migrate(db);
      const target = db;
      return {
        store: new PostgresUsageStore(target),
        // subscriptions, usage_events and usage_rollups all FK to organizations,
        // so the org has to exist before anything can be metered against it.
        newOrg: async (id: string) => {
          await target.pool.query(
            "INSERT INTO organizations (id, name, created_at) VALUES ($1, $2, $3)" +
              " ON CONFLICT (id) DO NOTHING",
            [id, id, 1],
          );
        },
      };
    },
    close: async () => {
      if (!db) return;
      // Leave the shared database as it was found. Subscriptions, events and
      // rollups all cascade with the org. The built-in plan rows are left in
      // place: `seedPlans` is what boot does anyway, and it is idempotent.
      await db.pool.query("DELETE FROM organizations WHERE id LIKE $1", [`org_use_${tag}%`]);
      await db.pool.query("DELETE FROM plans WHERE code LIKE $1", [`acme_${tag}%`]);
      await closeDb(db);
      db = undefined;
    },
  },
];

/** A complete subscription, so a test only states the field it cares about. */
function subscription(orgId: string, over: Partial<StoredSubscription> = {}): StoredSubscription {
  return {
    orgId,
    plan: "pro",
    status: "active",
    seats: 1,
    periodStart: MAR_1,
    periodEnd: APR_1,
    cancelAt: null,
    trialEndsAt: null,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    createdAt: MAR_1,
    updatedAt: MAR_1,
    ...over,
  };
}

for (const impl of impls) {
  const suite = impl.enabled ? describe : describe.skip;

  suite(`usage store contract — ${impl.name}`, () => {
    let store: UsageStore;
    let newOrg: (id: string) => Promise<void>;
    let orgCount = 0;

    beforeAll(async () => {
      if (!impl.enabled) return;
      const harness = await impl.open();
      store = harness.store;
      newOrg = harness.newOrg;
      // `subscriptions.plan` is a real FK, so the catalogue comes first.
      await store.seedPlans(PLAN_LADDER, 1);
    });

    afterAll(async () => {
      if (!impl.enabled) return;
      await impl.close();
    });

    async function freshOrg(): Promise<string> {
      orgCount += 1;
      const id = `org_use_${tag}_${orgCount}`;
      await newOrg(id);
      return id;
    }

    async function meter(
      orgId: string,
      kind: UsageKind,
      at: number,
      quantity = 1,
      id = newUsageEventId(),
    ): Promise<boolean> {
      return store.record({ id, orgId, kind, quantity, at });
    }

    it("seeds the plan catalogue idempotently", async () => {
      await store.seedPlans(PLAN_LADDER, 2);
      const rows = await store.plans();
      for (const def of PLAN_LADDER) {
        const row = rows.find((r) => r.code === def.code);
        expect(row).toBeDefined();
        expect(row!.limits).toEqual(def.limits);
        expect(row!.priceCents).toBe(def.priceCents);
      }
      // Cheapest first, so the pricing page needs no sort of its own.
      const ranks = rows.map((r) => r.rank);
      expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
      expect(await store.plan("free")).toBeDefined();
      expect(await store.plan("nope_" + tag)).toBeUndefined();
    });

    it("stores a contract plan and never reseeds over operator-set Stripe ids", async () => {
      // A negotiated Enterprise agreement: limits that exist nowhere in the
      // code, so they can only arrive as a row.
      const code = `acme_${tag}`;
      await store.putPlan({
        code,
        displayName: "Acme",
        rank: 99,
        limits: { ...PLANS.team.limits, seats: 400, "history.depth": null },
        priceCents: null,
        annualPriceCents: null,
        currency: "usd",
        stripePriceId: `price_${tag}`,
        stripeAnnualPriceId: null,
        updatedAt: 5,
      });
      const contract = await store.plan(code);
      expect(contract?.limits.seats).toBe(400);
      expect(contract?.stripePriceId).toBe(`price_${tag}`);

      // Seeding the built-in tiers must leave a contract row alone entirely,
      // and must not reset a Stripe id an operator attached to a built-in tier.
      await store.putPlan({
        ...PLANS.pro,
        limits: PLANS.pro.limits,
        currency: "usd",
        stripePriceId: `price_pro_${tag}`,
        stripeAnnualPriceId: null,
        updatedAt: 5,
      });
      await store.seedPlans(PLAN_LADDER, 6);
      expect((await store.plan(code))?.stripePriceId).toBe(`price_${tag}`);
      const pro = await store.plan("pro");
      expect(pro?.stripePriceId).toBe(`price_pro_${tag}`);
      expect(pro?.updatedAt).toBe(6);
      // Leave the shared catalogue as it was found.
      await store.putPlan({ ...pro!, stripePriceId: null, updatedAt: 6 });
    });

    it("keeps one subscription per org and updates it in place", async () => {
      const org = await freshOrg();
      expect(await store.subscription(org)).toBeUndefined();

      await store.putSubscription(subscription(org, { plan: "team", seats: 4 }));
      const first = await store.subscription(org);
      expect(first?.plan).toBe("team");
      expect(first?.seats).toBe(4);
      expect(first?.status).toBe("active");
      expect(first?.periodEnd).toBe(APR_1);

      // What a `customer.subscription.updated` webhook does: same org, new
      // state, still exactly one row.
      await store.putSubscription(
        subscription(org, { plan: "team", seats: 9, status: "past_due", updatedAt: MAR_15 }),
      );
      const second = await store.subscription(org);
      expect(second?.seats).toBe(9);
      expect(second?.status).toBe("past_due");
      expect(second?.updatedAt).toBe(MAR_15);
    });

    it("resolves an org from either Stripe id", async () => {
      const org = await freshOrg();
      await store.putSubscription(
        subscription(org, {
          stripeCustomerId: `cus_${tag}`,
          stripeSubscriptionId: `sub_${tag}`,
        }),
      );
      expect((await store.subscriptionByStripeId("customer", `cus_${tag}`))?.orgId).toBe(org);
      expect((await store.subscriptionByStripeId("subscription", `sub_${tag}`))?.orgId).toBe(org);
      // A webhook for a customer we have never seen must resolve to nothing
      // rather than to the first row in the table.
      expect(await store.subscriptionByStripeId("customer", `cus_missing_${tag}`)).toBeUndefined();
      expect(await store.subscriptionByStripeId("subscription", `cus_${tag}`)).toBeUndefined();
    });

    it("records an event once per id, so a retry cannot bill twice", async () => {
      const org = await freshOrg();
      const id = usageEventId(org, "ai.generation", "req_1");
      expect(await meter(org, "ai.generation", MAR_15, 1, id)).toBe(true);
      expect(await meter(org, "ai.generation", MAR_15, 1, id)).toBe(false);
      expect(await store.monthToDate(org, "ai.generation", MAR_15)).toBe(1);
    });

    it("counts a window half-open, so a month boundary belongs to one month", async () => {
      const org = await freshOrg();
      await meter(org, "ai.generation", MAR_1);
      await meter(org, "ai.generation", MAR_15);
      // Midnight on the 1st of April is April's first event, not March's last.
      await meter(org, "ai.generation", APR_1);
      expect(await store.total(org, "ai.generation", monthWindow(MAR_15))).toBe(2);
      expect(await store.total(org, "ai.generation", monthWindow(APR_1))).toBe(1);
    });

    it("sums quantities month to date and ignores other months", async () => {
      const org = await freshOrg();
      await meter(org, "voice.minute", FEB_28, 30);
      await meter(org, "voice.minute", MAR_1, 5);
      await meter(org, "voice.minute", MAR_15, 7);
      // A SUM, not a COUNT: two events, twelve minutes.
      expect(await store.monthToDate(org, "voice.minute", MAR_15)).toBe(12);
      expect(await store.monthToDate(org, "voice.minute", FEB_28)).toBe(30);
      expect(await store.monthToDate(org, "voice.minute", APR_1)).toBe(0);
    });

    it("keeps one org's usage out of another's totals", async () => {
      const mine = await freshOrg();
      const theirs = await freshOrg();
      await meter(mine, "ai.generation", MAR_15, 3);
      await meter(theirs, "ai.generation", MAR_15, 40);
      expect(await store.monthToDate(mine, "ai.generation", MAR_15)).toBe(3);
      expect(await store.monthToDate(theirs, "ai.generation", MAR_15)).toBe(40);
    });

    it("reports every kind for one window in a single answer", async () => {
      const org = await freshOrg();
      await meter(org, "ai.generation", MAR_15, 2);
      await meter(org, "voice.minute", MAR_15, 9);
      await meter(org, "image.generation", FEB_28, 4);
      const totals = await store.totalsByKind(org, monthWindow(MAR_15));
      expect(totals["ai.generation"]).toBe(2);
      expect(totals["voice.minute"]).toBe(9);
      // February's images are not March's, and a kind with no events in the
      // window is absent rather than zero.
      expect(Object.keys(totals).sort()).toEqual(["ai.generation", "voice.minute"]);
    });

    it("rolls a day up from its events and rebuilds without doubling", async () => {
      const org = await freshOrg();
      const start = dayWindow(DAY).start;
      await meter(org, "ai.generation", start, 1);
      await meter(org, "ai.generation", start + 86_399_999, 2);
      await meter(org, "voice.minute", start + 60_000, 5);
      // Midnight the next day belongs to the next day.
      await meter(org, "ai.generation", dayWindow("2026-03-16").start, 99);

      const written = await store.rollupDay(DAY, 100);
      // At least: another suite's org may share the day in a shared database.
      expect(written).toBeGreaterThanOrEqual(2);
      const rows = await store.rollups(org, DAY, DAY);
      expect(rows.map((r) => [r.kind, r.quantity, r.events])).toEqual([
        ["ai.generation", 3, 2],
        ["voice.minute", 5, 1],
      ]);
      expect(rows.every((r) => r.updatedAt === 100)).toBe(true);

      // Rebuilding is the point of keeping rollups derived: same numbers, and a
      // later event is picked up rather than added to a stale total.
      await store.rollupDay(DAY, 101);
      expect((await store.rollups(org, DAY, DAY)).map((r) => r.quantity)).toEqual([3, 5]);
      await meter(org, "ai.generation", start + 120_000, 4);
      await store.rollupDay(DAY, 102);
      const rebuilt = await store.rollups(org, DAY, DAY);
      expect(rebuilt.map((r) => [r.kind, r.quantity, r.events])).toEqual([
        ["ai.generation", 7, 3],
        ["voice.minute", 5, 1],
      ]);
    });

    it("returns rollups only for the requested org and day range", async () => {
      const mine = await freshOrg();
      const theirs = await freshOrg();
      await meter(mine, "export", dayWindow(DAY).start, 1);
      await meter(theirs, "export", dayWindow(DAY).start, 1);
      await meter(mine, "export", dayWindow("2026-03-20").start, 1);
      await store.rollupDay(DAY, 200);
      await store.rollupDay("2026-03-20", 200);
      expect((await store.rollups(mine, DAY, DAY)).map((r) => r.orgId)).toEqual([mine]);
      expect((await store.rollups(mine, "2026-03-01", "2026-03-31")).map((r) => r.day)).toEqual([
        DAY,
        "2026-03-20",
      ]);
      expect(await store.rollups(mine, "2026-04-01", "2026-04-30")).toEqual([]);
    });
  });
}

describe("period helpers", () => {
  it("spans a UTC calendar month, half-open", () => {
    expect(monthWindow(MAR_15)).toEqual({ start: MAR_1, endExclusive: APR_1 });
    // The last instant of February is February's, and the first of March is not.
    expect(monthWindow(MAR_1 - 1).endExclusive).toBe(MAR_1);
    expect(monthWindow(MAR_1).start).toBe(MAR_1);
    // December rolls the year, which is the case a naive month+1 gets wrong.
    expect(monthWindow(Date.UTC(2026, 11, 31, 23, 59))).toEqual({
      start: Date.UTC(2026, 11, 1),
      endExclusive: Date.UTC(2027, 0, 1),
    });
  });

  it("keys days in UTC, so a rollup means the same thing in every timezone", () => {
    expect(utcDayKey(MAR_15)).toBe(DAY);
    expect(utcDayKey(dayWindow(DAY).start)).toBe(DAY);
    expect(utcDayKey(dayWindow(DAY).endExclusive)).toBe("2026-03-16");
    expect(dayWindow(DAY).endExclusive - dayWindow(DAY).start).toBe(86_400_000);
  });

  it("derives a stable event id from the act, and a fresh one otherwise", () => {
    // Same act, same id: this is what makes a retried request free.
    expect(usageEventId("org_1", "ai.generation", "req_9")).toBe(
      usageEventId("org_1", "ai.generation", "req_9"),
    );
    expect(usageEventId("org_1", "ai.generation", "req_9")).not.toBe(
      usageEventId("org_2", "ai.generation", "req_9"),
    );
    expect(usageEventId("org_1")).toMatch(/^use_[\w-]{32}$/);
    expect(newUsageEventId()).not.toBe(newUsageEventId());
  });

  it("prices the plans the catalogue seeds from", () => {
    // Guards the import the contract above relies on: seeding the ladder is
    // seeding every tier, not just the ones a test happens to name.
    expect(PLAN_LADDER.map((p) => p.code)).toEqual(Object.keys(PLANS));
  });
});
