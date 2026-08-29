import { apiFetch } from "./http.js";
import { hasSession } from "./session.js";

/**
 * Billing client (M4): the wire contract of `GET /api/orgs/:id/billing`, plus the
 * derivations the settings pane draws it with.
 *
 * Shaped like `boards.ts` — a root-level module, one `apiFetch` per endpoint, no
 * React — for the same reason: everything here is either a fetch or a pure
 * function, so the arithmetic that decides whether a customer is shown a full
 * meter is testable without a DOM (`vite.config.ts` runs vitest in the node
 * environment, deliberately).
 *
 * The types mirror the route in `packages/server/src/app.ts` field for field.
 * Copied rather than imported, exactly like `PlanRefusal` in `api.ts`: the
 * browser bundle does not depend on the server package, so the contract is
 * pinned by this reference instead of by the compiler.
 *
 * One rule shapes every function below: **unlimited and spent are one `null`
 * apart**. The server reports `limit: null` for no ceiling and computes
 * `remaining` itself so the client never subtracts anything — and nothing here
 * does. A UI that gets that wrong shows a paying customer a paywall.
 */

/* --------------------------- the wire contract ---------------------------- */

/** Stripe's status vocabulary, mirroring `usageStore.ts`'s `SubscriptionStatus`. */
export const SUBSCRIPTION_STATUSES = [
  "trialing",
  "active",
  "past_due",
  "canceled",
  "unpaid",
  "incomplete",
  "incomplete_expired",
  "paused",
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/** How a limit behaves, mirroring `LimitPeriod` in `plans.ts`. */
export type LimitPeriod = "month" | "standing" | "set";

export interface BillingPlan {
  /** Effective plan code: a built-in tier, a contract code, or `free`. */
  code: string;
  name: string;
  /** The subscription's status, or null when the org has never had one. */
  status: SubscriptionStatus | null;
  seats: number;
  /**
   * True when the paid plan did *not* apply. With `status: null` that means no
   * subscription; with a lapsed status it means a paid plan stopped applying and
   * the org is being treated as Free. `planState` below is the only place those
   * two are turned into sentences, because they are not the same sentence.
   */
  fallback: boolean;
  periodEnd: number | null;
}

/** A half-open range of epoch ms — the UTC calendar month usage is counted in. */
export interface BillingPeriod {
  start: number;
  endExclusive: number;
}

export interface LimitRow {
  key: string;
  /** Plural noun from the server (`ENTITLEMENTS[key].label`). */
  label: string;
  /** Null when the server sent a period this build does not know. */
  period: LimitPeriod | null;
  /** The ceiling, or null for unlimited. */
  limit: number | null;
  /** Usage against it, or null when there is no total at org scope. */
  used: number | null;
  unlimited: boolean;
  /** Server-computed headroom. Null for unlimited or uncounted rows. */
  remaining: number | null;
}

export interface ExportFormatsRow {
  key: string;
  label: string;
  /** Formats this plan may produce. */
  allowed: readonly string[];
  /** Every format the app can produce, so the locked ones can be named. */
  all: readonly string[];
}

export interface BillingSnapshot {
  orgId: string;
  plan: BillingPlan;
  period: BillingPeriod;
  /**
   * Where the upgrade affordance points. Deployment config, so null when the
   * server did not send one — a link to a route this deployment does not host is
   * worse than no link, which is the same call `api.ts` makes for a refusal.
   */
  upgradeUrl: string | null;
  limits: LimitRow[];
  exportFormats: ExportFormatsRow;
}

/** One org the caller belongs to, from `GET /api/orgs`. */
export interface OrgSummary {
  id: string;
  name: string;
  role: string;
  isPersonal: boolean;
}

/**
 * Every way the pane can end up with nothing to draw, as distinct cases rather
 * than one error string. `unconfigured` in particular must never collapse into
 * either an error or a confident Free plan: the server answers 503 to say that
 * nothing is being metered or enforced here at all.
 */
export type BillingResult =
  | { kind: "ok"; billing: BillingSnapshot }
  | { kind: "unconfigured" }
  /** 404/403: the org guard hides "not yours" behind "not found". */
  | { kind: "unavailable" }
  | { kind: "signedOut" }
  | { kind: "error"; message: string };

export type OrgsResult =
  | { kind: "ok"; orgs: OrgSummary[] }
  | { kind: "signedOut" }
  | { kind: "error"; message: string };

/** The sentence the rest of the client uses for a backend that is not running. */
const UNREACHABLE = "Can't reach the Lucent server. Start it with: npm run start -w @lucent/server";

/* ------------------------------ reading it -------------------------------- */

/**
 * Readers for a body we do not control, following `api.ts`: an empty string is
 * absent, and a non-finite number is absent, because "Invalid Date" and "NaN of
 * 50" are worse than a row that declines to draw itself.
 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readNumber(body: Record<string, unknown>, key: string): number | null {
  const value = body[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * A field where `null` is a fact rather than an absence — `limit: null` means
 * unlimited, `used: null` means not countable here. Anything that is neither a
 * finite number nor exactly null comes back `undefined`, and the caller drops
 * the row: guessing would either invent a ceiling or invent unlimited access,
 * and both are lies about what the customer has bought.
 */
function readNullableNumber(body: Record<string, unknown>, key: string): number | null | undefined {
  const value = body[key];
  if (value === null) return null;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function readStatus(value: unknown): SubscriptionStatus | null {
  // Compared against the literals rather than cast, like `reason` in `api.ts`:
  // this is the field the lapsed-versus-never-subscribed copy turns on, so an
  // unrecognised status has to read as "no status" instead of passing for one.
  return SUBSCRIPTION_STATUSES.find((s) => s === value) ?? null;
}

function readPeriodKind(value: unknown): LimitPeriod | null {
  return value === "month" || value === "standing" || value === "set" ? value : null;
}

function parsePlan(value: unknown): BillingPlan | null {
  const body = asRecord(value);
  if (body === null) return null;
  const code = readString(body, "code");
  const name = readString(body, "name");
  if (code === null || name === null) return null;
  return {
    code,
    name,
    status: readStatus(body.status),
    seats: readNumber(body, "seats") ?? 1,
    // Default true, so an unreadable flag understates rather than overstates what
    // the org is entitled to: "we could not confirm your plan applied" is a
    // recoverable message, "you are on Team" followed by a 402 is not.
    fallback: typeof body.fallback === "boolean" ? body.fallback : true,
    periodEnd: readNumber(body, "periodEnd"),
  };
}

function parsePeriod(value: unknown): BillingPeriod | null {
  const body = asRecord(value);
  if (body === null) return null;
  const start = readNumber(body, "start");
  const endExclusive = readNumber(body, "endExclusive");
  return start !== null && endExclusive !== null ? { start, endExclusive } : null;
}

function parseLimitRow(value: unknown): LimitRow | null {
  const body = asRecord(value);
  if (body === null) return null;
  const key = readString(body, "key");
  const label = readString(body, "label");
  const limit = readNullableNumber(body, "limit");
  const used = readNullableNumber(body, "used");
  if (key === null || label === null || limit === undefined || used === undefined) return null;
  return {
    key,
    label,
    period: readPeriodKind(body.period),
    limit,
    used,
    // `unlimited` and `limit === null` are the same fact twice. Taking either as
    // proof means one mangled field cannot turn "no ceiling" into a ceiling.
    unlimited:
      typeof body.unlimited === "boolean" ? body.unlimited || limit === null : limit === null,
    remaining: readNumber(body, "remaining"),
  };
}

function parseExportFormats(value: unknown): ExportFormatsRow {
  const body = asRecord(value);
  return {
    key: (body !== null ? readString(body, "key") : null) ?? "export.formats",
    label: (body !== null ? readString(body, "label") : null) ?? "export formats",
    allowed: body !== null ? readStringArray(body.allowed) : [],
    all: body !== null ? readStringArray(body.all) : [],
  };
}

/** The whole snapshot, or null when the body is not one. */
export function parseBilling(value: unknown): BillingSnapshot | null {
  const body = asRecord(value);
  if (body === null) return null;
  const orgId = readString(body, "orgId");
  const plan = parsePlan(body.plan);
  const period = parsePeriod(body.period);
  if (orgId === null || plan === null || period === null) return null;
  const rows = Array.isArray(body.limits) ? body.limits : [];
  return {
    orgId,
    plan,
    period,
    upgradeUrl: readString(body, "upgradeUrl"),
    limits: rows.map(parseLimitRow).filter((row): row is LimitRow => row !== null),
    exportFormats: parseExportFormats(body.exportFormats),
  };
}

/* ------------------------------ fetching it ------------------------------- */

/**
 * The orgs the caller belongs to. The pane needs this because nothing in the
 * client tracks a current org yet: `/billing` wants an id in its path, and
 * `GET /api/orgs` is the only place the browser can learn one.
 */
export async function fetchOrgs(): Promise<OrgsResult> {
  if (!hasSession()) return { kind: "signedOut" };
  let res: Response;
  try {
    res = await apiFetch("/api/orgs");
  } catch {
    return { kind: "error", message: UNREACHABLE };
  }
  if (res.status === 401) return { kind: "signedOut" };
  if (!res.ok) return { kind: "error", message: `Couldn't load your workspaces (${res.status}).` };
  const body = asRecord((await res.json().catch(() => null)) as unknown);
  const rows = body !== null && Array.isArray(body.orgs) ? body.orgs : [];
  const orgs: OrgSummary[] = [];
  for (const raw of rows) {
    const org = asRecord(raw);
    if (org === null) continue;
    const id = readString(org, "id");
    if (id === null) continue;
    orgs.push({
      id,
      name: readString(org, "name") ?? "Workspace",
      role: readString(org, "role") ?? "member",
      isPersonal: org.isPersonal === true,
    });
  }
  return { kind: "ok", orgs };
}

/**
 * Which org the pane opens on: the personal one, because that is the org the
 * rest of the app implicitly works in (`POST /api/boards` files a board under
 * the caller's first membership, which is the personal org created at signup).
 * Falls back to the first row so somebody who only belongs to shared orgs still
 * lands somewhere real.
 */
export function preferredOrg(orgs: readonly OrgSummary[]): OrgSummary | null {
  return orgs.find((o) => o.isPersonal) ?? orgs[0] ?? null;
}

export async function fetchBilling(orgId: string): Promise<BillingResult> {
  if (!hasSession()) return { kind: "signedOut" };
  let res: Response;
  try {
    res = await apiFetch(`/api/orgs/${encodeURIComponent(orgId)}/billing`);
  } catch {
    // A dead backend must not read as a billing problem, so it gets the same
    // sentence (and the same fix) as everywhere else in the client.
    return { kind: "error", message: UNREACHABLE };
  }
  // 503 is the server saying this deployment has no billing wired up at all.
  // Distinct from an error and, critically, distinct from "you are on Free":
  // nothing is metered or enforced here, so there are no limits to draw.
  if (res.status === 503) return { kind: "unconfigured" };
  // The org guard answers 404 for a non-member, so "not yours" and "not there"
  // arrive as the same status and get the same sentence.
  if (res.status === 404 || res.status === 403) return { kind: "unavailable" };
  if (res.status === 401) return { kind: "signedOut" };
  if (!res.ok) return { kind: "error", message: `Couldn't load your plan (${res.status}).` };
  const billing = parseBilling((await res.json().catch(() => null)) as unknown);
  // A 200 we cannot read is an error, not an empty Free plan. Inventing a plan
  // from a mangled body is the other way a paying customer gets shown a paywall.
  return billing !== null
    ? { kind: "ok", billing }
    : { kind: "error", message: "The server sent plan data this app couldn't read." };
}

/* ------------------------------ formatting -------------------------------- */

/**
 * Dates are formatted in UTC everywhere in this file, because that is the clock
 * the allowances actually run on: `monthWindow` opens each period at 00:00 UTC
 * on the 1st. Rendering a reset date in local time would show a customer in
 * Auckland the wrong day, and would make these tests depend on the runner's
 * timezone.
 */
const DAY_FORMAT = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const MONTH_FORMAT = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "long",
  timeZone: "UTC",
});
const COUNT_FORMAT = new Intl.NumberFormat("en-US");

