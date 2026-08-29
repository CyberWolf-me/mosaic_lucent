import {
  ENTITLEMENTS,
  FREE_PLAN,
  PLANS,
  parsePlanLimits,
  planDefinition,
  resolveLimit,
  suggestedUpgrade,
  type EntitlementKey,
  type ExportFormat,
  type LimitPeriod,
  type NumericEntitlementKey,
  type PlanCode,
  type PlanLimits,
} from "./plans.js";
import {
  monthWindow,
  type StoredPlan,
  type StoredSubscription,
  type SubscriptionStatus,
  type UsageKind,
} from "./usageStore.js";

/**
 * Entitlement resolution (M4.1). The one question every gate asks: "may this org
 * do this, and if not, what do we tell them?"
 *
 * Resolution order is `subscriptions` -> `plans` -> Free:
 *
 *   1. the org's subscription row, if it exists and its status still entitles;
 *   2. the plan the row names -- from `PLANS` when it is a built-in tier, from
 *      the `plans` table's `limits` JSONB when it is a contract code the code
 *      does not know about;
 *   3. the Free tier, for an org with no subscription, a subscription that has
 *      lapsed, or a plan code that resolves to nothing.
 *
 * Every step falls back rather than throwing. An org with a corrupt billing row
 * gets Free, not a 500: degrading to the free tier is a product decision the
 * customer can see and dispute, whereas an exception is an outage.
 *
 * Nothing here reads a limit from anywhere but plans.ts, and nothing here
 * decides *when* to charge -- gates call it, Stripe bills, and the two meet at
 * the subscription row.
 */

/**
 * Statuses that still entitle an org to its paid plan.
 *
 * `past_due` is included on purpose: Stripe retries a failed payment for days,
 * and cutting a paying customer off on the first decline is how you turn a
 * expired card into a churn event. `unpaid` (dunning exhausted), `canceled`,
 * `paused` and the `incomplete*` states (checkout never finished) all fall back
 * to Free.
 */
export const ENTITLING_STATUSES = [
  "trialing",
  "active",
  "past_due",
] as const satisfies readonly SubscriptionStatus[];

export function statusEntitles(status: SubscriptionStatus): boolean {
  return (ENTITLING_STATUSES as readonly SubscriptionStatus[]).includes(status);
}

/**
 * Which meter answers which metered limit. The only place the two vocabularies
 * meet: limits are what we sell (`ai.generationsPerMonth`), usage kinds are what
 * we record (`ai.generation`).
 */
export const METERED_KEYS = {
  "ai.generationsPerMonth": "ai.generation",
  "voice.minutes": "voice.minute",
} as const satisfies Partial<Record<NumericEntitlementKey, UsageKind>>;

export type MeteredEntitlementKey = keyof typeof METERED_KEYS;

/**
 * The narrow slice of `UsageStore` this module needs. Declared here rather than
 * importing the store interface so a gate can be tested against three stub
 * methods, and so nothing in the entitlement path can reach for the write side
 * of metering.
 */
export interface EntitlementSource {
  subscription(orgId: string): Promise<StoredSubscription | undefined>;
  plan(code: string): Promise<StoredPlan | undefined>;
  monthToDate(orgId: string, kind: UsageKind, now: number): Promise<number>;
}

/** What an org is actually on, after fallbacks. */
export interface ResolvedPlan {
  /** The effective plan code: a built-in tier, a contract code, or `free`. */
  code: string;
  displayName: string;
  limits: PlanLimits;
  /** Paid seats; 1 when there is no subscription. Scales pooled allowances. */
  seats: number;
  /** The subscription's status, or null when the org has no subscription. */
  status: SubscriptionStatus | null;
  /**
   * True when the paid plan did *not* apply -- no row, a lapsed status, or an
   * unresolvable code. The UI needs this to distinguish "you are on Free" from
   * "your payment failed and you are being treated as Free".
   */
  fallback: boolean;
  /** End of the Stripe billing period, when there is one. */
  periodEnd: number | null;
}

/** A numeric cap, already collapsed for this org's seat count. */
export interface NumericEntitlement {
  key: NumericEntitlementKey;
  plan: string;
  planName: string;
  /** The ceiling, or null for unlimited. */
  limit: number | null;
  unlimited: boolean;
  period: LimitPeriod;
  seats: number;
}

/** A set-valued entitlement. Today only `export.formats`. */
export interface SetEntitlement {
  key: "export.formats";
  plan: string;
  planName: string;
  formats: readonly ExportFormat[];
}

