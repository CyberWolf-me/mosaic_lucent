import { describe, expect, it } from "vitest";
import {
  ENTITLEMENTS,
  ENTITLEMENT_KEYS,
  EXPORT_FORMATS,
  FREE_PLAN,
  PLANS,
  PLAN_CODES,
  PLAN_LADDER,
  isPlanCode,
  parsePlanLimits,
  planDefinition,
  resolveLimit,
  suggestedUpgrade,
  type EntitlementKey,
  type NumericEntitlementKey,
  type PlanCode,
  type PlanLimits,
} from "../src/plans.js";

/**
 * The tier table (M4.1).
 *
 * These tests are the guard on the one file that holds every sellable number.
 * They do not assert that Pro is 1,000 generations -- pricing is allowed to
 * change without a test edit -- they assert the properties that must survive any
 * such change: every tier answers every key, the ladder never gets *worse* as it
 * gets more expensive, the prices stay inside the ranges docs/08 commits to, and
 * a limit set survives the JSONB round trip into the `plans` table.
 */

/** A limit as a comparable size, with unlimited as the top. */
function score(limit: PlanLimits[EntitlementKey]): number {
  if (limit === null) return Number.POSITIVE_INFINITY;
  if (typeof limit === "number") return limit;
  if ("perSeat" in limit) return limit.perSeat;
  return limit.length;
}

const numericKeys = ENTITLEMENT_KEYS.filter(
  (k): k is NumericEntitlementKey => k !== "export.formats",
);

describe("plan table", () => {
  it("resolves every entitlement key for every tier", () => {
    for (const code of PLAN_CODES) {
      const plan = PLANS[code];
      expect(plan.code).toBe(code);
      for (const key of ENTITLEMENT_KEYS) {
        // `in` rather than a truthiness check: `null` and `0` are both real
        // answers, and a missing key is the failure being tested for.
        expect(key in plan.limits).toBe(true);
      }
      for (const key of numericKeys) {
        const limit = resolveLimit(plan.limits[key], 1);
        expect(limit === null || (Number.isInteger(limit) && limit >= 0)).toBe(true);
      }
      const formats = plan.limits["export.formats"];
      expect(formats.length).toBeGreaterThan(0);
      for (const format of formats) expect(EXPORT_FORMATS).toContain(format);
    }
  });

  it("describes every key, and lists exactly the keys the type has", () => {
    const described = Object.keys(ENTITLEMENTS) as EntitlementKey[];
    expect([...ENTITLEMENT_KEYS].sort()).toEqual(described.sort());
    for (const key of ENTITLEMENT_KEYS) expect(ENTITLEMENTS[key].key).toBe(key);
  });

  it("never lowers a limit as the ladder gets more expensive", () => {
    for (const key of numericKeys) {
      for (let i = 1; i < PLAN_LADDER.length; i += 1) {
        const lower = PLAN_LADDER[i - 1]!;
        const upper = PLAN_LADDER[i]!;
        expect(score(upper.limits[key])).toBeGreaterThanOrEqual(score(lower.limits[key]));
      }
    }
    // Export formats are a set, so "not worse" means a superset.
    for (let i = 1; i < PLAN_LADDER.length; i += 1) {
      const lower = PLAN_LADDER[i - 1]!.limits["export.formats"];
      const upper = PLAN_LADDER[i]!.limits["export.formats"];
      for (const format of lower) expect(upper).toContain(format);
    }
  });

  it("orders the ladder by a strictly increasing rank", () => {
    for (let i = 1; i < PLAN_LADDER.length; i += 1) {
      expect(PLAN_LADDER[i]!.rank).toBeGreaterThan(PLAN_LADDER[i - 1]!.rank);
    }
    expect(FREE_PLAN.code).toBe("free");
    expect(FREE_PLAN.rank).toBe(0);
  });
});

