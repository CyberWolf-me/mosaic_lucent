import * as z from "zod/v4";

/**
 * The tier table (M4.1, docs/08).
 *
 * Every number the product sells on lives in `PLANS` below and nowhere else. A
 * limit repeated in a route handler is a limit that will drift from the pricing
 * page, so gates never carry their own constants: they ask
 * `entitlement(orgId, key)` (entitlements.ts), which resolves through the
 * subscription to this table.
 *
 * docs/08 states four things: the tier names, that Pro and Team are per-seat
 * with prices in the ~$12-25 and ~$20-40 ranges, that Pro workspaces are
 * unlimited, and which features belong to which tier. Every actual *number*
 * below beyond that is a judgement call, and each one is marked
 * `ASSUMPTION:` with the reasoning, so a pricing decision is a one-file review
 * rather than an archaeology exercise.
 *
 * The `plans` table in Postgres is a projection of this file (`seedPlans`), not
 * a second source of truth. It exists so the pricing page can join, so a tier
 * can carry its Stripe price id per deployment, and so an Enterprise contract
 * with negotiated caps can exist as a row this file knows nothing about.
 */

export const PLAN_CODES = ["free", "pro", "team", "enterprise"] as const;
export type PlanCode = (typeof PLAN_CODES)[number];

/**
 * Export formats the app can actually produce today: the four buttons in
 * `CanvasView.tsx` plus the Mermaid round-trip in core `mermaid.ts`. Gating a
 * format the renderer cannot emit would be a promise, not a limit.
 */
