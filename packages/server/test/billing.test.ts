import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { createHmac } from "node:crypto";
import { MockProvider, MockImageProvider } from "@lucent/ai";
import { createApp } from "../src/app.js";
import { InMemoryUserStore } from "../src/accounts.js";
import { InMemoryBoardStore } from "../src/boards.js";
import { InMemoryOrgStore } from "../src/orgs.js";
import { InMemoryOrgInviteStore } from "../src/invites.js";
import { InMemoryNotificationStore } from "../src/notifications.js";
import { InMemorySessionStore } from "../src/sessions.js";
import { UsageTracker, limitsFromEnv } from "../src/usage.js";
import { Telemetry } from "../src/telemetry.js";
import { Limiter } from "../src/limiter.js";
import { InMemoryTicketStore } from "../src/realtimeTicket.js";
import { readConfig } from "../src/config.js";
import { InMemoryUsageStore, type StoredSubscription } from "../src/usageStore.js";
import { InMemoryStripeEventStore, type StripeEventStore } from "../src/billing/events.js";
import {
  createStripeWebhookReceiver,
  sweepStripeEvents,
  verifyStripeSignature,
} from "../src/billing/webhook.js";
import { createStripeDispatcher } from "../src/billing/handlers.js";
import { StripeClient, StripeError } from "../src/billing/stripe.js";
import { openPortal, startCheckout } from "../src/billing/service.js";
import { PLAN_LADDER } from "../src/plans.js";
import { parseEventEnvelope, parseSubscription } from "../src/billing/objects.js";
import type { BillingSubscriptionStore } from "../src/billing/handlers.js";

/**
 * M4.3 end to end: the webhook protocol (signature → ledger → dispatch), the
 * lifecycle handlers, the retry sweep, and the checkout/portal service — then
 * the HTTP routes that put them on the wire. Stripe itself is faked at the one
 * seam `StripeClient` exposes for it (`fetchImpl`), so the tests exercise the
 * real parsers and the real request encoding, not a mock of the client.
 */

const SECRET = "whsec_test-signing-secret";
const NOW = 1_700_000_000_000;

/* ------------------------------ fixtures ---------------------------------- */

const PRICE_PRO = "price_test_pro";
const ORG = "org_bill_test";
const CUSTOMER = "cus_test_1";
const SUB = "sub_test_1";

/** A Stripe subscription object, API-shaped, one priced line. */
function subscriptionShape(overrides: Record<string, unknown> = {}) {
  return {
    id: SUB,
    object: "subscription",
    customer: CUSTOMER,
    status: "active",
    items: {
      object: "list",
      data: [
        {
          id: "si_test_1",
          object: "subscription_item",
          price: { id: PRICE_PRO, object: "price" },
          quantity: 5,
          current_period_start: 1_700_000_000,
          current_period_end: 1_700_259_200,
        },
      ],
    },
    current_period_start: 1_700_000_000,
    current_period_end: 1_700_259_200,
    cancel_at_period_end: false,
    metadata: { orgId: ORG, planCode: "pro" },
    ...overrides,
  };
}

function eventEnvelope(type: string, object: unknown, id = "evt_test_1") {
  return {
    id,
    object: "event",
    api_version: "2025-03-31.basil",
    created: Math.floor(NOW / 1000),
    data: { object },
    livemode: false,
    type,
  };
}

/** What the dispatcher and sweep consume: the raw event, parsed. */
function envelope(type: string, object: unknown, id = "evt_test_1") {
  return parseEventEnvelope(eventEnvelope(type, object, id));
}

/** Signs a payload exactly the way Stripe does. */
function sign(payload: string, atSeconds: number, secret = SECRET): string {
  const mac = createHmac("sha256", secret).update(`${atSeconds}.`).update(payload, "utf8");
  return `t=${atSeconds},v1=${mac.digest("hex")}`;
}

function signedDelivery(type: string, object: unknown, clock = NOW, id = "evt_test_1") {
  const payload = JSON.stringify(eventEnvelope(type, object, id));
  return { payload, signature: sign(payload, Math.floor(clock / 1000)) };
}

