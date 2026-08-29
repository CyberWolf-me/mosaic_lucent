import type { UsageStore } from "../usageStore.js";
import type { StripeClient } from "./stripe.js";
import { StripeError } from "./stripe.js";
import type { StripeDispatcher } from "./handlers.js";
import type { StripeEventEnvelope } from "./objects.js";
import type { StripeEventStore } from "./events.js";
import { isMissing } from "./stripe.js";

/**
 * The checkout and portal orchestration (M4.3): the code a route calls, as
 * distinct from the Stripe REST calls (`stripe.ts`) and the webhook side
 * (`handlers.ts`).
 *
 * The one invariant this module owns is the one `handlers.ts:orgFor` depends
 * on: by the time a browser is redirected to Checkout, the org already has a
 * subscription row carrying the customer id. `checkout.session.completed`
 * resolves the org through stored ids or metadata; metadata is only honoured
 * for an org something local vouches for, and this placeholder row is the
 * voucher for an org that has never paid. Without it, the first checkout of a
 * brand-new org would be unresolvable and land in the ledger as `failed`.
 */

/** What `app.ts` receives from `main.ts` to make the billing routes real. */
export interface BillingIntegration {
  client: StripeClient;
  /** The endpoint signing secret, from `STRIPE_WEBHOOK_SECRET`. */
  webhookSecret: string;
  /** The idempotency ledger. Postgres when a database is configured. */
  events: StripeEventStore;
  dispatcher: StripeDispatcher;
}

/** Paths the hosted Stripe pages send the browser back to, on our origin. */
const CHECKOUT_SUCCESS_PATH = "/settings/billing?checkout=success";
const CHECKOUT_CANCEL_PATH = "/settings/billing?checkout=cancelled";
const PORTAL_RETURN_PATH = "/settings/billing";

export interface CheckoutRequest {
  orgId: string;
  /** A code from the plan catalogue (`plans.code`). */
  planCode: string;
  /** Defaults to monthly. Annual uses the plan's `stripeAnnualPriceId`. */
  interval?: "monthly" | "annual";
  /** Seat quantity Stripe bills per-period. Defaults to the row's seats, else 1. */
  seats?: number;
  /** Pre-fills Stripe's customer record; also the email-lookup fallback. */
  email?: string | null;
  orgName?: string | null;
}

export type BillingOutcome =
  | { ok: true; url: string }
  | { ok: false; status: 400 | 502; error: string };

/**
 * Start a hosted Checkout Session for one org, writing the placeholder
 * subscription row before the redirect (see the module header).
 *
 * A plan change for an org that already has a live subscription is
 * deliberately refused with a pointer at the portal: the portal carries
 * proration, cancellation and card updates, and letting checkout create a
 * second subscription beside the first would split the org's billing history
 * in two. `planAndSeats` in handlers.ts would then see two priced lines and
 * throw on every later webhook.
 */