export function formatDay(ms: number | null): string | null {
  return ms !== null && Number.isFinite(ms) ? DAY_FORMAT.format(new Date(ms)) : null;
}

export function formatMonth(ms: number): string {
  return Number.isFinite(ms) ? MONTH_FORMAT.format(new Date(ms)) : "this period";
}

/** Grouped digits: a 6000-generation allowance reads as 6,000. */
export function formatCount(n: number): string {
  return Number.isFinite(n) ? COUNT_FORMAT.format(Math.round(n)) : "—";
}

/**
 * Binary units with decimal labels, matching the copy the plans themselves use:
 * the Free tier is written as 100 MB and stored as `100 * MIB`, so dividing by
 * 1000 would render the same allowance as "104.9 MB" and look like a bug.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} bytes`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // A decimal only where it carries information: "1.4 GB" is useful, "1.0 GB"
  // and "512.0 MB" are noise.
  const digits = value < 10 && !Number.isInteger(value) ? 1 : 0;
  return `${value.toFixed(digits)} ${units[unit]!}`;
}

/** Bytes-keyed rows are byte counts; everything else is a plain tally. */
export function formatAmount(key: string, n: number): string {
  return key.endsWith(".bytes") ? formatBytes(n) : formatCount(n);
}

/**
 * Row headings. The server's label is the source of truth and is used as-is for
 * five of the six rows; the two byte/version keys get a client title because
 * "Bytes of storage" and "Versions of history" are written for the middle of a
 * refusal sentence, not for the left of a table. Unknown keys fall back to the
 * server label, so a new entitlement renders sensibly before this map hears
 * about it.
 */