/** A BillingSubscriptionStore over one map — the handlers' entire write side. */
function subscriptionStore(initial: StoredSubscription[] = []): BillingSubscriptionStore & {
  rows: Map<string, StoredSubscription>;
} {
  const rows = new Map(initial.map((s) => [s.orgId, s]));
  const catalogue = PLAN_LADDER.map((plan) => ({
    code: plan.code,
    displayName: plan.code,
    rank: 0,
    limits: {} as never,
    priceCents: null,
    annualPriceCents: null,
    currency: "usd",
    stripePriceId: plan.code === "pro" ? PRICE_PRO : null,
    stripeAnnualPriceId: null,
    updatedAt: 0,
  }));
  return {
    rows,
    async subscription(orgId: string) {
      return rows.get(orgId);
    },
    async putSubscription(sub: StoredSubscription) {
      rows.set(sub.orgId, sub);
    },
    async subscriptionByStripeId(kind, id) {
      for (const row of rows.values()) {
        if (kind === "customer" && row.stripeCustomerId === id) return row;
        if (kind === "subscription" && row.stripeSubscriptionId === id) return row;
      }
      return undefined;
    },
    async plans() {
      return catalogue;
    },
  };
}

/* ------------------------------- signature -------------------------------- */

describe("verifyStripeSignature", () => {
  const payload = JSON.stringify({ id: "evt_x" });

  it("accepts a current, correctly signed delivery", () => {
    const result = verifyStripeSignature({
      payload,
      header: sign(payload, Math.floor(NOW / 1000)),
      secret: SECRET,
      now: () => NOW,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a tampered body as no_match", () => {
    const result = verifyStripeSignature({
      payload: payload + " ",
      header: sign(payload, Math.floor(NOW / 1000)),
      secret: SECRET,
      now: () => NOW,
    });
    expect(result).toMatchObject({ ok: false, reason: "no_match" });
  });

  it("rejects a stale timestamp, and a future one too", () => {
    const stale = verifyStripeSignature({
      payload,
      header: sign(payload, Math.floor(NOW / 1000) - 400),
      secret: SECRET,
      now: () => NOW,
    });
    expect(stale).toMatchObject({ ok: false, reason: "timestamp_out_of_tolerance" });

    const future = verifyStripeSignature({
      payload,
      header: sign(payload, Math.floor(NOW / 1000) + 400),
      secret: SECRET,
      now: () => NOW,
    });
    expect(future).toMatchObject({ ok: false, reason: "timestamp_out_of_tolerance" });
  });

  it("accepts either signature during a secret rotation", () => {
    const old = sign(payload, Math.floor(NOW / 1000), "whsec_old");
    const header = `${sign(payload, Math.floor(NOW / 1000))},v1=${old.split("v1=")[1]}`;
    const result = verifyStripeSignature({ payload, header, secret: SECRET, now: () => NOW });
    expect(result.ok).toBe(true);
  });

  it("classifies missing and malformed headers", () => {
    expect(
      verifyStripeSignature({ payload, header: undefined, secret: SECRET, now: () => NOW }),
    ).toMatchObject({ ok: false, reason: "missing_header" });
    expect(
      verifyStripeSignature({ payload, header: "garbage", secret: SECRET, now: () => NOW }),
    ).toMatchObject({ ok: false, reason: "malformed_header" });
    expect(
      verifyStripeSignature({
        payload,
        header: `v1=${"a".repeat(64)}`,
        secret: SECRET,
        now: () => NOW,
      }),
    ).toMatchObject({ ok: false, reason: "missing_timestamp" });
  });
});

/* ------------------------------- receiver --------------------------------- */

describe("stripe webhook receiver", () => {
  const sub = subscriptionStore([
    {
      orgId: ORG,
      plan: "free",
      seats: 1,
      status: "incomplete",
      periodStart: null,
      periodEnd: null,
      cancelAt: null,
      trialEndsAt: null,
      stripeCustomerId: CUSTOMER,
      stripeSubscriptionId: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
  ]);
  const dispatcher = createStripeDispatcher({
    store: sub,
    lookup: { getSubscription: async () => parseSubscription(subscriptionShape()) },
  });

  function receiver(store: StripeEventStore = new InMemoryStripeEventStore()) {
    return createStripeWebhookReceiver({
      secret: SECRET,
      store,
      dispatcher,
      now: () => NOW,
    });
  }

  it("answers 400 invalid_signature for an unsigned or forged delivery", async () => {
    const r = receiver();
    const bad = await r.receive({ payload: "{}", signature: "t=1,v1=deadbeef" });
    expect(bad.status).toBe(400);
    expect(bad.outcome).toBe("invalid_signature");

    const none = await r.receive({ payload: "{}", signature: undefined });
    expect(none.status).toBe(400);
  });

  it("answers 400 invalid_payload for a signed body that is not an event", async () => {
    const r = receiver();
    const payload = JSON.stringify({ nope: true });
    const result = await r.receive({ payload, signature: sign(payload, Math.floor(NOW / 1000)) });
    expect(result.status).toBe(400);
    expect(result.outcome).toBe("invalid_payload");
  });

  it("processes a valid delivery and answers 200", async () => {
    const r = receiver();
    const result = await r.receive(
      signedDelivery("customer.subscription.updated", subscriptionShape()),
    );
    expect(result.status).toBe(200);
    expect(result.outcome).toBe("processed");
    // The placeholder row became a real subscription.
    const row = sub.rows.get(ORG);
    expect(row?.status).toBe("active");
    expect(row?.plan).toBe("pro");
    expect(row?.seats).toBe(5);
  });

  it("a redelivery is a 200 duplicate, not a second handler run", async () => {
    const r = receiver();
    const delivery = signedDelivery("customer.subscription.updated", subscriptionShape());
    expect((await r.receive(delivery)).outcome).toBe("processed");
    const again = await r.receive({ ...delivery });
    expect(again.status).toBe(200);
    expect(again.outcome).toBe("duplicate");
    expect(sub.rows.get(ORG)?.updatedAt).toBe(NOW);
  });

  it("a handler throw is a 500 failed row that retries, until attempts run out", async () => {
    const store = new InMemoryStripeEventStore();
    const throwing = createStripeDispatcher({
      store: subscriptionStore(),
      lookup: { getSubscription: async () => null },
    });
    const r = createStripeWebhookReceiver({
      secret: SECRET,
      store,
      dispatcher: throwing,
      now: () => NOW,
      maxAttempts: 2,
    });
    const delivery = signedDelivery("customer.subscription.updated", subscriptionShape());

    const first = await r.receive(delivery);
    expect(first.status).toBe(500);
    expect(first.outcome).toBe("failed");
    expect((await store.get("evt_test_1"))?.status).toBe("failed");

    // Second attempt is the last: 200 exhausted, which stops Stripe redelivering
    // while the ledger keeps the reason for the sweep.
    const second = await r.receive({ ...delivery });
    expect(second.status).toBe(200);
    expect(second.outcome).toBe("exhausted");
  });

  it("an unknown event type is recorded ignored, 200", async () => {
    const store = new InMemoryStripeEventStore();
    const r = receiver(store);
    const result = await r.receive(
      signedDelivery("customer.discount.created", { id: "di_1" }, NOW, "evt_ign_route"),
    );
    expect(result.status).toBe(200);
    expect(result.outcome).toBe("ignored");
    expect((await store.get("evt_ign_route"))?.status).toBe("ignored");
  });
});

/* ------------------------------ dispatcher -------------------------------- */

describe("stripe dispatcher", () => {
  it("checkout.session.completed re-reads the subscription and writes it", async () => {
    const sub = subscriptionStore([
      {
        orgId: ORG,
        plan: "free",
        seats: 1,
        status: "incomplete",
        periodStart: null,
        periodEnd: null,
        cancelAt: null,
        trialEndsAt: null,
        stripeCustomerId: CUSTOMER,
        stripeSubscriptionId: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);
    const dispatcher = createStripeDispatcher({
      store: sub,
      lookup: { getSubscription: async () => parseSubscription(subscriptionShape()) },
    });
    const session = {
      id: "cs_test_1",
      object: "checkout.session",
      mode: "subscription",
      customer: CUSTOMER,
      subscription: SUB,
      client_reference_id: ORG,
      metadata: { orgId: ORG, planCode: "pro" },
    };
    const outcome = await dispatcher.dispatch(envelope("checkout.session.completed", session), NOW);
    expect(outcome).toMatchObject({ kind: "processed", orgId: ORG });
    const row = sub.rows.get(ORG)!;
    expect(row).toMatchObject({ plan: "pro", seats: 5, status: "active" });
    expect(row.createdAt).toBe(NOW); // "customer since" survives the upgrade
    expect(row.stripeSubscriptionId).toBe(SUB);
  });

  it("resolves the org by stored ids before metadata, and refuses metadata nothing vouches for", async () => {
    const sub = subscriptionStore([
      {
        orgId: ORG,
        plan: "pro",
        seats: 5,
        status: "active",
        periodStart: null,
        periodEnd: null,
        cancelAt: null,
        trialEndsAt: null,
        stripeCustomerId: CUSTOMER,
        stripeSubscriptionId: SUB,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);
    const dispatcher = createStripeDispatcher({
      store: sub,
      lookup: { getSubscription: async () => parseSubscription(subscriptionShape()) },
    });
    // The subscription object claims a DIFFERENT org in metadata; the stored
    // subscription id must win, because metadata travelled out to Stripe and back.
    const shape = subscriptionShape({
      metadata: { orgId: "org_somebody_else", planCode: "pro" },
    });
    await dispatcher.dispatch(envelope("customer.subscription.updated", shape), NOW);
    expect(sub.rows.get(ORG)?.updatedAt).toBe(NOW);
    expect(sub.rows.has("org_somebody_else")).toBe(false);

    // Metadata for an org with no row and no voucher throws — the ledger's
    // retry, not a half-written row, is the honest answer.
    const stranger = createStripeDispatcher({
      store: subscriptionStore(),
      lookup: { getSubscription: async () => parseSubscription(subscriptionShape()) },
    });
    await expect(
      stranger.dispatch(envelope("customer.subscription.updated", subscriptionShape()), NOW),
    ).rejects.toThrow(/no subscription row/);
  });

  it("maps the price line to the plan, and falls back to seats already on the row", async () => {
    const existing: StoredSubscription = {
      orgId: ORG,
      plan: "pro",
      seats: 12,
      status: "active",
      periodStart: null,
      periodEnd: null,
      cancelAt: null,
      trialEndsAt: null,
      stripeCustomerId: CUSTOMER,
      stripeSubscriptionId: SUB,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const sub = subscriptionStore([existing]);
    const dispatcher = createStripeDispatcher({
      store: sub,
      // Stripe omits quantity on metered prices; the existing seat count stands.
      lookup: {
        getSubscription: async () =>
          parseSubscription(
            subscriptionShape({
              items: {
                object: "list",
                data: [{ id: "si_1", price: { id: PRICE_PRO }, quantity: null }],
              },
            }),
          ),
      },
    });
    await dispatcher.dispatch(
      envelope(
        "customer.subscription.updated",
        subscriptionShape({
          items: {
            object: "list",
            data: [{ id: "si_1", price: { id: PRICE_PRO }, quantity: null }],
          },
        }),
      ),
      NOW,
    );
    expect(sub.rows.get(ORG)?.seats).toBe(12);
  });

  it("invoice.payment_failed writes status from Stripe and notifies the sink, never failing on sink throw", async () => {
    const paid: string[] = [];
    const failed: string[] = [];
    const sub = subscriptionStore([
      {
        orgId: ORG,
        plan: "pro",
        seats: 5,
        status: "past_due",
        periodStart: null,
        periodEnd: null,
        cancelAt: null,
        trialEndsAt: null,
        stripeCustomerId: CUSTOMER,
        stripeSubscriptionId: SUB,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);
    const dispatcher = createStripeDispatcher({
      store: sub,
      lookup: {
        getSubscription: async () => parseSubscription(subscriptionShape({ status: "past_due" })),
      },
      sink: {
        invoicePaid: (e) => {
          paid.push(e.invoiceId);
        },
        paymentFailed: (e) => {
          failed.push(e.invoiceId);
          throw new Error("smtp down");
        },
      },
    });
    const invoice = {
      id: "in_test_1",
      object: "invoice",
      customer: CUSTOMER,
      subscription: SUB,
      status: "paid",
      amount_paid: 5000,
      amount_due: 5000,
      currency: "usd",
      attempt_count: 1,
      next_payment_attempt: null,
      hosted_invoice_url: "https://stripe.test/in/in_test_1",
      lines: { object: "list", data: [{ period: { end: 1_700_259_200 } }] },
    };
    await dispatcher.dispatch(envelope("invoice.paid", invoice), NOW);
    expect(paid).toEqual(["in_test_1"]);

    const dunning = { ...invoice, id: "in_test_2", status: "open", amount_paid: 0 };
    await dispatcher.dispatch(envelope("invoice.payment_failed", dunning), NOW);
    expect(failed).toEqual(["in_test_2"]);
    expect(sub.rows.get(ORG)?.status).toBe("past_due"); // from Stripe, not the sink's mood
  });

  it("an unrecognised status throws rather than being coerced", async () => {
    // A row must resolve the org first — the status check happens on write.
    const sub = subscriptionStore([
      {
        orgId: ORG,
        plan: "pro",
        seats: 5,
        status: "active",
        periodStart: null,
        periodEnd: null,
        cancelAt: null,
        trialEndsAt: null,
        stripeCustomerId: CUSTOMER,
        stripeSubscriptionId: SUB,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);
    const dispatcher = createStripeDispatcher({
      store: sub,
      lookup: {
        getSubscription: async () =>
          parseSubscription(subscriptionShape({ status: "super_active" })),
      },
    });
    await expect(
      dispatcher.dispatch(
        envelope("customer.subscription.updated", subscriptionShape({ status: "super_active" })),
        NOW,
      ),
    ).rejects.toThrow(/unrecognised status/);
    // Nothing half-written: the seeded row is exactly as it started.
    expect(sub.rows.get(ORG)?.updatedAt).toBe(NOW);
  });
});

/* -------------------------------- sweep ----------------------------------- */

describe("stripe event sweep", () => {
  it("replays failed rows from Stripe's event store and reports each outcome", async () => {
    const store = new InMemoryStripeEventStore();
    // A row for ORG so the handler can resolve the org from event metadata.
    const sub = subscriptionStore([
      {
        orgId: ORG,
        plan: "free",
        seats: 1,
        status: "incomplete",
        periodStart: null,
        periodEnd: null,
        cancelAt: null,
        trialEndsAt: null,
        stripeCustomerId: null,
        stripeSubscriptionId: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);
    const dispatcher = createStripeDispatcher({
      store: sub,
      lookup: { getSubscription: async () => parseSubscription(subscriptionShape()) },
    });

    await store.claim(
      { id: "evt_sweep_1", type: "customer.subscription.updated", livemode: "test" },
      NOW - 10_000,
    );
    await store.markFailed("evt_sweep_1", "price not in catalogue", NOW - 9_000);
    await store.claim(
      { id: "evt_sweep_2", type: "customer.discount.created", livemode: "test" },
      NOW - 8_000,
    );
    await store.markFailed("evt_sweep_2", "boom", NOW - 7_000);

    const summary = await sweepStripeEvents({
      store,
      dispatcher,
      events: {
        getEvent: async (id) =>
          id === "evt_sweep_1"
            ? envelope("customer.subscription.updated", subscriptionShape(), id)
            : envelope("customer.discount.created", { id: "di_1" }, id),
      },
      now: () => NOW,
    });
    expect(summary).toMatchObject({ examined: 2, processed: 1, ignored: 1 });
    expect((await store.get("evt_sweep_1"))?.status).toBe("processed");
    expect(sub.rows.get(ORG)?.status).toBe("active");
  });

  it("records unavailable events failed and skips exhausted rows unless retryExhausted", async () => {
    const store = new InMemoryStripeEventStore();
    const dispatcher = createStripeDispatcher({
      store: subscriptionStore(),
      lookup: { getSubscription: async () => null },
    });
    await store.claim({ id: "evt_gone", type: "x", livemode: "test" }, NOW - 10_000);
    await store.markFailed("evt_gone", "old", NOW - 9_000);
    for (let i = 0; i < 6; i += 1) {
      await store.claim({ id: "evt_exhausted", type: "x", livemode: "test" }, NOW - 8_000);
      await store.markFailed("evt_exhausted", "boom", NOW - 7_000);
    }
    expect((await store.get("evt_exhausted"))?.attempts).toBe(6);

    const summary = await sweepStripeEvents({
      store,
      dispatcher,
      events: { getEvent: async () => null },
      maxAttempts: 6,
      now: () => NOW,
    });
    expect(summary).toMatchObject({ unavailable: 1, skipped: 1 });

    const forced = await sweepStripeEvents({
      store,
      dispatcher,
      events: { getEvent: async () => null },
      maxAttempts: 6,
      retryExhausted: true,
      now: () => NOW,
    });
    expect(forced.skipped).toBe(0);
  });
});

/* -------------------------- StripeClient over fake fetch ------------------ */

type FetchCall = { url: string; method: string; body?: string };

/** A StripeClient whose HTTP is a routing table; returns `Response`s for real. */
function fakeStripe(
  routes: Array<{ match: (call: FetchCall) => boolean; reply: (call: FetchCall) => unknown }>,
): { client: StripeClient; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const client = new StripeClient({
    secretKey: "sk_test_fake",
    fetchImpl: (async (url: unknown, init?: { method?: string; body?: string }) => {
      const call: FetchCall = {
        url: String(url),
        method: init?.method ?? "GET",
        body: init?.body,
      };
      calls.push(call);
      const route = routes.find((r) => r.match(call));
      if (!route)
        return new Response(
          JSON.stringify({
            error: {
              type: "invalid_request_error",
              message: `unrouted ${call.method} ${call.url}`,
            },
          }),
          { status: 404 },
        );
      return new Response(JSON.stringify(route.reply(call)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch,
    maxAttempts: 1,
  });
  return { client, calls };
}

/* -------------------------- checkout / portal service --------------------- */

/**
 * Seed the catalogue the way `main.ts` does: `seedPlans`, then attach the
 * deployment's Stripe price ids with `putPlan` — the seed deliberately never
 * writes them, they are deployment configuration.
 */
async function seedCatalogue(usage: InMemoryUsageStore): Promise<void> {
  await usage.seedPlans(PLAN_LADDER, NOW);
  const pro = await usage.plan("pro");
  if (pro) await usage.putPlan({ ...pro, stripePriceId: PRICE_PRO, updatedAt: NOW });
}

describe("billing service", () => {
  async function usageWith(initial?: Partial<StoredSubscription>) {
    const usage = new InMemoryUsageStore();
    await seedCatalogue(usage);
    if (initial) {
      void usage.putSubscription({
        orgId: ORG,
        plan: "free",
        seats: 1,
        status: "canceled",
        periodStart: null,
        periodEnd: null,
        cancelAt: null,
        trialEndsAt: null,
        stripeCustomerId: null,
        stripeSubscriptionId: null,
        createdAt: NOW,
        updatedAt: NOW,
        ...initial,
      });
    }
    return usage;
  }

  it("startCheckout writes the placeholder row, finds or creates the customer, returns the url", async () => {
    const { client, calls } = fakeStripe([
      {
        match: (c) => c.method === "GET" && c.url.includes("/v1/customers?"),
        reply: () => ({ object: "list", data: [] }),
      },
      {
        match: (c) => c.method === "POST" && c.url.endsWith("/v1/customers"),
        reply: () => ({ id: CUSTOMER, object: "customer" }),
      },
      {
        match: (c) => c.method === "POST" && c.url.endsWith("/v1/checkout/sessions"),
        reply: () => ({ id: "cs_1", object: "checkout.session", url: "https://stripe.test/cs_1" }),
      },
    ]);
    const usage = await usageWith();

    const outcome = await startCheckout(
      { client, usageStore: usage },
      { orgId: ORG, planCode: "pro", seats: 4, email: "owner@x.test" },
      "https://app.test",
      NOW,
    );
    expect(outcome).toEqual({ ok: true, url: "https://stripe.test/cs_1" });

    // Placeholder row BEFORE redirect: the voucher handlers.ts depends on.
    const row = await usage.subscription(ORG);
    expect(row).toMatchObject({
      plan: "pro",
      seats: 4,
      status: "incomplete",
      stripeCustomerId: CUSTOMER,
    });

    // The session carries org + plan in metadata, and the quantity is the seats.
    const checkout = calls.find((c) => c.url.includes("/v1/checkout/sessions"))!;
    const form = decodeURIComponent(checkout.body!);
    expect(form).toContain("line_items[0][quantity]=4");
    expect(form).toContain("metadata[orgId]=" + ORG);
    expect(form).toContain("metadata[planCode]=pro");
  });

  it("startCheckout refuses a second subscription and an unknown plan", async () => {
    const { client } = fakeStripe([]);
    const usage = await usageWith({ status: "active", plan: "pro", stripeSubscriptionId: SUB });
    const active = await startCheckout(
      { client, usageStore: usage },
      { orgId: ORG, planCode: "pro" },
      "https://app.test",
      NOW,
    );
    expect(active).toMatchObject({ ok: false, status: 400, error: /billing portal/ });

    const unknown = await startCheckout(
      { client, usageStore: await usageWith() },
      { orgId: ORG, planCode: "nope" },
      "https://app.test",
      NOW,
    );
    expect(unknown).toMatchObject({ ok: false, status: 400, error: /unknown plan/ });
  });

  it("openPortal needs a stored customer and returns Stripe's url", async () => {
    const { client } = fakeStripe([
      {
        match: (c) => c.url.includes("/v1/billing_portal/sessions"),
        reply: () => ({
          id: "bps_1",
          object: "billing_portal.session",
          url: "https://stripe.test/portal",
        }),
      },
    ]);
    const noCustomer = await openPortal(
      { client, usageStore: await usageWith() },
      ORG,
      "https://app.test",
      NOW,
    );
    expect(noCustomer).toMatchObject({ ok: false, status: 400 });

    const withCustomer = await openPortal(
      { client, usageStore: await usageWith({ stripeCustomerId: CUSTOMER, status: "active" }) },
      ORG,
      "https://app.test",
      NOW,
    );
    expect(withCustomer).toEqual({ ok: true, url: "https://stripe.test/portal" });
  });

  it("a Stripe REST failure surfaces as a 502 StripeError", async () => {
    const client = new StripeClient({
      secretKey: "sk_test_fake",
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: { type: "card_error", message: "nope" } }), {
          status: 402,
        })) as unknown as typeof fetch,
      maxAttempts: 1,
    });
    await expect(
      startCheckout(
        { client, usageStore: await usageWith() },
        { orgId: ORG, planCode: "pro", email: "owner@x.test" },
        "https://app.test",
        NOW,
      ),
    ).rejects.toBeInstanceOf(StripeError);
  });
});

/* --------------------------------- routes --------------------------------- */

describe("billing HTTP routes", () => {
  const ORIGIN = "http://localhost:5173";
  const usage = new InMemoryUsageStore();
  beforeAll(async () => {
    await seedCatalogue(usage);
  });
  void usage.putSubscription({
    orgId: ORG,
    plan: "free",
    seats: 1,
    status: "active",
    periodStart: null,
    periodEnd: null,
    cancelAt: null,
    trialEndsAt: null,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    createdAt: NOW,
    updatedAt: NOW,
  });

  const sub = subscriptionStore([
    {
      orgId: ORG,
      plan: "free",
      seats: 1,
      status: "active",
      periodStart: null,
      periodEnd: null,
      cancelAt: null,
      trialEndsAt: null,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
  ]);
  const events = new InMemoryStripeEventStore();
  const dispatcher = createStripeDispatcher({
    store: sub,
    lookup: { getSubscription: async () => parseSubscription(subscriptionShape()) },
  });

  const { client } = fakeStripe([
    {
      match: (c) => c.method === "GET" && c.url.includes("/v1/customers?"),
      reply: () => ({ object: "list", data: [] }),
    },
    {
      match: (c) => c.method === "POST" && c.url.endsWith("/v1/customers"),
      reply: () => ({ id: CUSTOMER, object: "customer" }),
    },
    {
      match: (c) => c.url.includes("/v1/checkout/sessions"),
      reply: () => ({
        id: "cs_1",
        object: "checkout.session",
        url: "https://stripe.test/checkout",
      }),
    },
    {
      match: (c) => c.url.includes("/v1/billing_portal/sessions"),
      reply: () => ({
        id: "bps_1",
        object: "billing_portal.session",
        url: "https://stripe.test/portal",
      }),
    },
  ]);

  const servers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const close of servers.splice(0)) await close();
  });

  async function boot(withBilling: boolean) {
    const config = readConfig({ LUCENT_REQUIRE_AUTH: "1", LUCENT_WEB_ORIGIN: ORIGIN });
    const app = createApp({
      config,
      provider: new MockProvider(),
      imageProvider: new MockImageProvider(),
      userStore: new InMemoryUserStore(),
      boardStore: new InMemoryBoardStore(),
      sessionStore: new InMemorySessionStore(),
      secret: "test-secret-at-least-16-chars",
      usage: new UsageTracker(limitsFromEnv()),
      limits: limitsFromEnv(),
      telemetry: new Telemetry(),
      authLimiter: new Limiter(50, 60_000),
      tickets: new InMemoryTicketStore(60_000),
      orgStore: new InMemoryOrgStore(),
      inviteStore: new InMemoryOrgInviteStore(),
      notifications: new InMemoryNotificationStore(),
      usageStore: usage,
      ...(withBilling
        ? {
            billing: {
              client,
              webhookSecret: SECRET,
              events,
              dispatcher,
            },
          }
        : {}),
    });
    const server = app.server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    servers.push(() => new Promise((resolve) => server.close(() => resolve())));
    return { base: `http://127.0.0.1:${port}` };
  }

  function pickCookie(setCookie: string, name: string): string | undefined {
    for (const raw of setCookie.split(/,(?=[^;]+=)/)) {
      const eq = raw.indexOf("=");
      if (raw.slice(0, eq).trim() !== name) continue;
      return raw.slice(eq + 1).split(";")[0];
    }
    return undefined;
  }

  async function signupAsOwner(base: string) {
    const csrfRes = await fetch(`${base}/api/auth/csrf`, { headers: { origin: ORIGIN } });
    const csrfBody = (await csrfRes.json()) as { token: string };
    const csrfCookie = pickCookie(csrfRes.headers.get("set-cookie") ?? "", "lucent_csrf");
    if (!csrfCookie) throw new Error("csrf route did not set a cookie");
    const res = await fetch(`${base}/api/auth/signup`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        cookie: `lucent_csrf=${csrfCookie}`,
        "x-csrf-token": csrfBody.token,
      },
      body: JSON.stringify({ email: "owner@x.test", password: "password123", name: "owner" }),
    });
    expect(res.status).toBe(201);
    const session = pickCookie(res.headers.get("set-cookie") ?? "", "lucent_session");
    if (!session) throw new Error("signup did not set a session cookie");
    const cookies = `lucent_session=${session}; lucent_csrf=${csrfCookie}`;
    const me = await fetch(`${base}/api/auth/me`, { headers: { origin: ORIGIN, cookie: cookies } });
    const meBody = (await me.json()) as { memberships: Array<{ orgId: string }> };
    return { cookies, csrf: csrfBody.token, orgId: meBody.memberships[0]!.orgId };
  }

  it("webhook: 503 unconfigured, 400 unsigned, 200 signed and processed", async () => {
    const { base: bare } = await boot(false);
    expect(
      (await fetch(`${bare}/api/billing/webhook`, { method: "POST", body: "{}" })).status,
    ).toBe(503);

    const { base } = await boot(true);
    const unsigned = await fetch(`${base}/api/billing/webhook`, { method: "POST", body: "{}" });
    expect(unsigned.status).toBe(400);

    const payload = JSON.stringify(
      eventEnvelope("customer.subscription.updated", subscriptionShape(), "evt_route_1"),
    );
    // The app's receiver runs on the real clock, so the signature must be
    // timestamped now, not at the fixture's frozen NOW.
    const signed = await fetch(`${base}/api/billing/webhook`, {
      method: "POST",
      headers: { "stripe-signature": sign(payload, Math.floor(Date.now() / 1000)) },
      body: payload,
    });
    expect(signed.status).toBe(200);
    expect(await signed.json()).toMatchObject({ received: true, outcome: "processed" });
  });

  it("checkout and portal: session required, CSRF required, owner-only, then the url", async () => {
    const { base } = await boot(true);

    const anonymous = await fetch(`${base}/api/billing/checkout`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ orgId: ORG, planCode: "pro" }),
    });
    expect(anonymous.status).toBe(401);

    const owner = await signupAsOwner(base);
    const noCsrf = await fetch(`${base}/api/billing/checkout`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json", cookie: owner.cookies },
      body: JSON.stringify({ orgId: owner.orgId, planCode: "pro" }),
    });
    expect(noCsrf.status).toBe(403);

    const checkout = await fetch(`${base}/api/billing/checkout`, {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        cookie: owner.cookies,
        "x-csrf-token": owner.csrf,
      },
      body: JSON.stringify({ orgId: owner.orgId, planCode: "pro", seats: 3 }),
    });
    expect(checkout.status).toBe(200);
    expect(await checkout.json()).toMatchObject({ url: "https://stripe.test/checkout" });

    const portal = await fetch(`${base}/api/billing/portal`, {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        cookie: owner.cookies,
        "x-csrf-token": owner.csrf,
      },
      body: JSON.stringify({ orgId: owner.orgId }),
    });
    expect(portal.status).toBe(200);
    expect(await portal.json()).toMatchObject({ url: "https://stripe.test/portal" });
  });
});
