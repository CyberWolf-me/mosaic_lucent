import { describe, expect, it } from "vitest";
import {
  DEFAULT_UPGRADE_URL,
  ENTITLING_STATUSES,
  METERED_KEYS,
  createEntitlements,
  statusEntitles,
  type Entitlements,
} from "../src/entitlements.js";
import {
  ENTITLEMENTS,
  ENTITLEMENT_KEYS,
  PLANS,
  PLAN_LADDER,
  type PlanLimits,
} from "../src/plans.js";
import {
  InMemoryUsageStore,
  USAGE_KINDS,
  newUsageEventId,
  type StoredSubscription,
  type SubscriptionStatus,
  type UsageKind,
} from "../src/usageStore.js";

/**
 * Entitlement resolution and the limit decision (M4.1).
 *
 * The store here is the real `InMemoryUsageStore` rather than a stub: the thing
 * worth testing is the whole path a gate takes -- subscription row, plan
 * resolution, month-to-date SUM, decision, refusal payload -- and a stub of the
 * source would let a wrong window or a mis-mapped meter pass.
 *
 * The clock is injected and fixed at 2026-03-15T12:00Z so "resets at the start
 * of next month" is an assertable number rather than an approximation.
 */

const NOW = Date.UTC(2026, 2, 15, 12, 0, 0);
const MAR_1 = Date.UTC(2026, 2, 1);
const APR_1 = Date.UTC(2026, 3, 1);
const FEB_20 = Date.UTC(2026, 1, 20);
const ORG = "org_ent";

interface Fixture {
  store: InMemoryUsageStore;
  ents: Entitlements;
}

/** An org with an optional subscription, and entitlements reading through it. */
async function fixture(
  over?: Partial<StoredSubscription>,
  options: { upgradeUrl?: string } = {},
): Promise<Fixture> {
  const store = new InMemoryUsageStore();
  await store.seedPlans(PLAN_LADDER, 1);
  if (over) {
    await store.putSubscription({
      orgId: ORG,
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
    });
  }
  const ents = createEntitlements({
    source: store,
    now: () => NOW,
    ...(options.upgradeUrl === undefined ? {} : { upgradeUrl: options.upgradeUrl }),
  });
  return { store, ents };
}

/** Record `n` events of `kind` at `at`, the way a gate's audit trail would. */
async function meter(
  store: InMemoryUsageStore,
  kind: UsageKind,
  at: number,
  n: number,
): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await store.record({ id: newUsageEventId() + i, orgId: ORG, kind, quantity: 1, at });
  }
}

describe("plan resolution", () => {
  it("falls back to Free for an org with no subscription", async () => {
    const { ents } = await fixture();
    const plan = await ents.plan(ORG);
    expect(plan.code).toBe("free");
    expect(plan.fallback).toBe(true);
    // No row at all, so there is no status to report: this is "never paid",
    // which the billing screen must not present as a payment failure.
    expect(plan.status).toBeNull();
    expect(plan.seats).toBe(1);
    const ai = await ents.entitlement(ORG, "ai.generationsPerMonth");
    expect(ai.limit).toBe(PLANS.free.limits["ai.generationsPerMonth"]);
    expect(ai.unlimited).toBe(false);
    expect(ai.period).toBe("month");
  });

  it("resolves the paid plan while the subscription entitles", async () => {
    for (const status of ENTITLING_STATUSES) {
      const { ents } = await fixture({ plan: "pro", status });
      const plan = await ents.plan(ORG);
      expect(plan.code).toBe("pro");
      expect(plan.fallback).toBe(false);
      expect(plan.status).toBe(status);
      expect(plan.periodEnd).toBe(APR_1);
      // docs/08 sells Pro as unlimited workspaces.
      expect((await ents.entitlement(ORG, "boards")).unlimited).toBe(true);
    }
    // past_due is deliberately still entitling: Stripe retries for days, and
    // cutting a paying customer off on the first decline manufactures churn.
    expect(statusEntitles("past_due")).toBe(true);
  });

  it("falls back to Free when the subscription has lapsed, but keeps the status", async () => {
    const lapsed: SubscriptionStatus[] = [
      "canceled",
      "unpaid",
      "incomplete",
      "incomplete_expired",
      "paused",
    ];
    for (const status of lapsed) {
      const { ents } = await fixture({ plan: "team", status, seats: 20 });
      const plan = await ents.plan(ORG);
      expect(plan.code).toBe("free");
      expect(plan.fallback).toBe(true);
      // The status is what turns "you are on Free" into "your payment failed".
      expect(plan.status).toBe(status);
      expect((await ents.entitlement(ORG, "boards")).limit).toBe(PLANS.free.limits.boards);
    }
  });

  it("collapses a pooled allowance with the org's paid seats", async () => {
    const perSeat = PLANS.team.limits["ai.generationsPerMonth"];
    expect(typeof perSeat === "object" && perSeat !== null).toBe(true);
    const each = (perSeat as { perSeat: number }).perSeat;

    const ten = await fixture({ plan: "team", seats: 10 });
    const ai = await ten.ents.entitlement(ORG, "ai.generationsPerMonth");
    expect(ai.limit).toBe(each * 10);
    expect(ai.seats).toBe(10);

    // A webhook race writing `seats: 0` must not entitle the org to nothing.
    const zero = await fixture({ plan: "team", seats: 0 });
    expect((await zero.ents.entitlement(ORG, "ai.generationsPerMonth")).limit).toBe(each);
  });
});