const TITLES: Record<string, string> = {
  "storage.bytes": "Storage",
  "history.depth": "Version history",
};

export function limitTitle(row: LimitRow): string {
  return TITLES[row.key] ?? row.label.charAt(0).toUpperCase() + row.label.slice(1);
}

/**
 * Why a row cannot show usage. Only history depth needs one today, and it needs
 * it badly: a limit with no usage figure looks like a rendering failure unless
 * the reason is on screen.
 */
const NOTES: Record<string, string> = {
  "history.depth": "Kept per board, so there is no workspace-wide total to compare.",
};

export function limitNote(row: LimitRow): string | null {
  return row.used === null ? (NOTES[row.key] ?? null) : null;
}

/** "Resets Sep 1, 2026" for metered rows; standing ceilings never reset. */
export function resetLabel(row: LimitRow, period: BillingPeriod): string | null {
  if (row.period !== "month") return null;
  const day = formatDay(period.endExclusive);
  return day !== null ? `Resets ${day}` : null;
}

/* ------------------------------ derivations ------------------------------- */

const STATUS_LABEL: Record<SubscriptionStatus, string> = {
  trialing: "Trial",
  active: "Active",
  past_due: "Payment failed",
  canceled: "Canceled",
  unpaid: "Unpaid",
  incomplete: "Incomplete",
  incomplete_expired: "Expired",
  paused: "Paused",
};