export type EntitlementFor<K extends EntitlementKey> = K extends NumericEntitlementKey
  ? NumericEntitlement
  : SetEntitlement;

/**
 * Why a refusal happened. Two distinct product situations, and a customer reads
 * them differently:
 *
 *  - `plan_limit`   -- the tier includes this, and the org has used it up;
 *  - `plan_feature` -- the tier does not include this at all.
 */
export type RefusalReason = "plan_limit" | "plan_feature";

/**
 * The body a gate sends on refusal. Assembled here, not by the caller: a route
 * that has to build `{ reason, upgradeUrl }` itself is a route that will get the
 * wording, the suggested tier or the reset time wrong, and those strings are the
 * upgrade prompt the whole tier system exists to produce.
 */
export interface RefusalBody {
  /** One human sentence, safe to render as-is. */
  error: string;
  reason: RefusalReason;
  key: EntitlementKey;
  plan: string;
  planName: string;
  /** The ceiling that was hit; null for a feature refusal. */
  limit: number | null;
  used: number | null;
  /** Where the client should send them. Deployment config, not a constant. */
  upgradeUrl: string;
  /** The cheapest tier that raises this limit, or null when sales must be involved. */
  suggestedPlan: PlanCode | null;
  /** When a metered allowance comes back (epoch ms); null for standing limits. */
  resetsAt: number | null;
}

/** A ready-to-send refusal: `res.writeHead(status)` plus `body` as JSON. */
export interface EntitlementRefusal {
  /**
   * 402 Payment Required. Deliberately not 403: the request is authorised, the
   * plan is what is missing, and the client's error mapping needs to tell a
   * permission problem (ask your admin) from a billing one (upgrade).
   */
  status: 402;
  body: RefusalBody;
}

/**
 * The answer to "is this org over its limit". `allowed` and `reason` mirror
 * `UsageDecision` in usage.ts so the request path reads the same either way.
 */
export interface EntitlementDecision {
  allowed: boolean;
  key: EntitlementKey;
  plan: string;
  /** The ceiling in effect, or null for unlimited. */
  limit: number | null;
  /** Usage counted against the limit before this request. */
  used: number;
  /** Allowance left before this request is counted; null when unlimited. */
  remaining: number | null;
  reason?: RefusalReason;
  /** Present exactly when `allowed` is false. */
  refusal?: EntitlementRefusal;
}

/**
 * The same answer for a set-valued entitlement, where there is no count to
 * report. A route that only reads `allowed` and `refusal` can take either.
 */
export type FeatureDecision = Omit<EntitlementDecision, "limit" | "used" | "remaining">;

/**
 * How much of an allowance has to be spent before the client is told it is
 * nearly out. Mirrors `WARN_FRACTION` in `packages/web/src/billing.ts`, which is
 * where the settings meter turns amber -- repeated rather than shared because the
 * browser bundle does not depend on this package. The two disagreeing would mean
 * a request path that warns while Preferences shows a calm meter for the same
 * org, and the customer would be right to believe the calmer one.
 */
export const WARN_FRACTION = 0.8;

/**
 * What is left of a metered allowance after a request the gate *allowed* (M4).
 *
 * A refusal carries limit/used in its own body, so this is only for the other
 * side: the soft limit. Counted *including* the request being answered, because
 * the meter row the settings pane will draw a moment later includes it too, and
 * two numbers that disagree by one read as a bug in the one place a customer is
 * being asked to trust our accounting.
 */
export interface AllowanceHint {
  key: EntitlementKey;
  /** The ceiling in effect, or null when the plan has none. */
  limit: number | null;
  /** Usage against it including this request. */
  used: number;
  /** What is left after this request; null when unlimited. */
  remaining: number | null;
  /** True once `WARN_FRACTION` of the ceiling is spent. */
  warn: boolean;
  /** When the allowance comes back (epoch ms). */
  resetsAt: number | null;
}

/**
 * Turn an allowed decision into the hint. `amount` is what the request spends,
 * so `used` and `remaining` move by it: the decision reports the state *before*
 * the call, which is the wrong number to show someone who has just made it.
 *
 * Only ever built for a metered key, so the reset is always the end of the usage
 * month -- the same window `monthWindow` counts in and `refuseLimit` quotes.
 */
export function allowanceHint(
  decision: EntitlementDecision,
  amount = 1,
  now: () => number = Date.now,
): AllowanceHint {
  const { limit } = decision;
  const used = decision.used + amount;
  // Clamped: an overshoot from concurrent requests is real (see the gate) and
  // "-2 left" is not a sentence any client should have to render.
  const remaining = limit === null ? null : Math.max(0, limit - used);
  return {
    key: decision.key,
    limit,
    used,
    remaining,
    warn: limit !== null && (limit === 0 || used / limit >= WARN_FRACTION),
    resetsAt: monthWindow(now()).endExclusive,
  };
}