describe("prices", () => {
  it("stays inside the ranges docs/08 commits to", () => {
    expect(PLANS.free.priceCents).toBe(0);
    // docs/08: Pro is ~$12-25/user/month, Team ~$20-40/user/month. A pricing
    // change is fine; leaving the documented range is a product decision that
    // should not pass silently.
    const pro = PLANS.pro.priceCents! / 100;
    expect(pro).toBeGreaterThanOrEqual(12);
    expect(pro).toBeLessThanOrEqual(25);
    const team = PLANS.team.priceCents! / 100;
    expect(team).toBeGreaterThanOrEqual(20);
    expect(team).toBeLessThanOrEqual(40);
    expect(team).toBeGreaterThan(pro);
    // docs/08: Enterprise is custom pricing, which renders as "contact us".
    expect(PLANS.enterprise.priceCents).toBeNull();
    expect(PLANS.enterprise.annualPriceCents).toBeNull();
  });

  it("discounts annual against monthly", () => {
    for (const code of ["pro", "team"] as const) {
      const plan = PLANS[code];
      expect(plan.annualPriceCents!).toBeLessThan(plan.priceCents! * 12);
    }
  });
});

describe("resolveLimit", () => {
  it("passes flat numbers and unlimited through untouched", () => {
    expect(resolveLimit(50, 9)).toBe(50);
    expect(resolveLimit(null, 9)).toBeNull();
    expect(resolveLimit(0, 3)).toBe(0);
  });

  it("scales a pooled allowance by paid seats", () => {
    expect(resolveLimit({ perSeat: 1_500 }, 10)).toBe(15_000);
    expect(resolveLimit({ perSeat: 1_500 }, 1)).toBe(1_500);
  });

  it("floors seats at one, so a bad seat count cannot zero an allowance", () => {
    // A webhook race or a bad backfill writing `seats: 0` must not turn every
    // request into a 402.
    expect(resolveLimit({ perSeat: 600 }, 0)).toBe(600);
    expect(resolveLimit({ perSeat: 600 }, -4)).toBe(600);
    expect(resolveLimit({ perSeat: 600 }, 2.7)).toBe(1_200);
  });
});

describe("suggestedUpgrade", () => {
  it("names the cheapest tier that actually raises the limit", () => {
    expect(suggestedUpgrade("free", "ai.generationsPerMonth")).toBe("pro");
    expect(suggestedUpgrade("free", "boards")).toBe("pro");
    // Pro is single-seat, so more people is a Team question, not a Pro one.
    expect(suggestedUpgrade("pro", "seats")).toBe("team");
    expect(suggestedUpgrade("team", "seats")).toBe("enterprise");
  });

  it("returns null when no tier above would help", () => {
    // Pro boards are already unlimited: "upgrade for more boards" would be a lie.
    expect(suggestedUpgrade("pro", "boards")).toBeNull();
    expect(suggestedUpgrade("team", "boards")).toBeNull();
    for (const key of ENTITLEMENT_KEYS) {
      expect(suggestedUpgrade("enterprise", key)).toBeNull();
    }
  });

  it("returns null for a plan code it does not know", () => {
    // A negotiated contract plan has no self-serve upgrade path.
    expect(suggestedUpgrade("acme_2026", "ai.generationsPerMonth")).toBeNull();
  });
});

describe("plan codes", () => {
  it("recognises the built-in tiers and nothing else", () => {
    for (const code of PLAN_CODES) {
      expect(isPlanCode(code)).toBe(true);
      expect(planDefinition(code)).toBe(PLANS[code as PlanCode]);
    }
    expect(isPlanCode("acme_2026")).toBe(false);
    expect(planDefinition("acme_2026")).toBeUndefined();
  });
});

describe("parsePlanLimits", () => {
  it("round-trips every tier through JSONB", () => {
    for (const code of PLAN_CODES) {
      // What `seedPlans` writes and `plan()` reads back: a JSON round trip.
      const raw: unknown = JSON.parse(JSON.stringify(PLANS[code].limits));
      expect(parsePlanLimits(raw)).toEqual(PLANS[code].limits);
    }
  });

  it("rejects a row that cannot be trusted rather than failing open", () => {
    const good: unknown = JSON.parse(JSON.stringify(PLANS.team.limits));
    expect(parsePlanLimits(good)).toBeTruthy();

    const missingKey = { ...(good as Record<string, unknown>) };
    delete missingKey.seats;
    expect(parsePlanLimits(missingKey)).toBeUndefined();

    expect(parsePlanLimits({ ...(good as object), boards: -1 })).toBeUndefined();
    expect(parsePlanLimits({ ...(good as object), boards: { perSeat: 0 } })).toBeUndefined();
    expect(parsePlanLimits({ ...(good as object), "export.formats": ["docx"] })).toBeUndefined();
    expect(parsePlanLimits(undefined)).toBeUndefined();
    expect(parsePlanLimits("free")).toBeUndefined();
  });
});