/** What the org is on, in one badge and one sentence. */
export interface PlanState {
  kind: "paid" | "trialing" | "payment_failed" | "lapsed" | "none";
  badge: string;
  /** Renderable as-is; never a template with a hole in it. */
  detail: string;
  /**
   * What the link to `upgradeUrl` means here. `payment` is the case worth the
   * extra kind: the customer has already chosen a plan, so offering them a
   * bigger one is answering a question nobody asked.
   */
  action: "manage" | "upgrade" | "payment";
  actionLabel: string;
}

function seatPhrase(seats: number): string {
  return `${formatCount(seats)} ${seats === 1 ? "seat" : "seats"}`;
}

/**
 * Why a paid plan stopped applying. One sentence per status, because "your
 * subscription is not active" covers all of them and helps with none: a canceled
 * plan is resubscribed, an unpaid one is paid, an incomplete one was never
 * finished.
 */
function lapsedCause(status: SubscriptionStatus): string {
  switch (status) {
    case "canceled":
      return "Your subscription was canceled.";
    case "unpaid":
      return "Your subscription went unpaid after the last payment retry failed.";
    case "incomplete":
      return "Your subscription was never finished paying for.";
    case "incomplete_expired":
      return "Your subscription expired before its first payment went through.";
    case "paused":
      return "Your subscription is paused.";
    case "past_due":
      return "A payment for your subscription failed.";
    // trialing/active reaching here means the subscription is live but its plan
    // did not resolve — a contract code this build does not know. Saying so is
    // more honest than claiming a billing problem the customer cannot fix.
    default:
      return "Your subscription is not being applied to this workspace.";
  }
}

