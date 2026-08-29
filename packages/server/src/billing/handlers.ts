import type { Logger } from "../obs/logger.js";
import type { StoredPlan, StoredSubscription, SubscriptionStatus } from "../usageStore.js";
import {
  parseCheckoutSession,
  parseInvoice,
  parseSubscription,
  type StripeEventEnvelope,
  type StripeInvoice,
  type StripeSubscription,
} from "./objects.js";
import type { DispatchOutcome } from "./events.js";

/**
 * Stripe lifecycle handlers (M4.3): the only place a webhook payload becomes a
 * row in `subscriptions`.
 *
 * Three rules shape every handler here.
 *
 * ONE WRITER. Every path ends in the same `putSubscription` call, built by
 * `writeSubscription` from a Stripe subscription object and nothing else. The
 * three `customer.subscription.*` events carry that object in their payload; the
 * completed checkout and both invoice events do not, so they re-read it. That
 * costs one GET per invoice and buys a single mapping from Stripe's vocabulary to
 * this schema's, instead of one per event type quietly disagreeing about seats.
 *
 * Stripe does not guarantee delivery order, and this does not try to. A
 * subscription payload is a snapshot at the moment Stripe emitted it, so an
 * out-of-order pair can briefly write the older of two statuses; the next
 * lifecycle event restates the whole object and the row converges. What the
 * re-reads do rule out is the worse version of that race -- a late
 * `checkout.session.completed`, whose own payload has no status at all, landing
 * on top of a newer subscription update and inventing one.
 *
 * NO GUESSING. An unrecognised subscription status, a price we cannot map to a
 * plan, an org we cannot resolve: all throw. The ledger records `failed` with the
 * message and the delivery is retried, which is the only outcome that leaves both
 * a customer and an operator able to see what happened. The alternative -- a
 * default plan, a coerced status -- writes a row that looks fine and bills wrong.
 *
 * STATUS COMES FROM STRIPE, ENTITLEMENT COMES FROM `entitlements.ts`. Nothing
 * here decides whether `past_due` still entitles an org; it writes `past_due` and
 * `ENTITLING_STATUSES` (entitlements.ts:55) decides. That is what makes dunning a
 * one-line policy instead of a rule duplicated in every handler.
 */

/**
 * The slice of `UsageStore` the billing path writes through, declared here rather
 * than importing the interface -- the same reason `EntitlementSource`
 * (entitlements.ts:83) is declared at its consumer: a handler test needs four
 * stub methods, and nothing in this module should be able to reach the metering
 * write side.
 */
export interface BillingSubscriptionStore {
  subscription(orgId: string): Promise<StoredSubscription | undefined>;
  putSubscription(sub: StoredSubscription): Promise<void>;
  subscriptionByStripeId(
    kind: "customer" | "subscription",
    id: string,
  ): Promise<StoredSubscription | undefined>;
  plans(): Promise<StoredPlan[]>;
}

/** Just enough of `StripeClient` to re-read a subscription. */
export interface SubscriptionLookup {
  getSubscription(id: string): Promise<StripeSubscription | null>;
}

/**
 * Where receipts and dunning mail hang. Optional, and deliberately not
 * implemented here: sending mail needs the org owner address, which lives behind
 * stores this module has no business reading. `email/templates.ts:141` already has
 * `receiptEmail` waiting for it.
 *
 * A throwing sink is logged and swallowed. Mail is best-effort here exactly as it
 * is in `email/http.ts`; making Stripe redeliver a paid invoice because an SMTP
 * server was down would turn a missing email into a billing incident.
 */
export interface BillingEventSink {
  invoicePaid?(event: {
    orgId: string;
    invoiceId: string;
    amountPaidCents: number | null;
    currency: string | null;
    periodEnd: number | null;
    hostedInvoiceUrl: string | null;
  }): Promise<void> | void;
  paymentFailed?(event: {
    orgId: string;
    invoiceId: string;
    amountDueCents: number | null;
    currency: string | null;
    attemptCount: number | null;
    /** Epoch ms of Stripe's next retry, or null when dunning is exhausted. */
    nextAttemptAt: number | null;
    hostedInvoiceUrl: string | null;
  }): Promise<void> | void;
}

/**
 * Exhaustive by construction. `SubscriptionStatus` (usageStore.ts:30) is a union
 * of Stripe's vocabulary, and this object must name every member: add one to the
 * union without adding it here and the compiler rejects this file, which is the
 * whole point -- a status we cannot store is a subscription we would silently
 * mis-entitle.
 */