export async function startCheckout(
  deps: { client: StripeClient; usageStore: UsageStore },
  request: CheckoutRequest,
  origin: string,
  now: number,
): Promise<BillingOutcome> {
  const { client, usageStore } = deps;
  const plan = await usageStore.plan(request.planCode);
  if (!plan) return { ok: false, status: 400, error: "unknown plan" };
  const priceId = request.interval === "annual" ? plan.stripeAnnualPriceId : plan.stripePriceId;
  if (!priceId) {
    return {
      ok: false,
      status: 400,
      error: `plan ${plan.code} has no Stripe ${request.interval === "annual" ? "annual " : ""}price configured`,
    };
  }

  const existing = await usageStore.subscription(request.orgId);
  if (existing?.stripeSubscriptionId && existing.status !== "canceled") {
    return { ok: false, status: 400, error: "use the billing portal to change your subscription" };
  }

  let customerId = existing?.stripeCustomerId ?? null;
  if (!customerId && request.email) {
    // Find before create: a repeat visitor whose stored row was lost must not
    // become a second customer with a second billing history (stripe.ts:317).
    const found = await client.findCustomerByEmail(request.email).catch(() => null);
    customerId = found?.id ?? null;
  }
  if (!customerId) {
    const created = await client.createCustomer({
      orgId: request.orgId,
      email: request.email ?? undefined,
      name: request.orgName ?? undefined,
    });
    customerId = created.id;
  }

  const quantity = Math.max(1, Math.floor(request.seats ?? existing?.seats ?? 1));
  if (!existing) {
    await usageStore.putSubscription({
      orgId: request.orgId,
      plan: plan.code,
      seats: quantity,
      // `incomplete` is Stripe's own word for "checkout started, not paid".
      // It entitles nothing (ENTITLING_STATUSES), so writing it cannot turn a
      // Free org into a paying one ahead of the webhook.
      status: "incomplete",
      periodStart: null,
      periodEnd: null,
      cancelAt: null,
      trialEndsAt: null,
      stripeCustomerId: customerId,
      stripeSubscriptionId: null,
      createdAt: now,
      updatedAt: now,
    });
  } else if (!existing.stripeCustomerId) {
    // Keep the row's plan and status; only attach the customer id.
    await usageStore.putSubscription({ ...existing, stripeCustomerId: customerId, updatedAt: now });
  }

  try {
    const session = await client.createCheckoutSession({
      orgId: request.orgId,
      planCode: plan.code,
      customerId,
      priceId,
      quantity,
      successUrl: `${origin}${CHECKOUT_SUCCESS_PATH}`,
      cancelUrl: `${origin}${CHECKOUT_CANCEL_PATH}`,
    });
    // The parse keeps Stripe's own nullability (`objects.ts` types url as
    // `string | null`): Stripe answers null for sessions it will not host.
    // This client always requests a hosted session, so null means the
    // account configuration refused it -- a 502, not a redirect to `null`.
    if (!session.url) {
      return { ok: false, status: 502, error: "stripe did not return a checkout url" };
    }
    return { ok: true, url: session.url };
  } catch (err) {
    return { ok: false, status: 502, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Open the Stripe Billing Portal for one org. Everything a customer does there
 * arrives back as a webhook and is written by `handlers.ts`, so this call is
 * deliberately thin: resolve the customer, ask Stripe for a URL, hand it back.
 */
export async function openPortal(
  deps: { client: StripeClient; usageStore: UsageStore },
  orgId: string,
  origin: string,
  _now: number,
): Promise<BillingOutcome> {
  const sub = await deps.usageStore.subscription(orgId);
  if (!sub?.stripeCustomerId) {
    return {
      ok: false,
      status: 400,
      error: "no billing profile yet — start a subscription first",
    };
  }
  try {
    const session = await deps.client.createPortalSession({
      customerId: sub.stripeCustomerId,
      returnUrl: `${origin}${PORTAL_RETURN_PATH}`,
    });
    return { ok: true, url: session.url };
  } catch (err) {
    return { ok: false, status: 502, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The sweep's event lookup (webhook.ts:StripeEventLookup) over the REST
 * client. Stripe keeps events for ~30 days; past that, or for a test/live
 * mix-up, it answers 404 and the sweep records the row `failed` rather than
 * retrying forever.
 */
export function stripeEventLookup(client: StripeClient) {
  return {
    getEvent(id: string): Promise<StripeEventEnvelope | null> {
      return client.getEvent(id);
    },
  };
}

export { isMissing, StripeError };

/**
 * Attach the deployment's Stripe price ids to the plan catalogue (C2).
 *
 * The catalogue is seeded from `plans.ts`, which carries prices but not Stripe
 * price ids — those are deployment configuration (a Stripe product per
 * deployment), so they arrive as env: `LUCENT_STRIPE_PRICE_PRO=price_…` and
 * `LUCENT_STRIPE_PRICE_PRO_ANNUAL=price_…`. Applied after `seedPlans` at boot;
 * handlers read them back out of the catalogue when a webhook names a price.
 */
export async function applyStripePriceOverrides(
  usageStore: UsageStore,
  env: Record<string, string | undefined>,
  now: number,
): Promise<number> {
  const plans = await usageStore.plans();
  let applied = 0;
  for (const plan of plans) {
    const prefix = `LUCENT_STRIPE_PRICE_${plan.code.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
    const monthly = env[prefix];
    const annual = env[`${prefix}_ANNUAL`];
    if (!monthly && !annual) continue;
    await usageStore.putPlan({
      ...plan,
      stripePriceId: monthly ?? plan.stripePriceId,
      stripeAnnualPriceId: annual ?? plan.stripeAnnualPriceId,
      updatedAt: now,
    });
    applied += 1;
  }
  return applied;
}