/**
 * Where the client sends someone who needs to upgrade. A path, not an absolute
 * URL, so it works in dev, behind the Vite proxy and in production alike;
 * overridable because a deployment may host billing elsewhere.
 */
export const DEFAULT_UPGRADE_URL = "/settings/billing";

export interface EntitlementsOptions {
  source: EntitlementSource;
  upgradeUrl?: string;
  /** Injected clock, so month-boundary behaviour is testable. */
  now?: () => number;
}

export interface Entitlements {
  /** What the org is on, after fallbacks. For the billing screen. */
  plan(orgId: string): Promise<ResolvedPlan>;
  /** One limit, collapsed for this org's seats. Typed by the key. */
  entitlement<K extends EntitlementKey>(orgId: string, key: K): Promise<EntitlementFor<K>>;
  /**
   * Is this org over its limit for `key`, given `used` so far? The general form:
   * the caller supplies the count, which for a standing limit is a live query
   * (boards in the org, members, stored bytes) that only the caller can make.
   * `amount` is what this request would add, so the boundary is checked against
   * the *resulting* total rather than the current one.
   */
  decide(
    orgId: string,
    key: NumericEntitlementKey,
    used: number,
    amount?: number,
  ): Promise<EntitlementDecision>;
  /**
   * `decide` for a metered key, reading month-to-date usage itself: one call is
   * the whole gate, which is what keeps the wiring in a route to two lines.
   */
  checkMonthly(
    orgId: string,
    key: MeteredEntitlementKey,
    amount?: number,
  ): Promise<EntitlementDecision>;
  /** May this org export in this format? */
  checkFormat(orgId: string, format: ExportFormat): Promise<FeatureDecision>;
}