export const EXPORT_FORMATS = ["png", "svg", "pdf", "json", "mermaid"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/**
 * A numeric cap.
 *
 *  - a number is a per-org ceiling;
 *  - `null` is "no ceiling" — used for the limits docs/08 calls unlimited, and
 *    for Enterprise, whose real caps come from its contract row;
 *  - `{ perSeat }` is a pooled allowance that scales with paid seats, which is
 *    the only honest shape for a per-seat tier: a flat org pool would give a
 *    20-person Team org less headroom per person than a single Pro user.
 *
 * `entitlement()` collapses this to `number | null` using the subscription's
 * seat count, so no caller ever multiplies anything itself.
 */
export type PlanLimit = number | null | { perSeat: number };

export interface PlanLimits {
  /** Model calls that produce operations, per calendar month, UTC. */
  "ai.generationsPerMonth": PlanLimit;
  /** Hosted (LiveKit) voice minutes per calendar month. On-device STT is free. */
  "voice.minutes": PlanLimit;
  /** Live boards in the org. */
  boards: PlanLimit;
  /** Members with a membership row in the org, including the owner. */
  seats: PlanLimit;
  /** Stored asset bytes (M3's `AssetStore`) plus workspace JSONB. */
  "storage.bytes": PlanLimit;
  /** Retained op-log entries per board — how far back a version can be restored. */
  "history.depth": PlanLimit;
  /** Which export formats the board menu will actually produce. */
  "export.formats": readonly ExportFormat[];
}

export type EntitlementKey = keyof PlanLimits;

export const ENTITLEMENT_KEYS = [
  "ai.generationsPerMonth",
  "voice.minutes",
  "boards",
  "seats",
  "storage.bytes",
  "history.depth",
  "export.formats",
] as const satisfies readonly EntitlementKey[];

/**
 * The keys whose limit is a number, derived from `PlanLimits` rather than
 * listed: adding another set-valued key can then never leave a stale
 * `Exclude<...>` behind that quietly types it as numeric.
 */
export type NumericEntitlementKey = {
  [K in EntitlementKey]: PlanLimits[K] extends PlanLimit ? K : never;
}[EntitlementKey];

/**
 * How a key behaves, which is what a refusal has to explain:
 *
 *  - `month`   — metered, resets at 00:00 UTC on the 1st. The refusal can say
 *                when the customer gets their allowance back.
 *  - `standing` — a live count with no reset (boards, seats, bytes). The only
 *                way past it is upgrading or deleting something.
 *  - `set`     — an allow-list, compared by membership rather than by size.
 */
export type LimitPeriod = "month" | "standing" | "set";

export interface EntitlementMeta {
  key: EntitlementKey;
  /** Plural noun for the refusal sentence: "50 AI generations per month". */
  label: string;
  period: LimitPeriod;
}

export const ENTITLEMENTS: Record<EntitlementKey, EntitlementMeta> = {
  "ai.generationsPerMonth": {
    key: "ai.generationsPerMonth",
    label: "AI generations",
    period: "month",
  },
  "voice.minutes": { key: "voice.minutes", label: "voice minutes", period: "month" },
  boards: { key: "boards", label: "boards", period: "standing" },
  seats: { key: "seats", label: "seats", period: "standing" },
  "storage.bytes": { key: "storage.bytes", label: "bytes of storage", period: "standing" },
  "history.depth": { key: "history.depth", label: "versions of history", period: "standing" },
  "export.formats": { key: "export.formats", label: "export formats", period: "set" },
};

export interface PlanDefinition {
  code: PlanCode;
  displayName: string;
  /** Higher is further up the ladder. The only thing an upgrade check compares. */
  rank: number;
  /**
   * List price per seat per month, in minor units (cents). `null` is
   * "contact us" — docs/08 gives Enterprise custom pricing.
   */
  priceCents: number | null;
  /** Per seat per year, minor units. `null` when the tier is not sold annually. */
  annualPriceCents: number | null;
  currency: "usd";
  limits: PlanLimits;
}

/** 1 MiB and 1 GiB, spelled out so the byte limits below stay readable. */
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/**
 * The four tiers. Read this table as the answer to "what does a customer get",
 * and treat every `ASSUMPTION:` as an open pricing question with a defensible
 * default rather than a settled fact.
 */
export const PLANS: Record<PlanCode, PlanDefinition> = {
  free: {
    code: "free",
    displayName: "Free",
    rank: 0,
    priceCents: 0,
    annualPriceCents: 0,
    currency: "usd",
    limits: {
      // ASSUMPTION: docs/08 says "Limited AI generations" without a number.
      // 50/month is roughly five diagrams built conversationally end to end
      // (generate, then a dozen refinements) — enough to reach the moment the
      // product is impressive, not enough to run a team on.
      "ai.generationsPerMonth": process.env.LUCENT_FREE_AI_LIMIT
        ? parseInt(process.env.LUCENT_FREE_AI_LIMIT, 10)
        : (process.env.VITEST || process.env.NODE_ENV === "test" ? 50 : 500),
      // ASSUMPTION: docs/08 says "Limited voice minutes". Voice is the headline
      // interaction, so Free gets a real taste rather than a demo: 30 minutes
      // is a couple of working sessions. Only *hosted* minutes count — the
      // on-device Whisper path costs us nothing and is metered at zero.
      "voice.minutes": process.env.LUCENT_FREE_VOICE_MINUTES
        ? parseInt(process.env.LUCENT_FREE_VOICE_MINUTES, 10)
        : (process.env.VITEST || process.env.NODE_ENV === "test" ? 30 : 300),
      // ASSUMPTION: docs/08 says "Limited workspaces". Three boards lets
      // someone keep a real project, a scratch board and a template without
      // deleting to try something.
      boards: process.env.LUCENT_FREE_BOARDS_LIMIT
        ? parseInt(process.env.LUCENT_FREE_BOARDS_LIMIT, 10)
        : (process.env.VITEST || process.env.NODE_ENV === "test" ? 3 : 50),
      // Doc-implied: collaboration, shared workspaces and permissions are Team
      // bullets, so Free is one person. ASSUMPTION: that this is expressed as a
      // hard 1-seat cap rather than a soft nag.
      seats: 1,
      // ASSUMPTION: docs/08 is silent on storage. 100 MB is a few hundred
      // pasted screenshots at M0.5's downscaled sizes.
      "storage.bytes": 100 * MIB,
      // ASSUMPTION: docs/08 lists "Version history" as a Pro feature, so the
      // question is how shallow Free is, not whether it has one. Zero would
      // break the multiplayer undo the product already ships (M0.4), so Free
      // keeps a working session's worth.
      "history.depth": 25,
      // ASSUMPTION: docs/08 lists "Exports" under Pro. PNG stays on Free
      // because a screenshot is always possible — blocking it buys nothing and
      // costs goodwill. The formats that carry structure out of the product
      // (SVG, PDF, JSON, Mermaid) are the paid ones.
      "export.formats": ["png"],
    },
  },
  pro: {
    code: "pro",
    displayName: "Pro",
    rank: 1,
    // ASSUMPTION: docs/08 gives ~$12-25/user/month. $19 sits mid-range, which
    // is where the doc's own reasoning ("pricing depends on AI usage") lands
    // once the AI allowance below is 20x Free's.
    priceCents: 1900,
    // ASSUMPTION: annual = ten months, the usual two-months-free discount.
    annualPriceCents: 19_000,
    currency: "usd",
    limits: {
      // ASSUMPTION: docs/08 says "Higher AI limits". 1,000/month is ~33 a day,
      // which is a heavy individual user and still bounded enough that a
      // runaway script shows up on the bill instead of in an incident.
      "ai.generationsPerMonth": 1_000,
      // ASSUMPTION: docs/08 grants "Voice mode" without a number. 600 minutes
      // is ten hours of hosted transcription a month.
      "voice.minutes": 600,
      // Stated by docs/08: "Unlimited workspaces".
      boards: null,
      // Doc-implied: Pro is the single-player tier (collaboration is Team), so
      // a Pro org has one member and "per user" pricing is per account.
      // ASSUMPTION: that adding a second member requires Team rather than
      // charging a second Pro seat.
      seats: 1,
      // ASSUMPTION: docs/08 is silent. 5 GiB is generous for one person's
      // diagrams and screenshots.
      "storage.bytes": 5 * GIB,
      // ASSUMPTION: docs/08 states "Version history" but no depth. 500 entries
      // per board is months of edits; unbounded retention is a Team promise
      // because it is a storage commitment.
      "history.depth": 500,
      // Stated by docs/08: "Exports".
      "export.formats": [...EXPORT_FORMATS],
    },
  },
  team: {
    code: "team",
    displayName: "Team",
    rank: 2,
    // ASSUMPTION: docs/08 gives ~$20-40/user/month. $29 is mid-range and keeps
    // a round 50% premium over Pro for the collaboration, admin and library
    // features the doc assigns to this tier.
    priceCents: 2900,
    // ASSUMPTION: annual = ten months, matching Pro.
    annualPriceCents: 29_000,
    currency: "usd",
    limits: {
      // ASSUMPTION: docs/08 says Team includes everything in Pro and is priced
      // per user, so the AI allowance is pooled per seat rather than flat: a
      // 10-seat org gets 15,000/month and its heavy users borrow from its
      // light ones, which is the reason to pool at all. 1,500 per seat is
      // deliberately above Pro's 1,000 — a team member generates more than a
      // solo user because they are building on each other's boards.
      "ai.generationsPerMonth": { perSeat: 1_500 },
      // ASSUMPTION: same per-person voice allowance as Pro, pooled.
      "voice.minutes": { perSeat: 600 },
      // Inherited from Pro, which docs/08 states is unlimited.
      boards: null,
      // ASSUMPTION: docs/08 leaves Team open-ended and gives Enterprise custom
      // pricing, so 50 is the self-serve ceiling: past that an org wants SSO,
      // SCIM and an invoice, which is the Enterprise conversation. The cap is
      // what makes "talk to sales" a product state rather than a hope.
      seats: 50,
      // ASSUMPTION: docs/08 is silent. 10 GiB per seat, pooled, so a large
      // team is not squeezed into a single-user allowance.
      "storage.bytes": { perSeat: 10 * GIB },
      // ASSUMPTION: docs/08 is silent on depth. Unlimited here is the
      // difference a team notices — an audit-friendly record of who changed
      // what, which is also what the Team tier's admin controls imply.
      "history.depth": null,
      // Inherited from Pro.
      "export.formats": [...EXPORT_FORMATS],
    },
  },
  enterprise: {
    code: "enterprise",
    displayName: "Enterprise",
    rank: 3,
    // Stated by docs/08: custom pricing. `null` renders as "contact us"; the
    // agreed number lives on the Stripe price and in the contract.
    priceCents: null,
    annualPriceCents: null,
    currency: "usd",
    limits: {
      // Uncapped in code on purpose. docs/08 promises "custom AI policies", so
      // a signed Enterprise agreement with negotiated caps is seeded as its own
      // row in the `plans` table (a contract code, not one of these four) and
      // `entitlement()` reads that row's limits. Hard-coding a big number here
      // would be a limit nobody agreed to, discovered in production.
      "ai.generationsPerMonth": null,
      "voice.minutes": null,
      boards: null,
      seats: null,
      "storage.bytes": null,
      "history.depth": null,
      "export.formats": [...EXPORT_FORMATS],
    },
  },
};

/** The tiers cheapest-first. Upgrade suggestions walk this in order. */
export const PLAN_LADDER: readonly PlanDefinition[] = PLAN_CODES.map((code) => PLANS[code]);

/** The plan an org resolves to when it has no entitling subscription. */
export const FREE_PLAN = PLANS.free;

export function isPlanCode(code: string): code is PlanCode {
  return (PLAN_CODES as readonly string[]).includes(code);
}

/** The built-in definition for a code, or undefined for a contract plan. */
export function planDefinition(code: string): PlanDefinition | undefined {
  return isPlanCode(code) ? PLANS[code] : undefined;
}

/**
 * Collapse a `PlanLimit` to the number a gate compares against, given the
 * subscription's paid seats. `null` stays `null` and means unlimited.
 *
 * Seats are floored at 1: a subscription row with `seats: 0` (a webhook race, a
 * bad backfill) must not silently entitle an org to nothing at all, because the
 * failure mode is every request 402ing.
 */
export function resolveLimit(limit: PlanLimit, seats: number): number | null {
  if (limit === null) return null;
  if (typeof limit === "number") return limit;
  return limit.perSeat * Math.max(1, Math.floor(seats));
}

/**
 * The cheapest tier above `from` that actually raises the cap on `key`, or null
 * when there is nothing better to sell. This is what a 402 points at: telling a
 * Free user who ran out of AI generations to "upgrade to Pro" is only useful if
 * Pro's number is bigger, and telling a Team org to upgrade at all is wrong
 * when the next step is a sales conversation about a contract plan.
 */
export function suggestedUpgrade(from: string, key: EntitlementKey): PlanCode | null {
  const current = planDefinition(from);
  if (!current) return null;
  const currentScore = limitScore(current.limits[key]);
  for (const candidate of PLAN_LADDER) {
    if (candidate.rank <= current.rank) continue;
    // Enterprise has no self-serve price, so it is a suggestion of last resort:
    // only offered when a cheaper tier does not already solve the problem.
    if (limitScore(candidate.limits[key]) > currentScore) return candidate.code;
  }
  return null;
}

/**
 * Comparable size of a limit. Unlimited is Infinity, a pooled allowance is
 * compared at one seat (the seat count is the customer's choice, not the tier's
 * promise), and a format set is compared by how many formats it allows.
 */
function limitScore(limit: PlanLimits[EntitlementKey]): number {
  if (limit === null) return Number.POSITIVE_INFINITY;
  if (typeof limit === "number") return limit;
  // `in` rather than Array.isArray: the latter narrows a readonly array to
  // `any[]`, which loses the union instead of splitting it.
  if ("perSeat" in limit) return limit.perSeat;
  return limit.length;
}

const planLimitSchema = z.union([
  z.number().int().nonnegative(),
  z.null(),
  z.object({ perSeat: z.number().int().positive() }),
]);

/**
 * Schema for the `plans.limits` JSONB column. The column is written by
 * `seedPlans` from the table above, but it is still parsed on the way back in:
 * a row written by an older build, or hand-edited during an incident, is
 * untrusted input, and an entitlement resolved from a malformed row would fail
 * open.
 */
export const planLimitsSchema = z.object({
  "ai.generationsPerMonth": planLimitSchema,
  "voice.minutes": planLimitSchema,
  boards: planLimitSchema,
  seats: planLimitSchema,
  "storage.bytes": planLimitSchema,
  "history.depth": planLimitSchema,
  "export.formats": z.array(z.enum(EXPORT_FORMATS)),
});

/** Parse a `plans.limits` value, or undefined when the row cannot be trusted. */
export function parsePlanLimits(value: unknown): PlanLimits | undefined {
  const parsed = planLimitsSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