describe("contract plans", () => {
  /** A negotiated plan: limits that exist only as a row. */
  async function contract(limits: PlanLimits, code = "acme_2026"): Promise<Fixture> {
    const f = await fixture({ plan: code, status: "active", seats: 3 });
    await f.store.putPlan({
      code,
      displayName: "Acme",
      rank: 99,
      limits,
      priceCents: null,
      annualPriceCents: null,
      currency: "usd",
      stripePriceId: null,
      stripeAnnualPriceId: null,
      updatedAt: 1,
    });
    return f;
  }

  it("reads the negotiated limits from the catalogue row", async () => {
    const { ents } = await contract({ ...PLANS.team.limits, seats: 400 });
    const plan = await ents.plan(ORG);
    expect(plan.code).toBe("acme_2026");
    expect(plan.displayName).toBe("Acme");
    expect(plan.fallback).toBe(false);
    expect((await ents.entitlement(ORG, "seats")).limit).toBe(400);
  });

  it("falls back to Free when the plan code resolves to nothing", async () => {
    // Only reachable in memory: in Postgres `subscriptions.plan` is a foreign
    // key, which is exactly why the FK is there. The fallback still has to be
    // Free rather than a crash -- an unresolvable billing row is not an outage.
    const { ents } = await fixture({ plan: "ghost_plan", status: "active" });
    const plan = await ents.plan(ORG);
    expect(plan.code).toBe("free");
    expect(plan.fallback).toBe(true);
  });

  it("falls back to Free when a row's limits will not parse", async () => {
    // A row written by an older build, or edited during an incident. Failing
    // open here would hand out unlimited everything.
    const { ents } = await contract({ nonsense: true } as unknown as PlanLimits);
    expect((await ents.plan(ORG)).code).toBe("free");
    expect((await ents.entitlement(ORG, "boards")).limit).toBe(PLANS.free.limits.boards);
  });
});

