import { randomBytes } from "node:crypto";
import {
  asRecord,
  parseCheckoutSession,
  parseCustomer,
  parseCustomerList,
  parseEventEnvelope,
  parsePortalSession,
  parseSubscription,
  StripeShapeError,
  type StripeCheckoutSession,
  type StripeCustomer,
  type StripeEventEnvelope,
  type StripePortalSession,
  type StripeSubscription,
} from "./objects.js";

/**
 * Stripe REST client (M4.3): the eight calls this product makes, over `fetch`.
 *
 * THE `stripe` NPM PACKAGE IS DELIBERATELY NOT A DEPENDENCY. The same stance
 * produced `email/smtp.ts` (a hand-rolled SMTP transport rather than a mailer
 * dependency) and `email/http.ts` (`fetch`, not a provider SDK), and it buys
 * three concrete things here:
 *
 *  - the wire format stays visible. Stripe speaks form-encoded bodies with
 *    bracketed nesting, and `proration_behavior=create_prorations` sitting in
 *    plain sight next to the seat quantity *is* the proration behaviour we sell.
 *    Through an SDK it would be a named argument whose effect nobody reviews;
 *  - webhook verification stays auditable (`webhook.ts`): a HMAC and a constant
 *    time compare from `node:crypto`, not a call into a package whose tolerance
 *    window and key rotation handling we would be trusting by reputation;
 *  - every test is a fake `fetch` rather than a mocked SDK, so what the tests
 *    assert is the exact request Stripe will receive -- see
 *    `test/stripe-client.test.ts`, which reads assertions off the encoded body.
 *
 * The cost is real and worth naming: the form encoder is ours, only the response
 * fields we read are parsed (`objects.ts`), and an API-version change that moves
 * a field is ours to notice. `STRIPE_API_VERSION` is pinned for exactly that
 * reason, and `parseSubscription` already absorbs the one such move this code has
 * had to survive.
 */

/** Stripe API root. Overridable so tests and a proxy can both point elsewhere. */
export const STRIPE_API_BASE = "https://api.stripe.com";

/**
 * The API version every request is pinned to, sent as `Stripe-Version`.
 *
 * Pinned rather than left to the account default because the account default is
 * a dashboard setting that an operator can move without touching this repo, and
 * moving it changes the *shape of the JSON this code parses*. Upgrading is a
 * deliberate act: bump this constant, re-read `parseSubscription` and
 * `parseInvoice` against the version notes, and run the suite.
 *
 * Webhook payloads are the exception -- Stripe serialises those under the
 * version configured on the endpoint, not under this header -- which is why the
 * parsers read both the pre- and post-`basil` field positions.
 */
export const STRIPE_API_VERSION = "2025-03-31.basil";

/** Per-request budget. A hung Stripe must not hold a request handler open. */
export const DEFAULT_TIMEOUT_MS = 15_000;

/** Total attempts per call, first included. */
export const DEFAULT_MAX_ATTEMPTS = 3;

const RETRY_BASE_MS = 250;
const RETRY_MAX_MS = 4_000;

/** How much of a Stripe error body is quoted, matching `email/http.ts`. */
const ERROR_BODY_CHARS = 300;

/**
 * A Stripe call that did not succeed. One error type for network failure,
 * timeout and API rejection alike, because the caller decides the same thing in
 * every case: surface it, or let the webhook ledger record it and retry.
 *
 * `retryable` is computed once, here, from what Stripe documents as safe to
 * repeat. A caller must never re-derive it from the status code.
 */
export class StripeError extends Error {
  /** HTTP status, or null when the request never got a response. */
  readonly status: number | null;
  /** Stripe error `type`, e.g. `card_error`, `invalid_request_error`. */
  readonly type: string | null;
  /** Stripe error `code`, e.g. `resource_missing`. */
  readonly code: string | null;
  /** `Request-Id` header. The only thing Stripe support asks for. */
  readonly requestId: string | null;
  readonly retryable: boolean;

  constructor(
    message: string,
    opts: {
      status?: number | null;
      type?: string | null;
      code?: string | null;
      requestId?: string | null;
      retryable?: boolean;
    } = {},
  ) {
    super(message);
    this.name = "StripeError";
    this.status = opts.status ?? null;
    this.type = opts.type ?? null;
    this.code = opts.code ?? null;
    this.requestId = opts.requestId ?? null;
    this.retryable = opts.retryable ?? false;
  }
}

/* ------------------------------ form encoding ----------------------------- */