const KNOWN_STATUSES: Record<SubscriptionStatus, true> = {
  trialing: true,
  active: true,
  past_due: true,
  canceled: true,
  unpaid: true,
  incomplete: true,
  incomplete_expired: true,
  paused: true,
};

/**
 * Stripe's status string, or null when it is one this build does not know. The
 * assertion is guarded by the lookup above, and `objects.ts` deliberately leaves
 * `status` a bare `string` so the decision lands here rather than in a parser that
 * has no way to fail usefully.
 */
export function toSubscriptionStatus(raw: string): SubscriptionStatus | null {
  return Object.prototype.hasOwnProperty.call(KNOWN_STATUSES, raw)
    ? (raw as SubscriptionStatus)
    : null;
}

/**
 * The event types that change state. Anything else is recorded `ignored` -- see
 * `events.ts` on why an ignored row is kept rather than dropped.
 *
 * `invoice.payment_succeeded` is deliberately absent even though Stripe sends it
 * alongside `invoice.paid` for the same money. Handling both would upsert twice
 * (harmless) and fire the receipt sink twice (not harmless: two receipts for one
 * charge). An endpoint subscribed only to `payment_succeeded` therefore records
 * `ignored` rows, which is the visible failure mode -- the operator can see in the
 * ledger exactly which type to enable.
 */
export const HANDLED_EVENT_TYPES = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
] as const;

export type HandledEventType = (typeof HANDLED_EVENT_TYPES)[number];

export function isHandledEventType(type: string): type is HandledEventType {
  return (HANDLED_EVENT_TYPES as readonly string[]).includes(type);
}

export interface StripeDispatcherOptions {
  store: BillingSubscriptionStore;
  lookup: SubscriptionLookup;
  logger?: Logger;
  sink?: BillingEventSink;
  /**
   * Does this org exist? Supplied by `main.ts` from the org store, because
   * `subscriptions.orgId` is a foreign key (schema.ts) and an id read out of
   * Stripe metadata is attacker-influenced input until something local vouches
   * for it. Without it, metadata is only trusted for an org that already has a
   * subscription row -- which covers every checkout this app started, and refuses
   * a subscription created by hand in the Stripe dashboard.
   */
  orgExists?: (orgId: string) => Promise<boolean>;
}

export interface StripeDispatcher {
  /** Apply one verified event. Throws to mean "retry me". */
  dispatch(event: StripeEventEnvelope, now: number): Promise<DispatchOutcome>;
}