describe("the limit boundary", () => {
  const cap = PLANS.free.limits["ai.generationsPerMonth"] as number;

  it("allows the request that reaches the cap and refuses the one past it", async () => {
    const { ents } = await fixture();
    const last = await ents.decide(ORG, "ai.generationsPerMonth", cap - 1);
    expect(last.allowed).toBe(true);
    expect(last.remaining).toBe(1);
    expect(last.refusal).toBeUndefined();

    const over = await ents.decide(ORG, "ai.generationsPerMonth", cap);
    expect(over.allowed).toBe(false);
    expect(over.remaining).toBe(0);
    expect(over.reason).toBe("plan_limit");
    expect(over.refusal).toBeDefined();
  });

  it("checks the total the request would produce, not the one before it", async () => {
    const { ents } = await fixture();
    // One generation left, two asked for: refused, because charging half a
    // batch is worse than refusing it.
    expect((await ents.decide(ORG, "ai.generationsPerMonth", cap - 1, 2)).allowed).toBe(false);
    expect((await ents.decide(ORG, "ai.generationsPerMonth", 0, cap)).allowed).toBe(true);
    expect((await ents.decide(ORG, "ai.generationsPerMonth", 0, cap + 1)).allowed).toBe(false);
    // amount 0 asks "am I already over?", which a dashboard needs and a gate
    // does not: at exactly the cap the answer is still no.
    expect((await ents.decide(ORG, "ai.generationsPerMonth", cap, 0)).allowed).toBe(true);
  });

  it("never refuses an unlimited limit", async () => {
    const { ents } = await fixture({ plan: "pro" });
    const decision = await ents.decide(ORG, "boards", 9_999);
    expect(decision.allowed).toBe(true);
    expect(decision.limit).toBeNull();
    expect(decision.remaining).toBeNull();
    expect(decision.refusal).toBeUndefined();
  });

  it("counts a standing limit from the count the caller supplies", async () => {
    // Boards and seats are live counts only the route can make; the entitlement
    // layer never guesses them.
    const { ents } = await fixture();
    const boards = PLANS.free.limits.boards as number;
    expect((await ents.decide(ORG, "boards", boards - 1)).allowed).toBe(true);
    expect((await ents.decide(ORG, "boards", boards)).allowed).toBe(false);
    // A standing limit does not come back at a month boundary, and saying so is
    // the difference between "wait" and "delete something".
    const refused = await ents.decide(ORG, "boards", boards);
    expect(refused.refusal!.body.resetsAt).toBeNull();
  });
});

describe("checkMonthly", () => {
  const cap = PLANS.free.limits["ai.generationsPerMonth"] as number;

  it("reads month-to-date usage itself, so a gate is one call", async () => {
    const { store, ents } = await fixture();
    await meter(store, "ai.generation", NOW, cap - 1);
    const allowed = await ents.checkMonthly(ORG, "ai.generationsPerMonth");
    expect(allowed.allowed).toBe(true);
    expect(allowed.used).toBe(cap - 1);
    expect(allowed.remaining).toBe(1);

    await meter(store, "ai.generation", NOW, 1);
    const refused = await ents.checkMonthly(ORG, "ai.generationsPerMonth");
    expect(refused.allowed).toBe(false);
    expect(refused.used).toBe(cap);
  });

  it("resets at the month boundary", async () => {
    const { store, ents } = await fixture();
    // A month's worth of usage, all of it last month.
    await meter(store, "ai.generation", FEB_20, cap + 10);
    const decision = await ents.checkMonthly(ORG, "ai.generationsPerMonth");
    expect(decision.allowed).toBe(true);
    expect(decision.used).toBe(0);
  });

  it("counts the meter that belongs to the key", async () => {
    const { store, ents } = await fixture({ plan: "team", seats: 2 });
    // Voice minutes are a quantity, not an event count: one 45-minute session.
    await store.record({
      id: "evt_voice",
      orgId: ORG,
      kind: "voice.minute",
      quantity: 45,
      at: NOW,
    });
    const decision = await ents.checkMonthly(ORG, "voice.minutes");
    expect(decision.used).toBe(45);
    const perSeat = PLANS.team.limits["voice.minutes"] as { perSeat: number };
    expect(decision.limit).toBe(perSeat.perSeat * 2);
    // Generations are a different meter and must not see the voice usage.
    expect((await ents.checkMonthly(ORG, "ai.generationsPerMonth")).used).toBe(0);
  });

  it("carries a ready-to-send 402 with the reason and the upgrade path", async () => {
    const { store, ents } = await fixture();
    await meter(store, "ai.generation", NOW, cap);
    const refusal = (await ents.checkMonthly(ORG, "ai.generationsPerMonth")).refusal!;
    expect(refusal.status).toBe(402);
    expect(refusal.body).toEqual({
      error: expect.stringContaining("Free"),
      reason: "plan_limit",
      key: "ai.generationsPerMonth",
      plan: "free",
      planName: "Free",
      limit: cap,
      used: cap,
      upgradeUrl: DEFAULT_UPGRADE_URL,
      suggestedPlan: "pro",
      // The allowance comes back at 00:00 UTC on the 1st, from the fixed clock.
      resetsAt: APR_1,
    });
    expect(refusal.body.error).toContain(String(cap));
    expect(refusal.body.error).toContain("Upgrade to Pro");
  });

  it("honours a deployment's own billing URL", async () => {
    const { store, ents } = await fixture(undefined, { upgradeUrl: "https://acme.test/billing" });
    await meter(store, "ai.generation", NOW, cap);
    const refusal = (await ents.checkMonthly(ORG, "ai.generationsPerMonth")).refusal!;
    expect(refusal.body.upgradeUrl).toBe("https://acme.test/billing");
  });
});