/**
 * The five states a plan can be in, and the reason `fallback` exists.
 *
 * `fallback: false` means the paid plan applied. `fallback: true` means it did
 * not, and the org is being held to Free's limits — for one of two completely
 * different reasons, which is the distinction this function exists to keep:
 *
 *   - `status: null` — there has never been a subscription. Sell them one.
 *   - a lapsed status — there was one and it stopped. Do not sell them a bigger
 *     plan; point them at the payment, because that is the thing that is broken.
 *
 * `past_due` with `fallback: false` is the third case people miss: the server's
 * `ENTITLING_STATUSES` keeps a past-due org entitled while Stripe retries, so
 * nothing is missing from their plan yet. They need a warning, not a paywall.
 */
export function planState(plan: BillingPlan): PlanState {
  const ends = formatDay(plan.periodEnd);
  if (!plan.fallback) {
    if (plan.status === "past_due") {
      return {
        kind: "payment_failed",
        badge: STATUS_LABEL.past_due,
        detail: `A payment for ${plan.name} didn't go through. Your plan still applies while the payment is retried — update your payment details to keep it.${ends !== null ? ` The current period runs to ${ends}.` : ""}`,
        action: "payment",
        actionLabel: "Fix payment",
      };
    }
    if (plan.status === "trialing") {
      return {
        kind: "trialing",
        badge: STATUS_LABEL.trialing,
        detail: `You're trialing ${plan.name} with ${seatPhrase(plan.seats)}.${ends !== null ? ` The trial ends ${ends}.` : ""}`,
        action: "manage",
        actionLabel: "Choose a plan",
      };
    }
    return {
      kind: "paid",
      badge: STATUS_LABEL.active,
      detail: `${plan.name} with ${seatPhrase(plan.seats)}.${ends !== null ? ` Renews ${ends}.` : ""}`,
      action: "manage",
      actionLabel: "Change plan",
    };
  }
  if (plan.status === null) {
    return {
      kind: "none",
      badge: plan.name,
      detail: `This workspace has no subscription, so it's on the ${plan.name} plan's limits.`,
      action: "upgrade",
      actionLabel: "See plans",
    };
  }
  return {
    kind: "lapsed",
    badge: STATUS_LABEL[plan.status],
    detail: `${lapsedCause(plan.status)} Until it's sorted out this workspace is held to the ${plan.name} plan's limits.${ends !== null ? ` The paid period ended ${ends}.` : ""}`,
    action: "payment",
    actionLabel: "Restore your plan",
  };
}

/** How near a ceiling counts as near enough to warn about. */
export const WARN_FRACTION = 0.8;

export type MeterKind = "unlimited" | "uncounted" | "counted";
export type MeterTone = "ok" | "warn" | "spent";