export type FormValue = string | number | boolean | null | undefined | FormBody | FormValue[];
export interface FormBody {
  [key: string]: FormValue;
}

/**
 * Stripe bodies are `application/x-www-form-urlencoded` with bracketed nesting:
 * `line_items[0][price]=price_x`, `metadata[orgId]=org_1`. Nested objects and
 * arrays are flattened here rather than at the call sites, so a call site reads
 * as the object Stripe documents.
 *
 * `null` and `undefined` are omitted rather than sent empty. Stripe reads an
 * empty value as "unset this field", which is a different request from "do not
 * mention this field", and nothing in this client ever means the former.
 */
export function encodeForm(body: FormBody): string {
  const pairs: string[] = [];
  appendPairs(pairs, "", body);
  return pairs.join("&");
}

function appendPairs(pairs: string[], prefix: string, value: FormValue): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => appendPairs(pairs, `${prefix}[${index}]`, entry));
    return;
  }
  if (typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      appendPairs(pairs, prefix === "" ? key : `${prefix}[${key}]`, entry);
    }
    return;
  }
  pairs.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(value))}`);
}

/* -------------------------------- transport ------------------------------- */

export interface StripeClientOptions {
  /** `sk_live_…`, `sk_test_…` or a restricted `rk_…` key. */
  secretKey: string;
  /** Defaults to `STRIPE_API_VERSION`. */
  apiVersion?: string;
  /** Defaults to `STRIPE_API_BASE`. */
  baseUrl?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected so a retry test does not actually wait out the backoff. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected so backoff jitter is deterministic under test. */
  random?: () => number;
}

interface RequestSpec {
  method: "GET" | "POST" | "DELETE";
  path: string;
  /** Form body, POST only. */
  form?: FormBody;
  /** Query string, GET only. */
  query?: FormBody;
  /**
   * Sent as `Idempotency-Key`. Held across the retry loop below, which is the
   * whole reason repeating a POST is safe: Stripe collapses a second request
   * carrying a key it has already seen instead of creating a second subscription.
   */
  idempotencyKey?: string;
}

export class StripeClient {
  private readonly secretKey: string;
  private readonly apiVersion: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(opts: StripeClientOptions) {
    if (!opts.secretKey) throw new Error("stripe: secretKey is required");
    // A publishable key here is always a configuration mistake and would fail on
    // every call with a 401 that reads like an auth outage. Named at construction
    // instead, where the fix is obvious.
    if (opts.secretKey.startsWith("pk_")) {
      throw new Error("stripe: secretKey is a publishable key; use the secret key");
    }
    this.secretKey = opts.secretKey;
    this.apiVersion = opts.apiVersion ?? STRIPE_API_VERSION;
    this.baseUrl = (opts.baseUrl ?? STRIPE_API_BASE).replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep =
      opts.sleep ??
      ((ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms).unref?.();
        }));
    this.random = opts.random ?? Math.random;
  }

  /**
   * One request, with the retry policy. Returns the parsed JSON as `unknown`:
   * narrowing is `objects.ts`, so a transport change cannot quietly widen what
   * the callers below believe they received.
   */
  private async send(spec: RequestSpec): Promise<unknown> {
    const query = spec.query ? encodeForm(spec.query) : "";
    const url = `${this.baseUrl}${spec.path}${query ? `?${query}` : ""}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.secretKey}`,
      "stripe-version": this.apiVersion,
      accept: "application/json",
    };
    let body: string | undefined;
    if (spec.method === "POST") {
      headers["content-type"] = "application/x-www-form-urlencoded";
      body = encodeForm(spec.form ?? {});
      headers["idempotency-key"] = spec.idempotencyKey ?? newIdempotencyKey();
    }

    for (let attempt = 1; ; attempt += 1) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: spec.method,
          headers,
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        // DNS, TLS, socket, or the abort above. Retryable: the request may never
        // have reached Stripe, and if it did the idempotency key covers us.
        const failure = new StripeError(
          `stripe: ${spec.method} ${spec.path} failed: ${describe(err)}`,
          { retryable: true },
        );
        if (attempt >= this.maxAttempts) throw failure;
        await this.backoff(attempt, null);
        continue;
      }

      if (res.ok) return await readJson(res, spec);
      const failure = await errorFrom(res, spec);
      if (!failure.retryable || attempt >= this.maxAttempts) throw failure;
      await this.backoff(attempt, res);
    }
  }

  /**
   * Exponential backoff with half jitter, honouring `Retry-After` when Stripe
   * sends one. Jitter matters more than the curve: without it a rate-limited
   * deployment retries in lockstep and rebuilds the burst it was throttled for.
   */
  private async backoff(attempt: number, res: Response | null): Promise<void> {
    const after = res ? Number(res.headers.get("retry-after")) : NaN;
    const ceiling = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempt - 1));
    const base =
      Number.isFinite(after) && after > 0 ? Math.min(after * 1000, RETRY_MAX_MS) : ceiling;
    await this.sleep(Math.round(base * (0.5 + this.random() * 0.5)));
  }

  /* -------------------------------- customers ------------------------------- */

  /**
   * Create a customer. `metadata.orgId` is the load-bearing field: it is what
   * ties every later Stripe object back to a Lucent org, and the webhook path
   * reads it before it falls back to matching on stored ids. A customer created
   * without it is a subscription that can only be reconciled by hand.
   */
  async createCustomer(params: {
    orgId: string;
    email?: string | null;
    name?: string | null;
    idempotencyKey?: string;
  }): Promise<StripeCustomer> {
    return parseCustomer(
      await this.send({
        method: "POST",
        path: "/v1/customers",
        idempotencyKey: params.idempotencyKey,
        form: {
          email: params.email ?? undefined,
          name: params.name ?? undefined,
          metadata: { orgId: params.orgId },
        },
      }),
    );
  }

  /** One customer, or null when Stripe has no such id (deleted, or wrong mode). */
  async getCustomer(id: string): Promise<StripeCustomer | null> {
    try {
      return parseCustomer(
        await this.send({ method: "GET", path: `/v1/customers/${encodeURIComponent(id)}` }),
      );
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
  }

  /**
   * One event, or null when Stripe no longer returns it. This is what the
   * webhook sweep (webhook.ts) replays a ledger row from: the ledger stores no
   * payload of its own (schema.ts), deliberately, so Stripe's 30-day event
   * window is the only copy of what a failed delivery said.
   */
  async getEvent(id: string): Promise<StripeEventEnvelope | null> {
    try {
      return parseEventEnvelope(
        await this.send({ method: "GET", path: `/v1/events/${encodeURIComponent(id)}` }),
      );
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
  }

  /**
   * Look a customer up by email, for the one case that matters: an org whose
   * stored `stripeCustomerId` is missing but which has paid before, where
   * creating a second customer would split its billing history in two.
   *
   * A list filter rather than `/v1/customers/search`, which is documented as
   * eventually consistent by up to a minute -- long enough that a customer
   * created and then searched for in the same request would not be found, which
   * is precisely the sequence this guards against.
   */
  async findCustomerByEmail(email: string): Promise<StripeCustomer | null> {
    const page = parseCustomerList(
      await this.send({ method: "GET", path: "/v1/customers", query: { email, limit: 2 } }),
    );
    return page[0] ?? null;
  }

  /* ------------------------------ subscriptions ----------------------------- */

  async getSubscription(id: string): Promise<StripeSubscription | null> {
    try {
      return parseSubscription(
        await this.send({ method: "GET", path: `/v1/subscriptions/${encodeURIComponent(id)}` }),
      );
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
  }

  /**
   * Change paid seats, prorated.
   *
   * Stripe updates a quantity through the subscription *item*, not the
   * subscription, so the item has to be read first -- hence the extra GET. The
   * item is resolved explicitly rather than assumed to be `items[0]`: a
   * subscription that has picked up a second item (an add-on, a migration) would
   * otherwise have the wrong line silently resized, and that is a wrong invoice.
   *
   * `proration_behavior` defaults to `create_prorations`: the difference is
   * calculated now and appears on the next invoice. `always_invoice` bills it
   * immediately, which is the right answer for a large seat jump you want paid
   * before it is used, and `none` gives the seats away until the period turns.
   * The default is Stripe's own, restated in the request so that changing our
   * mind is a change to this line rather than a change in Stripe's defaults.
   */
  async setSeatQuantity(params: {
    subscriptionId: string;
    quantity: number;
    /** Explicit item, when the caller already knows it. */
    itemId?: string;
    /** Resolve the item by price instead, for a multi-item subscription. */
    priceId?: string;
    prorationBehavior?: "create_prorations" | "always_invoice" | "none";
    idempotencyKey?: string;
  }): Promise<StripeSubscription> {
    if (!Number.isInteger(params.quantity) || params.quantity < 1) {
      throw new Error(`stripe: seat quantity must be a positive integer, got ${params.quantity}`);
    }
    const itemId =
      params.itemId ?? (await this.resolveItemId(params.subscriptionId, params.priceId));
    return parseSubscription(
      await this.send({
        method: "POST",
        path: `/v1/subscriptions/${encodeURIComponent(params.subscriptionId)}`,
        idempotencyKey: params.idempotencyKey,
        form: {
          items: [{ id: itemId, quantity: params.quantity }],
          proration_behavior: params.prorationBehavior ?? "create_prorations",
        },
      }),
    );
  }

  private async resolveItemId(subscriptionId: string, priceId?: string): Promise<string> {
    const sub = await this.getSubscription(subscriptionId);
    if (!sub) {
      throw new StripeError(`stripe: subscription ${subscriptionId} not found`, {
        status: 404,
        code: "resource_missing",
      });
    }
    const matches = priceId ? sub.items.filter((item) => item.priceId === priceId) : sub.items;
    const only = matches.length === 1 ? matches[0] : undefined;
    if (!only) {
      throw new StripeShapeError(
        `stripe: subscription ${subscriptionId} has ${String(sub.items.length)} items` +
          `${priceId ? ` and ${String(matches.length)} matching price ${priceId}` : ""}` +
          `; pass itemId to say which seat line to resize`,
      );
    }
    return only.id;
  }

  /**
   * Cancel. `atPeriodEnd` is the default because it is what a customer means by
   * "cancel": keep what I paid for until the period I paid for ends. An immediate
   * cancel (`DELETE`) throws the remainder away and is only right when an
   * operator is closing an account.
   */
  async cancelSubscription(params: {
    subscriptionId: string;
    atPeriodEnd?: boolean;
    idempotencyKey?: string;
  }): Promise<StripeSubscription> {
    const path = `/v1/subscriptions/${encodeURIComponent(params.subscriptionId)}`;
    if (params.atPeriodEnd === false) {
      return parseSubscription(await this.send({ method: "DELETE", path }));
    }
    return parseSubscription(
      await this.send({
        method: "POST",
        path,
        idempotencyKey: params.idempotencyKey,
        form: { cancel_at_period_end: true },
      }),
    );
  }

  /** Undo a pending cancellation. The Billing Portal offers it, so we must too. */
  async resumeSubscription(params: {
    subscriptionId: string;
    idempotencyKey?: string;
  }): Promise<StripeSubscription> {
    return parseSubscription(
      await this.send({
        method: "POST",
        path: `/v1/subscriptions/${encodeURIComponent(params.subscriptionId)}`,
        idempotencyKey: params.idempotencyKey,
        form: { cancel_at_period_end: false },
      }),
    );
  }

  /* --------------------------- checkout and portal -------------------------- */

  /**
   * A hosted Checkout Session in subscription mode. Returns the session, whose
   * `url` is where the browser goes; we never see a card number.
   *
   * The org id is attached in three places, and all three are load-bearing:
   *
   *  - `client_reference_id` and `metadata` ride on the session, so
   *    `checkout.session.completed` can be resolved;
   *  - `subscription_data.metadata` is copied by Stripe onto the *subscription*,
   *    so every later `customer.subscription.updated` and `invoice.*` event -- and
   *    every change a customer makes in the Billing Portal, which we never see the
   *    request for -- still names the org it belongs to.
   *
   * Without the third, a webhook can only be resolved by matching stored Stripe
   * ids, and the one moment those are missing is the moment a checkout completes.
   */
  async createCheckoutSession(params: {
    orgId: string;
    planCode: string;
    customerId: string;
    priceId: string;
    /** Seats. Stripe multiplies the per-seat price by this. */
    quantity: number;
    successUrl: string;
    cancelUrl: string;
    /** Free days before the first charge. Null or 0 means no trial. */
    trialDays?: number | null;
    allowPromotionCodes?: boolean;
    /**
     * Off by default: Stripe rejects the request when Stripe Tax is not enabled
     * on the account, so a default of true would turn every checkout into a 400
     * on a deployment that has not configured tax.
     */
    automaticTax?: boolean;
    idempotencyKey?: string;
  }): Promise<StripeCheckoutSession> {
    if (!Number.isInteger(params.quantity) || params.quantity < 1) {
      throw new Error(`stripe: checkout quantity must be a positive integer`);
    }
    const metadata = { orgId: params.orgId, planCode: params.planCode };
    const trialDays = params.trialDays && params.trialDays > 0 ? params.trialDays : undefined;
    return parseCheckoutSession(
      await this.send({
        method: "POST",
        path: "/v1/checkout/sessions",
        idempotencyKey: params.idempotencyKey,
        form: {
          mode: "subscription",
          customer: params.customerId,
          line_items: [{ price: params.priceId, quantity: params.quantity }],
          success_url: params.successUrl,
          cancel_url: params.cancelUrl,
          client_reference_id: params.orgId,
          metadata,
          subscription_data: { metadata, trial_period_days: trialDays },
          allow_promotion_codes: params.allowPromotionCodes ? true : undefined,
          automatic_tax: params.automaticTax ? { enabled: true } : undefined,
        },
      }),
    );
  }

  /**
   * A Billing Portal session: Stripe hosts card updates, invoice history and
   * cancellation. Everything a customer does there arrives back as a webhook,
   * which is why the handlers in `handlers.ts` treat a subscription update as the
   * source of truth rather than only trusting changes we initiated.
   */
  async createPortalSession(params: {
    customerId: string;
    returnUrl: string;
    idempotencyKey?: string;
  }): Promise<StripePortalSession> {
    return parsePortalSession(
      await this.send({
        method: "POST",
        path: "/v1/billing_portal/sessions",
        idempotencyKey: params.idempotencyKey,
        form: { customer: params.customerId, return_url: params.returnUrl },
      }),
    );
  }
}

/* --------------------------------- helpers -------------------------------- */

/**
 * A fresh idempotency key. Random, because a generated key only ever protects
 * the retry loop above: Stripe expires keys after 24 hours and a random one
 * cannot collapse two *separate* calls. Deduplicating a double-clicked upgrade
 * is `service.ts`, which derives its key from the act instead.
 */
function newIdempotencyKey(): string {
  return `lucent_${randomBytes(16).toString("hex")}`;
}

async function readJson(res: Response, spec: RequestSpec): Promise<unknown> {
  const text = await res.text().catch(() => "");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new StripeError(
      `stripe: ${spec.method} ${spec.path} returned ${res.status} with a body that is not JSON`,
      { status: res.status, requestId: res.headers.get("request-id") },
    );
  }
}

/**
 * Stripe's error envelope is `{ error: { type, code, message } }`, and the
 * `message` is written for a developer to read -- "No such price: price_x" beats
 * any sentence we could synthesise from a status code. Quoted, bounded, with the
 * request id, which is the only thing Stripe support asks for.
 */
async function errorFrom(res: Response, spec: RequestSpec): Promise<StripeError> {
  const requestId = res.headers.get("request-id");
  const raw = await res.text().catch(() => "");
  let type: string | null = null;
  let code: string | null = null;
  let message = "";
  const envelope = asRecord(safeJson(raw));
  const error = envelope === null ? null : asRecord(envelope.error);
  if (error !== null) {
    if (typeof error.type === "string") type = error.type;
    if (typeof error.code === "string") code = error.code;
    if (typeof error.message === "string") message = error.message;
  }
  const detail = message !== "" ? message : snippet(raw);
  return new StripeError(
    `stripe: ${res.status} on ${spec.method} ${spec.path}${detail ? ` — ${detail}` : ""}`,
    { status: res.status, type, code, requestId, retryable: shouldRetry(res) },
  );
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/**
 * What Stripe documents as safe to repeat: a 409 conflict (a concurrent request
 * on the same object), a 429, and any 5xx. The `Stripe-Should-Retry` header
 * overrides all of it, because only Stripe knows whether a given failure left
 * state behind. Every POST carries an idempotency key, which is what makes
 * repeating one a lookup rather than a second charge.
 */
function shouldRetry(res: Response): boolean {
  const advice = res.headers.get("stripe-should-retry");
  if (advice === "true") return true;
  if (advice === "false") return false;
  return res.status === 409 || res.status === 429 || res.status >= 500;
}

/** True for "Stripe has no such object", which several callers treat as null. */
export function isMissing(err: unknown): boolean {
  return err instanceof StripeError && (err.status === 404 || err.code === "resource_missing");
}

function snippet(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > ERROR_BODY_CHARS ? `${oneLine.slice(0, ERROR_BODY_CHARS)}…` : oneLine;
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    // AbortSignal.timeout rejects with a TimeoutError whose own message ("The
    // operation was aborted") says nothing about why. Same normalisation as
    // `email/http.ts`.
    return err.name === "TimeoutError" ? `timed out after the configured budget` : err.message;
  }
  return String(err);
}