describe("checkFormat", () => {
  it("allows a format the plan lists and refuses one it does not", async () => {
    const { ents } = await fixture();
    expect(PLANS.free.limits["export.formats"]).toEqual(["png"]);
    expect((await ents.checkFormat(ORG, "png")).allowed).toBe(true);

    const refused = await ents.checkFormat(ORG, "svg");
    expect(refused.allowed).toBe(false);
    // A feature refusal is not a limit refusal: there is no number to show, and
    // waiting for the 1st will not help.
    expect(refused.reason).toBe("plan_feature");
    expect(refused.refusal!.status).toBe(402);
    expect(refused.refusal!.body.limit).toBeNull();
    expect(refused.refusal!.body.used).toBeNull();
    expect(refused.refusal!.body.resetsAt).toBeNull();
    expect(refused.refusal!.body.suggestedPlan).toBe("pro");
    expect(refused.refusal!.body.error).toContain("SVG export");
  });

  it("allows every format on a paid plan", async () => {
    const { ents } = await fixture({ plan: "pro" });
    for (const format of PLANS.pro.limits["export.formats"]) {
      expect((await ents.checkFormat(ORG, format)).allowed).toBe(true);
    }
  });
});

describe("what the customer reads", () => {
  it("agrees with itself about the count", async () => {
    // Free is one seat, and "1 seats" in the one place a customer is paying
    // attention is the kind of detail that reads as carelessness.
    const { ents } = await fixture();
    const refused = await ents.decide(ORG, "seats", 1);
    expect(refused.allowed).toBe(false);
    expect(refused.refusal!.body.error).toContain("1 seat.");
    expect(refused.refusal!.body.error).not.toContain("1 seats");
  });

  it("does not offer an upgrade that would not help", async () => {
    // A negotiated plan has no self-serve tier above it, so "upgrade" would be a
    // dead end and the honest next step is a conversation.
    const { store, ents } = await fixture({ plan: "acme_2026", status: "active", seats: 3 });
    await store.putPlan({
      code: "acme_2026",
      displayName: "Acme",
      rank: 99,
      limits: { ...PLANS.free.limits },
      priceCents: null,
      annualPriceCents: null,
      currency: "usd",
      stripePriceId: null,
      stripeAnnualPriceId: null,
      updatedAt: 1,
    });
    const refused = await ents.decide(ORG, "boards", 99);
    expect(refused.allowed).toBe(false);
    expect(refused.refusal!.body.suggestedPlan).toBeNull();
    expect(refused.refusal!.body.error).toContain("Contact support");
    expect(refused.refusal!.body.error).not.toContain("Upgrade");
  });

  it("says per month only for an allowance that resets", async () => {
    const { ents } = await fixture();
    const metered = await ents.decide(ORG, "ai.generationsPerMonth", 999);
    expect(metered.refusal!.body.error).toContain("per month");
    const standing = await ents.decide(ORG, "boards", 999);
    expect(standing.refusal!.body.error).not.toContain("per month");
  });
});

describe("METERED_KEYS", () => {
  it("maps every resetting allowance to exactly one real meter", async () => {
    // The mapping is what makes `checkMonthly` a single call. A key whose period
    // is "month" and which is absent here would have a limit nothing enforces.
    const monthly = ENTITLEMENT_KEYS.filter((k) => ENTITLEMENTS[k].period === "month");
    expect(Object.keys(METERED_KEYS).sort()).toEqual([...monthly].sort());
    for (const kind of Object.values(METERED_KEYS)) {
      expect([...USAGE_KINDS]).toContain(kind);
    }
    // Distinct meters: two keys sharing one would double-count each other.
    const kinds = Object.values(METERED_KEYS);
    expect(new Set(kinds).size).toBe(kinds.length);
  });
});