export interface Meter {
  kind: MeterKind;
  /** Drives colour *and* the fill pattern, never colour alone. */
  tone: MeterTone;
  /** The figures: "12 of 50", "100 MB", "Unlimited". */
  value: string;
  /**
   * The bar in words — "38 left", "Nothing left this month", "Unlimited". Shown
   * next to the bar and reused as `aria-valuetext`, because a meter whose only
   * "nearly out" signal is a colour is unreadable to a good part of the audience.
   */
  status: string;
  /** Fill percentage, or null when there is no bar to draw. */
  percent: number | null;
  /** `aria-valuenow` / `aria-valuemax`, both null when there is no bar. */
  now: number | null;
  max: number | null;
}

/**
 * One limit row turned into something drawable.
 *
 * The order of the branches is the whole point. Unlimited is tested first and on
 * either signal, so "no ceiling" can never fall through into arithmetic and come
 * out as a full red bar; then an uncounted row, so a missing usage figure is
 * never drawn as zero usage; and only then the counted case, which uses the
 * server's `remaining` verbatim and computes nothing but the bar width.
 */
export function meterFor(row: LimitRow): Meter {
  const show = (n: number): string => formatAmount(row.key, n);
  if (row.unlimited || row.limit === null) {
    return {
      kind: "unlimited",
      tone: "ok",
      value: "Unlimited",
      // A usage figure is still worth showing when there is one — it is the only
      // number on an unlimited row — but there is nothing to be near, so there
      // is no bar and the tone stays calm no matter how large it gets.
      status: row.used !== null ? `${show(row.used)} used` : "No ceiling on this plan",
      percent: null,
      now: null,
      max: null,
    };
  }
  if (row.used === null) {
    return {
      kind: "uncounted",
      tone: "ok",
      value: show(row.limit),
      status: "Not counted for the whole workspace",
      percent: null,
      now: null,
      max: null,
    };
  }
  const { limit, used } = row;
  // A zero ceiling is "none at all", not a division by zero: the bar fills and
  // the tone is spent, which is exactly what an org with no allowance should see.
  const percent = limit === 0 ? 100 : Math.min(100, Math.max(0, (used / limit) * 100));
  // `remaining` decides whether anything is left, because the server computed it
  // and this client promised not to re-derive it. `percent` only draws the bar,
  // so the two can never disagree about the sentence.
  const tone: MeterTone =
    limit === 0 || row.remaining === 0 ? "spent" : percent >= WARN_FRACTION * 100 ? "warn" : "ok";
  return {
    kind: "counted",
    tone,
    value: `${show(used)} of ${show(limit)}`,
    status: meterStatus(row, tone, show),
    percent,
    now: used,
    max: limit,
  };
}

function meterStatus(row: LimitRow, tone: MeterTone, show: (n: number) => string): string {
  if (tone === "spent") {
    // Monthly allowances come back; a standing ceiling like boards or seats does
    // not, so "this month" would be a promise the row cannot keep.
    return row.period === "month" ? "Nothing left this month" : "Limit reached";
  }
  // No `remaining` on a counted row means the body was partly unreadable. Report
  // the usage, which is known, and claim nothing about the headroom, which isn't.
  return row.remaining !== null ? `${show(row.remaining)} left` : `${show(row.used ?? 0)} used`;
}

export interface FormatChip {
  format: string;
  label: string;
  allowed: boolean;
}

/**
 * Every format the app can export, flagged by whether this plan may. The locked
 * ones are listed rather than hidden: "PDF (needs a paid plan)" is the only way
 * the pane answers the question that brought someone here.
 */
export function exportFormatChips(row: ExportFormatsRow): FormatChip[] {
  const allowed = new Set(row.allowed);
  // Extras first from `all` so the order is the server's, then anything a plan
  // allows that this build's `all` list has not heard of yet.
  const formats = [...row.all, ...row.allowed.filter((f) => !row.all.includes(f))];
  return formats.map((format) => ({
    format,
    // Four-letter formats are acronyms (PNG, SVG, PDF, JSON); longer ones are
    // words, and "MERMAID" reads as shouting.
    label:
      format.length <= 4 ? format.toUpperCase() : format.charAt(0).toUpperCase() + format.slice(1),
    allowed: allowed.has(format),
  }));
}