export function createEntitlements(options: EntitlementsOptions): Entitlements {
  const { source } = options;
  const upgradeUrl = options.upgradeUrl ?? DEFAULT_UPGRADE_URL;
  const clock = options.now ?? Date.now;

  async function resolvePlan(orgId: string): Promise<ResolvedPlan> {
    const sub = await source.subscription(orgId);
    if (!sub) return freeFallback(null);
    if (!statusEntitles(sub.status)) return freeFallback(sub);
    const seats = Math.max(1, Math.floor(sub.seats));

    const builtIn = planDefinition(sub.plan);
    if (builtIn) {
      // plans.ts wins over the catalogue row for a tier the code knows: the row
      // is a projection, and a stale one must not quietly change what Pro is.
      return {
        code: builtIn.code,
        displayName: builtIn.displayName,
        limits: builtIn.limits,
        seats,
        status: sub.status,
        fallback: false,
        periodEnd: sub.periodEnd,
      };
    }

    // A contract code: the row's JSONB is the only record of what was agreed, so
    // it is read -- and parsed, because it is data, not code.
    const row = await source.plan(sub.plan);
    const limits = row ? parsePlanLimits(row.limits) : undefined;
    if (!row || !limits) {
      console.warn(
        "[lucent] org " + orgId + " is on unresolvable plan " + sub.plan + "; treating as free",
      );
      return freeFallback(sub);
    }
    return {
      code: row.code,
      displayName: row.displayName,
      limits,
      seats,
      status: sub.status,
      fallback: false,
      periodEnd: sub.periodEnd,
    };
  }

  /**
   * Free, as the answer to a missing or lapsed subscription. `status` carries
   * the lapsed subscription's own status when there was one, which is how the
   * billing screen distinguishes "never paid" from "card declined".
   */
  function freeFallback(sub: StoredSubscription | null): ResolvedPlan {
    return {
      code: FREE_PLAN.code,
      displayName: FREE_PLAN.displayName,
      limits: FREE_PLAN.limits,
      seats: 1,
      status: sub?.status ?? null,
      fallback: true,
      periodEnd: sub?.periodEnd ?? null,
    };
  }

  async function entitlement<K extends EntitlementKey>(
    orgId: string,
    key: K,
  ): Promise<EntitlementFor<K>> {
    const resolved = await resolvePlan(orgId);
    if (key === "export.formats") {
      const set: SetEntitlement = {
        key: "export.formats",
        plan: resolved.code,
        planName: resolved.displayName,
        formats: resolved.limits["export.formats"],
      };
      // The cast is the cost of a conditional return type: the compiler cannot
      // see that this runtime branch is the one the type-level branch picked.
      return set as EntitlementFor<K>;
    }
    const numericKey = key as NumericEntitlementKey;
    const limit = resolveLimit(resolved.limits[numericKey], resolved.seats);
    const value: NumericEntitlement = {
      key: numericKey,
      plan: resolved.code,
      planName: resolved.displayName,
      limit,
      unlimited: limit === null,
      period: ENTITLEMENTS[numericKey].period,
      seats: resolved.seats,
    };
    return value as EntitlementFor<K>;
  }

  async function decide(
    orgId: string,
    key: NumericEntitlementKey,
    used: number,
    amount = 1,
  ): Promise<EntitlementDecision> {
    const resolved = await resolvePlan(orgId);
    const limit = resolveLimit(resolved.limits[key], resolved.seats);
    if (limit === null) {
      return { allowed: true, key, plan: resolved.code, limit: null, used, remaining: null };
    }
    const allowed = used + amount <= limit;
    const remaining = Math.max(0, limit - used);
    if (allowed) {
      return { allowed: true, key, plan: resolved.code, limit, used, remaining };
    }
    return {
      allowed: false,
      key,
      plan: resolved.code,
      limit,
      used,
      remaining,
      reason: "plan_limit",
      refusal: refuseLimit(resolved, key, limit, used),
    };
  }

  async function checkMonthly(
    orgId: string,
    key: MeteredEntitlementKey,
    amount = 1,
  ): Promise<EntitlementDecision> {
    const used = await source.monthToDate(orgId, METERED_KEYS[key], clock());
    return decide(orgId, key, used, amount);
  }

  async function checkFormat(orgId: string, format: ExportFormat): Promise<FeatureDecision> {
    const resolved = await resolvePlan(orgId);
    const allowed = resolved.limits["export.formats"].includes(format);
    if (allowed) return { allowed: true, key: "export.formats", plan: resolved.code };
    return {
      allowed: false,
      key: "export.formats",
      plan: resolved.code,
      reason: "plan_feature",
      refusal: refuseFeature(resolved, "export.formats", format.toUpperCase() + " export"),
    };
  }

  function refuseLimit(
    resolved: ResolvedPlan,
    key: NumericEntitlementKey,
    limit: number,
    used: number,
  ): EntitlementRefusal {
    const meta = ENTITLEMENTS[key];
    const per = meta.period === "month" ? " per month" : "";
    const suggested = suggestedUpgrade(resolved.code, key);
    return {
      status: 402,
      body: {
        error:
          "Your " +
          resolved.displayName +
          " plan includes " +
          limit.toLocaleString("en-US") +
          " " +
          countLabel(limit, meta.label) +
          per +
          ". " +
          upgradeSentence(suggested),
        reason: "plan_limit",
        key,
        plan: resolved.code,
        planName: resolved.displayName,
        limit,
        used,
        upgradeUrl,
        suggestedPlan: suggested,
        // A metered allowance comes back at the month boundary; a standing limit
        // never does, and saying so is the difference between "wait" and "act".
        resetsAt: meta.period === "month" ? monthWindow(clock()).endExclusive : null,
      },
    };
  }

  function refuseFeature(
    resolved: ResolvedPlan,
    key: EntitlementKey,
    what: string,
  ): EntitlementRefusal {
    const suggested = suggestedUpgrade(resolved.code, key);
    return {
      status: 402,
      body: {
        error:
          "The " +
          resolved.displayName +
          " plan does not include " +
          what +
          ". " +
          upgradeSentence(suggested),
        reason: "plan_feature",
        key,
        plan: resolved.code,
        planName: resolved.displayName,
        limit: null,
        used: null,
        upgradeUrl,
        suggestedPlan: suggested,
        resetsAt: null,
      },
    };
  }

  return { plan: resolvePlan, entitlement, decide, checkMonthly, checkFormat };
}
/**
 * The upgrade half of a refusal sentence. When there is nothing above the org's
 * tier that raises this limit, saying "upgrade" is a dead end -- the honest next
 * step is a conversation.
 */
function upgradeSentence(suggested: PlanCode | null): string {
  if (!suggested) return "Contact support to raise this limit.";
  return "Upgrade to " + PLANS[suggested].displayName + " to continue.";
}

/**
 * Labels are stored plural because that is the common case; a limit of exactly
 * one would otherwise read "1 seats" in the one place a customer is paying
 * attention.
 */
function countLabel(n: number, label: string): string {
  if (n !== 1) return label;
  return label.endsWith("s") ? label.slice(0, -1) : label;
}
