import { createHash, randomBytes } from "node:crypto";
import type { PlanDefinition, PlanLimits } from "./plans.js";

/**
 * Billing state and metering storage (M4.1, M4.2).
 *
 * Same shape as the rest of the persistence layer (`boards.ts`, `orgs.ts`): an
 * interface, an in-memory implementation that is the whole story for offline
 * dev and tests, and a Postgres implementation in `store/pg-usage.ts` behind
 * the identical contract, exercised by the same test suite.
 *
 * The metering half deliberately keeps `usage.ts`'s shape recognisable -- a
 * store that records an act, and a decision object carrying `allowed` plus a
 * reason -- because the request path already thinks in those terms. What
 * differs is where the numbers come from: `usage.ts` enforces per-process rate
 * limits from env vars, this records durable per-org usage that a plan limit is
 * compared against. They answer different questions (abuse vs entitlement) and
 * neither replaces the other.
 */

/**
 * Stripe's subscription status vocabulary, verbatim, mirroring the column enum
 * in `db/schema.ts` so a webhook can be written straight through. Which of
 * these still entitles the org is `ENTITLING_STATUSES` in entitlements.ts.
 *
 * A literal union rather than one derived from the Drizzle table, so this module
 * stays independent of the pg schema; the Postgres store's insert is typed by
 * the column, so the two cannot drift without a typecheck failure.
 */
export type SubscriptionStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "unpaid"
  | "incomplete"
  | "incomplete_expired"
  | "paused";

