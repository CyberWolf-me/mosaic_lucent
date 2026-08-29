/**
 * Narrow readers for the Stripe objects this product reads (M4.3).
 *
 * Two rules hold everywhere in this file, and both exist to stop a specific
 * class of silent billing bug.
 *
 * 1. EVERY TIMESTAMP THAT LEAVES THIS FILE IS EPOCH MILLISECONDS. Stripe sends
 *    unix *seconds*; `subscriptions.periodEnd` in `db/schema.ts` is a bigint of
 *    epoch *milliseconds*, as is every other instant in this codebase.
 *    `secondsToMs` is the only conversion, and these parsers are its only
 *    callers, so a value that reaches `UsageStore.putSubscription` is already in
 *    the unit the column is declared in. Getting it wrong is invisible at the
 *    type level -- both units are a `number` in the right ballpark -- and shows
 *    up as `1767225600` stored where `1767225600000` belonged: a live
 *    subscription whose period ended on 21 January 1970, which
 *    `packages/web/src/billing.ts:510` will happily render to the customer.
 *
 * 2. NOTHING IS CAST. A field we cannot read is thrown on (`StripeShapeError`)
 *    rather than defaulted, because the caller is a webhook handler and the
 *    ledger has a `failed` state for exactly this: a payload we did not
 *    understand becomes a visible, retryable row instead of a subscription
 *    quietly written with a null period. Absence is tolerated only where Stripe
 *    documents the field as optional, and then it is `null`, never zero.
 *
 * Only the fields this product acts on are read. A Stripe subscription carries
 * upwards of forty; parsing all of them would be a second schema to keep in step
 * with no caller to justify it.
 */

/** Stripe unix seconds to this codebase epoch milliseconds. */
export function secondsToMs(seconds: number): number {
  return Math.round(seconds * 1000);
}

/** A Stripe payload we could not read. Fatal to one delivery, not the process. */
export class StripeShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StripeShapeError";
  }
}

/* ---------------------------- primitive readers ---------------------------- */

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requireRecord(value: unknown, what: string): Record<string, unknown> {
  const rec = asRecord(value);
  if (rec === null) throw new StripeShapeError(`stripe: ${what} is not an object`);
  return rec;
}

function requireString(rec: Record<string, unknown>, key: string, what: string): string {
  const value = rec[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new StripeShapeError(`stripe: ${what} is missing ${key}`);
  }
  return value;
}