export function createStripeDispatcher(options: StripeDispatcherOptions): StripeDispatcher {
  const { store, lookup, logger, sink } = options;

  async function dispatch(event: StripeEventEnvelope, now: number): Promise<DispatchOutcome> {
    switch (event.type) {
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        // The payload *is* the subscription, including for `deleted`, where Stripe
        // sends the final object with `status: "canceled"`. No re-read needed, and
        // no special case: a canceled row stops entitling because
        // `statusEntitles` says so, while keeping the plan and the Stripe ids so
        // the billing screen can say which plan lapsed.
        const sub = parseSubscription(event.object);
        const orgId = await orgFor(sub.metadata.orgId, sub.id, sub.customerId);
        await writeSubscription(orgId, sub, now);
        return { kind: "processed", orgId, detail: sub.status };
      }

      case "checkout.session.completed": {
        const session = parseCheckoutSession(event.object);
        if (session.mode !== "subscription") {
          // Nothing else is sold. Recorded rather than dropped so a one-off
          // payment link someone adds later is visible in the ledger.
          return { kind: "ignored", detail: "mode=" + (session.mode ?? "unknown") };
        }
        if (!session.subscriptionId) {
          // A completed subscription session always names one. If it does not, the
          // session is not yet what it claims and a retry is the honest answer.
          throw new Error("checkout session " + session.id + " completed with no subscription id");
        }
        const orgId = await orgFor(
          session.metadata.orgId ?? session.clientReferenceId,
          session.subscriptionId,
          session.customerId,
        );
        const sub = await requireSubscription(session.subscriptionId);
        await writeSubscription(orgId, sub, now);
        return { kind: "processed", orgId, detail: "checkout " + session.id };
      }

      case "invoice.paid":
      case "invoice.payment_failed": {
        const invoice = parseInvoice(event.object);
        if (!invoice.subscriptionId) {
          // A one-off invoice: no subscription state to move. Kept as a row so a
          // manual invoice raised in the dashboard is not a silent gap.
          return { kind: "ignored", detail: "invoice " + invoice.id + " has no subscription" };
        }
        const orgId = await orgFor(null, invoice.subscriptionId, invoice.customerId);
        // Re-read rather than patch from the invoice. `invoice.paid` is the moment
        // a `past_due` org becomes `active` again and its period rolls forward, and
        // the subscription object is the only place both facts are authoritative.
        const sub = await requireSubscription(invoice.subscriptionId);
        await writeSubscription(orgId, sub, now);
        await notify(event.type, orgId, invoice);
        return { kind: "processed", orgId, detail: invoice.id + " " + (invoice.status ?? "?") };
      }

      default:
        return { kind: "ignored", detail: event.type };
    }
  }

  /**
   * Which org this event belongs to.
   *
   * Our own rows are asked first and metadata last, because the Stripe ids are
   * facts we recorded ourselves (both columns are uniquely indexed) whereas
   * `metadata.orgId` is a string that travelled out to Stripe and back. Trusting
   * it unconditionally would let anything that can reach the webhook name any org;
   * the FK would catch a *nonexistent* org, but not a real one belonging to
   * somebody else.
   *
   * So metadata is only honoured when something local vouches for the org: an
   * existing subscription row, or `orgExists`. That covers the first checkout of
   * an org that has never paid -- `service.ts` writes the placeholder row before
   * redirecting -- and a subscription created by hand in the dashboard, provided
   * `main.ts` wired `orgExists`.
   */
  async function orgFor(
    metadataOrgId: string | null | undefined,
    subscriptionId: string | null,
    customerId: string | null,
  ): Promise<string> {
    if (subscriptionId) {
      const row = await store.subscriptionByStripeId("subscription", subscriptionId);
      if (row) return row.orgId;
    }
    if (customerId) {
      const row = await store.subscriptionByStripeId("customer", customerId);
      if (row) return row.orgId;
    }
    if (metadataOrgId) {
      const row = await store.subscription(metadataOrgId);
      if (row) return metadataOrgId;
      if (options.orgExists && (await options.orgExists(metadataOrgId))) return metadataOrgId;
      throw new Error(
        "stripe metadata names org " +
          metadataOrgId +
          " which has no subscription row" +
          (options.orgExists ? " and does not exist" : " (orgExists not configured)"),
      );
    }
    throw new Error(
      "cannot resolve an org from subscription=" +
        (subscriptionId ?? "none") +
        " customer=" +
        (customerId ?? "none") +
        " and no usable metadata",
    );
  }

  /**
   * The subscription, or a throw. Stripe occasionally delivers an event naming an
   * object its own API has not caught up with; that is exactly the case a retry
   * fixes, so it must not be swallowed into a half-written row.
   */
  async function requireSubscription(id: string): Promise<StripeSubscription> {
    const sub = await lookup.getSubscription(id);
    if (!sub) throw new Error("stripe subscription " + id + " could not be read back");
    return sub;
  }

  /**
   * The single write. Everything Stripe told us, in this schema's units, with the
   * two fields Stripe does not have an opinion about preserved: `createdAt` (the
   * row's own birthday, kept so "customer since" survives a plan change) and the
   * org id, which is resolved before we get here.
   */
  async function writeSubscription(
    orgId: string,
    sub: StripeSubscription,
    now: number,
  ): Promise<void> {
    const existing = await store.subscription(orgId);
    const status = toSubscriptionStatus(sub.status);
    if (!status) {
      // A status this build cannot store. Throwing means the ledger keeps the
      // string and the delivery is retried, so deploying a build that knows it
      // fixes the org; coercing to `canceled` would cut off a paying customer and
      // coercing to `active` would give the product away.
      throw new Error(
        "stripe subscription " + sub.id + " has unrecognised status " + JSON.stringify(sub.status),
      );
    }
    const { plan, seats } = await planAndSeats(sub, existing);
    await store.putSubscription({
      orgId,
      plan,
      seats,
      status,
      periodStart: sub.periodStart,
      periodEnd: sub.periodEnd,
      // Stripe sets `cancel_at` when a cancellation is scheduled, but older API
      // versions only set the boolean. The end of the paid period is when the
      // cancellation takes effect, so it is the right value to fall back to -- and
      // it is what the billing screen renders as "cancels on".
      cancelAt: sub.cancelAt ?? (sub.cancelAtPeriodEnd ? sub.periodEnd : null),
      trialEndsAt: sub.trialEnd,
      stripeCustomerId: sub.customerId ?? existing?.stripeCustomerId ?? null,
      stripeSubscriptionId: sub.id,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    logger?.info("stripe.subscription.written", {
      orgId,
      plan,
      seats,
      status,
      subscriptionId: sub.id,
    });
  }

  /**
   * Which plan, and how many seats.
   *
   * The price the customer is actually being billed for decides the plan -- not
   * `metadata.planCode`, which records what we *intended* when the session was
   * created and goes stale the moment somebody switches plan in the Billing Portal.
   * Seats come from the quantity on that same line, so the two can never disagree
   * about which line they described.
   *
   * The catalogue is re-read per event rather than cached: an operator who has just
   * pasted a price id into `plans` to fix a failing event should see the retry
   * succeed, not wait for a restart.
   */
  async function planAndSeats(
    sub: StripeSubscription,
    existing: StoredSubscription | undefined,
  ): Promise<{ plan: string; seats: number }> {
    const catalogue = await store.plans();
    for (const item of sub.items) {
      if (!item.priceId) continue;
      const match = catalogue.find(
        (p) => p.stripePriceId === item.priceId || p.stripeAnnualPriceId === item.priceId,
      );
      if (match) return { plan: match.code, seats: normaliseSeats(item.quantity, existing) };
    }

    // No priced line we recognise. Metadata is the documented fallback for a
    // subscription created before its price was in the catalogue, and it is only
    // honoured for a code the catalogue actually has -- `subscriptions.plan` is a
    // foreign key, so an unknown code would fail the insert anyway, and failing
    // here says why.
    const declared = sub.metadata.planCode;
    if (declared && catalogue.some((p) => p.code === declared)) {
      return { plan: declared, seats: normaliseSeats(sub.items[0]?.quantity ?? null, existing) };
    }

    const prices = sub.items.map((i) => i.priceId ?? "?").join(", ") || "none";
    throw new Error(
      "stripe subscription " +
        sub.id +
        " prices [" +
        prices +
        "] match no plan; set stripePriceId on the plan row" +
        (declared ? " (metadata planCode " + declared + " is not in the catalogue)" : ""),
    );
  }

  /**
   * Seats, floored at one. Stripe omits `quantity` on a metered price and can send
   * zero on a canceled line; either would multiply every pooled per-seat allowance
   * by nothing, so the existing seat count is preferred and one is the floor --
   * matching `resolveLimit` in plans.ts, which floors seats the same way.
   */
  function normaliseSeats(
    quantity: number | null,
    existing: StoredSubscription | undefined,
  ): number {
    if (quantity !== null && Number.isFinite(quantity) && quantity >= 1) {
      return Math.floor(quantity);
    }
    return Math.max(1, Math.floor(existing?.seats ?? 1));
  }

  /**
   * Tell the sink, if there is one, and never let it fail the event. The row is
   * already written by the time this runs, so a thrown receipt would make Stripe
   * redeliver an invoice we have correctly recorded -- trading a missing email for
   * a duplicated one.
   */
  async function notify(
    type: "invoice.paid" | "invoice.payment_failed",
    orgId: string,
    invoice: StripeInvoice,
  ): Promise<void> {
    if (!sink) return;
    try {
      if (type === "invoice.paid") {
        await sink.invoicePaid?.({
          orgId,
          invoiceId: invoice.id,
          amountPaidCents: invoice.amountPaid,
          currency: invoice.currency,
          periodEnd: invoice.periodEnd,
          hostedInvoiceUrl: invoice.hostedInvoiceUrl,
        });
      } else {
        await sink.paymentFailed?.({
          orgId,
          invoiceId: invoice.id,
          amountDueCents: invoice.amountDue,
          currency: invoice.currency,
          attemptCount: invoice.attemptCount,
          nextAttemptAt: invoice.nextPaymentAttempt,
          hostedInvoiceUrl: invoice.hostedInvoiceUrl,
        });
      }
    } catch (err) {
      logger?.warn("stripe.sink.failed", {
        type,
        orgId,
        invoiceId: invoice.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { dispatch };
}