/** One org's billing state. `plan` is a plan code, built-in or contract. */
export interface StoredSubscription {
  orgId: string;
  plan: string;
  /** Paid seats. Pooled per-seat allowances are multiplied by this. */
  seats: number;
  status: SubscriptionStatus;
  periodStart: number | null;
  periodEnd: number | null;
  cancelAt: number | null;
  trialEndsAt: number | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * A row of the plan catalogue. For the four built-in tiers this is a projection
 * of `PLANS`; for a contract code it is the only place the negotiated limits
 * exist, which is why `limits` is parsed on read rather than trusted.
 */
export interface StoredPlan {
  code: string;
  displayName: string;
  rank: number;
  limits: PlanLimits;
  priceCents: number | null;
  annualPriceCents: number | null;
  currency: string;
  stripePriceId: string | null;
  stripeAnnualPriceId: string | null;
  updatedAt: number;
}

/**
 * The well-known meters. The column is free text, so adding a meter is a change
 * here and nowhere else -- no migration, no enum to widen. The union exists so a
 * call site cannot invent `"ai.generations"` and silently record into a bucket
 * that nothing reads.
 */
export const USAGE_KINDS = [
  "ai.generation",
  "image.generation",
  "voice.minute",
  "export",
  "storage.bytes",
] as const;
export type UsageKind = (typeof USAGE_KINDS)[number];

/** One billable act. `id` is the idempotency key (see `record`). */
export interface UsageEvent {
  id: string;
  orgId: string;
  kind: UsageKind;
  /** Whole units. 1 at the call sites that count occurrences. */
  quantity: number;
  at: number;
  /** Free-form context for reconciliation: board id, model, request id. */
  metadata?: unknown;
}

/** One derived day/kind total for an org. */
export interface UsageRollup {
  orgId: string;
  /** UTC `YYYY-MM-DD`. */
  day: string;
  kind: string;
  quantity: number;
  /** Source events behind `quantity`, so a total can be reconciled. */
  events: number;
  updatedAt: number;
}

/** A half-open range of epoch ms: `start` included, `endExclusive` not. */
export interface Period {
  start: number;
  endExclusive: number;
}

/**
 * The UTC calendar month containing `at`. Metered limits reset on the 1st at
 * 00:00 UTC rather than on the subscription's anniversary: an allowance has to
 * be computable without reading a billing period, or a Free org -- which has no
 * period at all -- would have no window. Stripe's period still drives invoicing.
 */
export function monthWindow(at: number): Period {
  const d = new Date(at);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const endExclusive = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return { start, endExclusive };
}

/** UTC calendar day key, `YYYY-MM-DD`: the `usage_rollups.day` format. */
export function utcDayKey(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** Midnight UTC on `day` (`YYYY-MM-DD`), as epoch ms. */
export function dayStart(day: string): number {
  return Date.parse(day + "T00:00:00.000Z");
}

/** One UTC day as a range. */
export function dayWindow(day: string): Period {
  const start = dayStart(day);
  return { start, endExclusive: start + 86_400_000 };
}

/** A random event id, for acts with nothing stable to derive one from. */
export function newUsageEventId(): string {
  return "use_" + Date.now().toString(36) + randomBytes(6).toString("hex");
}

/**
 * A deterministic event id, so a retried request bills once. The parts should
 * identify the act (org, kind, request id, or board plus turn) and must not
 * include a timestamp; they are hashed rather than joined so a caller cannot
 * blow past the column with a long board name.
 */
export function usageEventId(...parts: readonly string[]): string {
  const hash = createHash("sha256").update(parts.join(" ")).digest("base64url");
  return "use_" + hash.slice(0, 32);
}

export interface UsageStore {
  /**
   * Write the built-in tiers into the catalogue, idempotently. Called at boot:
   * `subscriptions.plan` is a foreign key, so a checkout for a tier the
   * catalogue never heard of has to fail at the FK rather than leave an org on a
   * plan nobody can resolve. Codes absent from `defs` are left alone, because
   * that is where contract plans live.
   */
  seedPlans(defs: readonly PlanDefinition[], now: number): Promise<void>;
  /** One catalogue row, or undefined for a code that was never seeded. */
  plan(code: string): Promise<StoredPlan | undefined>;
  /** The whole catalogue, cheapest first, for the pricing and admin views. */
  plans(): Promise<StoredPlan[]>;
  /**
   * Write one catalogue row outright, Stripe ids included. Two things need this
   * and `seedPlans` cannot do either: an operator attaching the deployment's
   * Stripe price to a tier, and a negotiated contract plan, whose limits exist
   * nowhere in the code and so can only arrive as data.
   */
  putPlan(plan: StoredPlan): Promise<void>;

  subscription(orgId: string): Promise<StoredSubscription | undefined>;
  /** Insert or replace an org's billing state. One row per org, always. */
  putSubscription(sub: StoredSubscription): Promise<void>;
  /**
   * Resolve an org from a Stripe id, which is all a webhook has to go on. Both
   * id columns are unique, so this can never be ambiguous.
   */
  subscriptionByStripeId(
    kind: "customer" | "subscription",
    id: string,
  ): Promise<StoredSubscription | undefined>;

  /**
   * Record one billable act. Returns false when this `id` was already stored,
   * so a retry costs nothing instead of billing twice. Recording must never be
   * the reason a request fails: callers log a rejection and continue.
   */
  record(event: UsageEvent): Promise<boolean>;
  /** Summed quantity over `[from, toExclusive)`: the number a gate compares. */
  total(orgId: string, kind: UsageKind, period: Period): Promise<number>;
  /** `total` over the UTC month containing `now`, the metered-limit window. */
  monthToDate(orgId: string, kind: UsageKind, now: number): Promise<number>;
  /**
   * Every kind at once over one window, so the usage panel and the invoice
   * preview are a single query rather than one per meter. Kinds with no events
   * are absent rather than zero.
   */
  totalsByKind(orgId: string, period: Period): Promise<Record<string, number>>;

  /**
   * Recompute one UTC day's rollups from the events, replacing whatever was
   * there. Idempotent and safe to re-run over any past day, which is the point
   * of keeping rollups derived: a metering bug is fixed by rebuilding rather
   * than by reconstructing a counter. Returns the number of rows written.
   */
  rollupDay(day: string, now: number): Promise<number>;
  /** One org's rollups over an inclusive day range, oldest first. */
  rollups(orgId: string, fromDay: string, toDay: string): Promise<UsageRollup[]>;
}

/**
 * Process-local store: correct for single-instance dev and the default in tests.
 * Sums on read exactly as the SQL does, so a test that passes here is testing
 * the same arithmetic the Postgres store performs.
 */
export class InMemoryUsageStore implements UsageStore {
  private readonly planRows = new Map<string, StoredPlan>();
  private readonly subs = new Map<string, StoredSubscription>();
  /** Keyed by event id, which is what makes `record` idempotent. */
  private readonly events = new Map<string, UsageEvent>();
  /** Keyed by org, day and kind joined by a space, mirroring the table's PK. */
  private readonly rollupRows = new Map<string, UsageRollup>();

  async seedPlans(defs: readonly PlanDefinition[], now: number): Promise<void> {
    for (const def of defs) {
      const existing = this.planRows.get(def.code);
      this.planRows.set(def.code, {
        code: def.code,
        displayName: def.displayName,
        rank: def.rank,
        limits: def.limits,
        priceCents: def.priceCents,
        annualPriceCents: def.annualPriceCents,
        currency: def.currency,
        // Stripe ids are deployment configuration, never overwritten by a seed.
        stripePriceId: existing?.stripePriceId ?? null,
        stripeAnnualPriceId: existing?.stripeAnnualPriceId ?? null,
        updatedAt: now,
      });
    }
  }

  async plan(code: string): Promise<StoredPlan | undefined> {
    return this.planRows.get(code);
  }

  async plans(): Promise<StoredPlan[]> {
    return [...this.planRows.values()].sort((a, b) => a.rank - b.rank);
  }

  async putPlan(plan: StoredPlan): Promise<void> {
    this.planRows.set(plan.code, { ...plan });
  }

  async subscription(orgId: string): Promise<StoredSubscription | undefined> {
    return this.subs.get(orgId);
  }

  async putSubscription(sub: StoredSubscription): Promise<void> {
    this.subs.set(sub.orgId, { ...sub });
  }

  async subscriptionByStripeId(
    kind: "customer" | "subscription",
    id: string,
  ): Promise<StoredSubscription | undefined> {
    for (const sub of this.subs.values()) {
      const value = kind === "customer" ? sub.stripeCustomerId : sub.stripeSubscriptionId;
      if (value === id) return sub;
    }
    return undefined;
  }

  async record(event: UsageEvent): Promise<boolean> {
    if (this.events.has(event.id)) return false;
    this.events.set(event.id, { ...event });
    return true;
  }

  async total(orgId: string, kind: UsageKind, period: Period): Promise<number> {
    let sum = 0;
    for (const e of this.events.values()) {
      if (e.orgId !== orgId || e.kind !== kind) continue;
      if (e.at < period.start || e.at >= period.endExclusive) continue;
      sum += e.quantity;
    }
    return sum;
  }

  async monthToDate(orgId: string, kind: UsageKind, now: number): Promise<number> {
    return this.total(orgId, kind, monthWindow(now));
  }

  async totalsByKind(orgId: string, period: Period): Promise<Record<string, number>> {
    const totals: Record<string, number> = {};
    for (const e of this.events.values()) {
      if (e.orgId !== orgId) continue;
      if (e.at < period.start || e.at >= period.endExclusive) continue;
      totals[e.kind] = (totals[e.kind] ?? 0) + e.quantity;
    }
    return totals;
  }
  async rollupDay(day: string, now: number): Promise<number> {
    const { start, endExclusive } = dayWindow(day);
    // Drop the day first: a rebuild has to be able to *lower* a total after
    // events were deleted with an org, which an upsert alone cannot do.
    for (const [key, row] of this.rollupRows) {
      if (row.day === day) this.rollupRows.delete(key);
    }
    const grouped = new Map<string, UsageRollup>();
    for (const e of this.events.values()) {
      if (e.at < start || e.at >= endExclusive) continue;
      const key = rollupKey(e.orgId, day, e.kind);
      const row = grouped.get(key) ?? {
        orgId: e.orgId,
        day,
        kind: e.kind,
        quantity: 0,
        events: 0,
        updatedAt: now,
      };
      row.quantity += e.quantity;
      row.events += 1;
      grouped.set(key, row);
    }
    for (const [key, row] of grouped) this.rollupRows.set(key, row);
    return grouped.size;
  }

  async rollups(orgId: string, fromDay: string, toDay: string): Promise<UsageRollup[]> {
    return [...this.rollupRows.values()]
      .filter((r) => r.orgId === orgId && r.day >= fromDay && r.day <= toDay)
      .sort((a, b) => (a.day === b.day ? a.kind.localeCompare(b.kind) : a.day < b.day ? -1 : 1));
  }
}

function rollupKey(orgId: string, day: string, kind: string): string {
  return orgId + " " + day + " " + kind;
}