function optionalString(rec: Record<string, unknown>, key: string): string | null {
  const value = rec[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function optionalNumber(rec: Record<string, unknown>, key: string): number | null {
  const value = rec[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function optionalBoolean(rec: Record<string, unknown>, key: string): boolean {
  return rec[key] === true;
}

/** An optional unix-seconds field, returned in milliseconds. */
function optionalTimestamp(rec: Record<string, unknown>, key: string): number | null {
  const seconds = optionalNumber(rec, key);
  return seconds === null ? null : secondsToMs(seconds);
}

/**
 * A Stripe reference field, which is a bare id when unexpanded and the whole
 * object when expanded. Both shapes are read because the nesting in a webhook
 * payload depends on how the event was configured, not on how we asked for it.
 */
function referenceId(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  const rec = asRecord(value);
  if (rec === null) return null;
  return optionalString(rec, "id");
}

/**
 * Stripe metadata is documented as string-to-string. Non-string values are
 * dropped rather than coerced: metadata is where the org id lives, and a
 * `String(someObject)` there would be a lookup key of `[object Object]`.
 */
function readMetadata(value: unknown): Record<string, string> {
  const rec = asRecord(value);
  if (rec === null) return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(rec)) {
    if (typeof raw === "string") out[key] = raw;
  }
  return out;
}

/** The `data` array of a Stripe list response or sub-list (`items`, `lines`). */
function listData(value: unknown): readonly unknown[] {
  const rec = asRecord(value);
  if (rec === null) return [];
  return Array.isArray(rec.data) ? (rec.data as readonly unknown[]) : [];
}

/* -------------------------------- customer -------------------------------- */

export interface StripeCustomer {
  id: string;
  email: string | null;
  name: string | null;
  metadata: Record<string, string>;
}

export function parseCustomer(value: unknown): StripeCustomer {
  const rec = requireRecord(value, "customer");
  return {
    id: requireString(rec, "id", "customer"),
    email: optionalString(rec, "email"),
    name: optionalString(rec, "name"),
    metadata: readMetadata(rec.metadata),
  };
}

/** A `GET /v1/customers` page. */
export function parseCustomerList(value: unknown): StripeCustomer[] {
  return listData(value).map((entry) => parseCustomer(entry));
}

/* ------------------------------ subscription ------------------------------ */

export interface StripeSubscriptionItem {
  id: string;
  priceId: string | null;
  quantity: number | null;
  /** Epoch ms. Where the period lives from the `basil` versions on; see below. */
  periodStart: number | null;
  periodEnd: number | null;
}

export interface StripeSubscription {
  id: string;
  customerId: string | null;
  /**
   * The raw status string. Deliberately not narrowed to `SubscriptionStatus`
   * here: `handlers.ts` owns that mapping, and it treats an unrecognised status
   * as a failure to retry rather than as a value to coerce, which it could not do
   * if this parser had already thrown the unknown string away.
   */
  status: string;
  items: readonly StripeSubscriptionItem[];
  /** Epoch ms. */
  periodStart: number | null;
  periodEnd: number | null;
  cancelAt: number | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: number | null;
  trialStart: number | null;
  trialEnd: number | null;
  metadata: Record<string, string>;
}

function parseSubscriptionItem(value: unknown): StripeSubscriptionItem {
  const rec = requireRecord(value, "subscription item");
  return {
    id: requireString(rec, "id", "subscription item"),
    priceId: referenceId(rec.price),
    quantity: optionalNumber(rec, "quantity"),
    periodStart: optionalTimestamp(rec, "current_period_start"),
    periodEnd: optionalTimestamp(rec, "current_period_end"),
  };
}

export function parseSubscription(value: unknown): StripeSubscription {
  const rec = requireRecord(value, "subscription");
  const items = listData(rec.items).map((entry) => parseSubscriptionItem(entry));
  const first = items[0];
  // The period is read from the subscription when it is there and from the first
  // item otherwise. Stripe moved `current_period_start`/`_end` off the
  // subscription and onto each item in the 2025-03-31.basil API version, so which
  // of the two holds it depends on the version in force. Reading both means
  // moving `LUCENT_STRIPE_API_VERSION` is a config change rather than a code
  // change, and means an event delivered under the account default version --
  // which a webhook endpoint does not get to choose -- still yields a period
  // instead of a null that would erase a renewal date from the billing screen.
  const periodStart = optionalTimestamp(rec, "current_period_start") ?? first?.periodStart ?? null;
  const periodEnd = optionalTimestamp(rec, "current_period_end") ?? first?.periodEnd ?? null;
  return {
    id: requireString(rec, "id", "subscription"),
    customerId: referenceId(rec.customer),
    status: requireString(rec, "status", "subscription"),
    items,
    periodStart,
    periodEnd,
    cancelAt: optionalTimestamp(rec, "cancel_at"),
    cancelAtPeriodEnd: optionalBoolean(rec, "cancel_at_period_end"),
    canceledAt: optionalTimestamp(rec, "canceled_at"),
    trialStart: optionalTimestamp(rec, "trial_start"),
    trialEnd: optionalTimestamp(rec, "trial_end"),
    metadata: readMetadata(rec.metadata),
  };
}

/* ---------------------------- checkout session ---------------------------- */

export interface StripeCheckoutSession {
  id: string;
  /** `subscription` for everything this product sells. */
  mode: string | null;
  /** `open` | `complete` | `expired`. */
  status: string | null;
  paymentStatus: string | null;
  customerId: string | null;
  subscriptionId: string | null;
  /** Where the browser is sent. Absent when a completed session is read back. */
  url: string | null;
  /** The org id, mirrored here as well as in metadata; see `service.ts`. */
  clientReferenceId: string | null;
  metadata: Record<string, string>;
}

export function parseCheckoutSession(value: unknown): StripeCheckoutSession {
  const rec = requireRecord(value, "checkout session");
  return {
    id: requireString(rec, "id", "checkout session"),
    mode: optionalString(rec, "mode"),
    status: optionalString(rec, "status"),
    paymentStatus: optionalString(rec, "payment_status"),
    customerId: referenceId(rec.customer),
    subscriptionId: referenceId(rec.subscription),
    url: optionalString(rec, "url"),
    clientReferenceId: optionalString(rec, "client_reference_id"),
    metadata: readMetadata(rec.metadata),
  };
}

/* -------------------------------- invoice --------------------------------- */

export interface StripeInvoice {
  id: string;
  customerId: string | null;
  subscriptionId: string | null;
  status: string | null;
  /** Minor units, as Stripe sends them. Never divided by 100 in this codebase. */
  amountPaid: number | null;
  amountDue: number | null;
  currency: string | null;
  /** Failed charge attempts on this invoice: the dunning counter. */
  attemptCount: number | null;
  /** Epoch ms. When Stripe will retry the card, while it still intends to. */
  nextPaymentAttempt: number | null;
  /** Epoch ms, from the first line service period. */
  periodEnd: number | null;
  hostedInvoiceUrl: string | null;
  billingReason: string | null;
}

/**
 * The subscription an invoice belongs to. Two shapes again: `subscription` up to
 * and including the 2025-02-24 versions, and
 * `parent.subscription_details.subscription` from `basil` on, where the flat
 * field was removed. Both are read for the same reason the period is: resolving
 * the org from a paid invoice is not something that may quietly start returning
 * null when an operator moves the API version pin.
 */
function invoiceSubscriptionId(rec: Record<string, unknown>): string | null {
  const flat = referenceId(rec.subscription);
  if (flat !== null) return flat;
  const parent = asRecord(rec.parent);
  const details = parent === null ? null : asRecord(parent.subscription_details);
  return details === null ? null : referenceId(details.subscription);
}

/** The service period the invoice covers, from its first line. */
function invoicePeriodEnd(rec: Record<string, unknown>): number | null {
  const line = asRecord(listData(rec.lines)[0]);
  if (line === null) return null;
  const period = asRecord(line.period);
  return period === null ? null : optionalTimestamp(period, "end");
}

export function parseInvoice(value: unknown): StripeInvoice {
  const rec = requireRecord(value, "invoice");
  return {
    id: requireString(rec, "id", "invoice"),
    customerId: referenceId(rec.customer),
    subscriptionId: invoiceSubscriptionId(rec),
    status: optionalString(rec, "status"),
    amountPaid: optionalNumber(rec, "amount_paid"),
    amountDue: optionalNumber(rec, "amount_due"),
    currency: optionalString(rec, "currency"),
    attemptCount: optionalNumber(rec, "attempt_count"),
    nextPaymentAttempt: optionalTimestamp(rec, "next_payment_attempt"),
    periodEnd: invoicePeriodEnd(rec),
    hostedInvoiceUrl: optionalString(rec, "hosted_invoice_url"),
    billingReason: optionalString(rec, "billing_reason"),
  };
}

/* ---------------------------- portal + envelope --------------------------- */

export interface StripePortalSession {
  id: string;
  url: string;
}

export function parsePortalSession(value: unknown): StripePortalSession {
  const rec = requireRecord(value, "portal session");
  return {
    id: requireString(rec, "id", "portal session"),
    url: requireString(rec, "url", "portal session"),
  };
}

/** A verified webhook envelope. `object` stays raw for the handler to parse. */
export interface StripeEventEnvelope {
  id: string;
  type: string;
  livemode: boolean;
  /** Epoch ms. */
  created: number | null;
  /** The version the payload was serialised under, for a shape-mismatch report. */
  apiVersion: string | null;
  object: Record<string, unknown>;
}

export function parseEventEnvelope(value: unknown): StripeEventEnvelope {
  const rec = requireRecord(value, "event");
  const data = requireRecord(rec.data, "event data");
  return {
    id: requireString(rec, "id", "event"),
    type: requireString(rec, "type", "event"),
    // A missing `livemode` reads as test mode: the field decides whether a row
    // counts as revenue, and guessing `live` would mix test traffic into it.
    livemode: optionalBoolean(rec, "livemode"),
    created: optionalTimestamp(rec, "created"),
    apiVersion: optionalString(rec, "api_version"),
    object: requireRecord(data.object, "event data.object"),
  };
}
