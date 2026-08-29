import { createHmac, timingSafeEqual } from "node:crypto";
import type { Logger } from "../obs/logger.js";
import { StripeShapeError, parseEventEnvelope, type StripeEventEnvelope } from "./objects.js";
import { truncateError, type StripeEventStore } from "./events.js";
import type { StripeDispatcher } from "./handlers.js";

/**
 * Stripe webhook verification and delivery (M4.3).
 *
 * THE RAW BODY IS THE MESSAGE. Stripe signs the exact bytes it sent. A route that
 * parses the JSON and re-serialises it before calling in here will produce a body
 * that differs in key order, spacing or unicode escaping, and every signature will
 * fail -- with a 400 that looks exactly like an attack, which is the worst kind of
 * bug to debug. `verifyStripeSignature` therefore takes `string | Buffer` and the
 * route MUST hand it the untouched body; a Buffer is preferable because it cannot
 * have been through a decode/encode round trip at all. `app.ts` `readBody`
 * currently returns `Buffer.concat(chunks).toString("utf8")`, which is byte-exact
 * for a valid UTF-8 payload and therefore usable, but a Buffer-returning variant
 * is the safer seam and is what the report asks for.
 *
 * VERIFICATION COMES FIRST, ALWAYS. Nothing touches the event ledger until the
 * HMAC matches. The ledger is keyed by an id taken from the payload, so writing
 * before verifying would let anyone who can reach the endpoint fill the table with
 * rows -- and, worse, claim the id of an event Stripe has not delivered yet, so the
 * real delivery would be dismissed as a duplicate.
 *
 * THE SIGNATURE IS THE AUTHENTICATION. There is no session, no CSRF token and no
 * origin check on this route, and that is correct: a shared secret over the exact
 * bytes is strictly stronger than a double-submit cookie, which defends a
 * *browser* session that Stripe does not have. `requireCsrf` in app.ts only
 * engages when a `lucent_session=` cookie is present, so a cookieless Stripe POST
 * already bypasses it -- but the route owner should exempt it explicitly rather
 * than rely on that, so a later change to CSRF policy cannot silently break
 * billing.
 */

/**
 * How far a delivery's timestamp may be from our clock. Stripe's own libraries
 * default to the same five minutes.
 *
 * This is the replay defence, and it is the only one available: a captured POST
 * has a valid signature forever, because the signature covers the timestamp that
 * the attacker is replaying. Rejecting an old timestamp bounds the window in which
 * a captured delivery is useful; the ledger's idempotency then makes a replay
 * inside that window a no-op anyway. Both are needed -- the window without the
 * ledger would still let a replay re-run a handler.
 */
export const DEFAULT_TOLERANCE_SECONDS = 300;

/** A Stripe signature is HMAC-SHA256, hex: always exactly 64 characters. */
const SIGNATURE_HEX_LENGTH = 64;

export type SignatureFailureReason =
  | "missing_header"
  | "malformed_header"
  | "missing_timestamp"
  | "missing_signature"
  | "timestamp_out_of_tolerance"
  | "no_match";

export type SignatureResult =
  | { ok: true; timestamp: number }
  | { ok: false; reason: SignatureFailureReason; detail: string };

/**
 * The parsed `Stripe-Signature` header: `t=1712345678,v1=<hex>,v1=<hex>`.
 *
 * `v1` may legitimately repeat. During a secret rotation Stripe signs each
 * delivery with both the old and the new secret, so an endpoint that only read the
 * first signature would reject half its traffic for the length of the rotation.
 * Unknown schemes (`v0`, which Stripe uses for Connect test payloads, and whatever
 * comes next) are ignored rather than treated as malformed.
 */
export interface ParsedSignatureHeader {
  timestamp: number | null;
  signatures: string[];
}

export function parseSignatureHeader(header: string): ParsedSignatureHeader {
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") {
      // Seconds, as an integer. `Number` would accept "1712345678.5" and
      // " 1e9 "; neither is a Stripe timestamp, and both would sail through a
      // tolerance check computed from them.
      if (/^\d+$/.test(value)) timestamp = Number(value);
    } else if (key === "v1") {
      signatures.push(value);
    }
  }
  return { timestamp, signatures };
}

export interface VerifyOptions {
  /** The exact bytes Stripe sent. Never a re-serialised object. */
  payload: string | Buffer;
  /** The `Stripe-Signature` request header, or whatever the route found. */
  header: string | string[] | undefined | null;
  /** The endpoint's signing secret (`whsec_...`). */
  secret: string;
  toleranceSeconds?: number;
  /** Injected clock (epoch ms), so tolerance behaviour is testable. */
  now?: () => number;
}

/**
 * Is this delivery from Stripe, recently?
 *
 * Returns a reason rather than throwing because the caller logs it: a stale
 * timestamp on an otherwise valid signature means a clock problem or a replay, and
 * `no_match` means the wrong secret or a modified body. Collapsing them into one
 * boolean turns a five-minute diagnosis into an afternoon.
 */
export function verifyStripeSignature(options: VerifyOptions): SignatureResult {
  const { payload, secret } = options;
  const clock = options.now ?? Date.now;
  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;

  const header = Array.isArray(options.header) ? options.header[0] : options.header;
  if (!header) return { ok: false, reason: "missing_header", detail: "no Stripe-Signature header" };
  if (!secret) return { ok: false, reason: "malformed_header", detail: "no signing secret" };

  const parsed = parseSignatureHeader(header);
  if (parsed.timestamp === null && parsed.signatures.length === 0) {
    return { ok: false, reason: "malformed_header", detail: "no t= or v1= in Stripe-Signature" };
  }
  if (parsed.timestamp === null) {
    return { ok: false, reason: "missing_timestamp", detail: "no t= in Stripe-Signature" };
  }
  if (parsed.signatures.length === 0) {
    return { ok: false, reason: "missing_signature", detail: "no v1= in Stripe-Signature" };
  }

  // The signed message is the timestamp and the body joined by a period. Building
  // it from `parsed.timestamp` rather than from the raw header text is deliberate:
  // it is the value the tolerance check below uses, so a header with padding or a
  // duplicate `t=` cannot be signed under one reading and range-checked under
  // another.
  const expected = createHmac("sha256", secret)
    .update(String(parsed.timestamp) + ".", "utf8")
    .update(payload)
    .digest("hex");

  // Signature before tolerance, matching Stripe's own libraries. A request that
  // fails both should be reported as `no_match` -- calling a forged body "stale"
  // sends an operator looking for a clock skew that does not exist.
  const matched = parsed.signatures.some((candidate) => timingSafeHexEqual(candidate, expected));
  if (!matched) {
    return {
      ok: false,
      reason: "no_match",
      detail: parsed.signatures.length + " v1 signature(s), none matched",
    };
  }

  const ageSeconds = Math.abs(Math.floor(clock() / 1000) - parsed.timestamp);
  if (ageSeconds > tolerance) {
    // Absolute difference, so a delivery timestamped in the future is rejected
    // too: that is our clock being behind, and accepting it would silently widen
    // the replay window by however far behind we are.
    return {
      ok: false,
      reason: "timestamp_out_of_tolerance",
      detail: ageSeconds + "s from our clock, tolerance " + tolerance + "s",
    };
  }

  return { ok: true, timestamp: parsed.timestamp * 1000 };
}

/**
 * Constant-time comparison of two hex digests.
 *
 * The length and character-set guards are not constant time and do not need to be:
 * they reveal only the shape of the attacker's own input, never anything about the
 * expected digest. They exist because `timingSafeEqual` throws on a length
 * mismatch, and an exception here would become a 500 -- turning a malformed header
 * into an outage signal.
 */
function timingSafeHexEqual(candidate: string, expected: string): boolean {
  if (candidate.length !== SIGNATURE_HEX_LENGTH || expected.length !== SIGNATURE_HEX_LENGTH) {
    return false;
  }
  if (!/^[0-9a-fA-F]{64}$/.test(candidate)) return false;
  return timingSafeEqual(Buffer.from(candidate.toLowerCase(), "hex"), Buffer.from(expected, "hex"));
}

/**
 * How many attempts a single event gets before we stop asking Stripe to retry it.
 *
 * A 5xx tells Stripe to redeliver, which is right for a transient failure and
 * wrong for a permanent one: an event that can never be handled (a price that will
 * never be in the catalogue) would otherwise be redelivered for three days, and
 * every attempt costs a handler run and a log line. After this many, the receiver
 * answers 200 -- the ledger row stands as `failed` with the reason, `pending()`
 * still reports it, and the sweep can replay it once the cause is fixed.
 */
export const DEFAULT_MAX_DELIVERY_ATTEMPTS = 6;

export type WebhookOutcome =
  | "invalid_signature"
  | "invalid_payload"
  | "duplicate"
  | "in_flight"
  | "processed"
  | "ignored"
  | "failed"
  | "exhausted";

/**
 * What the route should send. Assembled here so the route owner writes
 * `res.writeHead(result.status, ...)` and nothing else -- the status codes are part
 * of the protocol with Stripe (2xx stops redelivery, anything else asks for it)
 * and are not a route's decision to make.
 */
export interface WebhookResult {
  status: 200 | 400 | 409 | 500;
  outcome: WebhookOutcome;
  eventId: string | null;
  body: { received: boolean; outcome: WebhookOutcome; eventId?: string; error?: string };
}

export interface WebhookReceiverOptions {
  /** The endpoint signing secret. One per endpoint, not per account. */
  secret: string;
  store: StripeEventStore;
  dispatcher: StripeDispatcher;
  logger?: Logger;
  toleranceSeconds?: number;
  staleAfterMs?: number;
  maxAttempts?: number;
  now?: () => number;
}

export interface WebhookDelivery {
  /** The untouched request body. See the module header before passing a string. */
  payload: string | Buffer;
  /** The `Stripe-Signature` header value. */
  signature: string | string[] | undefined | null;
}

export interface StripeWebhookReceiver {
  receive(delivery: WebhookDelivery): Promise<WebhookResult>;
}

export function createStripeWebhookReceiver(
  options: WebhookReceiverOptions,
): StripeWebhookReceiver {
  const { store, dispatcher, logger } = options;
  const clock = options.now ?? Date.now;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_DELIVERY_ATTEMPTS;

  async function receive(delivery: WebhookDelivery): Promise<WebhookResult> {
    const verified = verifyStripeSignature({
      payload: delivery.payload,
      header: delivery.signature,
      secret: options.secret,
      toleranceSeconds: options.toleranceSeconds,
      now: clock,
    });
    if (!verified.ok) {
      // Warn, not error: an unsigned probe against a public URL is background
      // noise on the internet, and paging on it trains people to ignore the page.
      // The reason is logged and only the reason -- not the body, which is
      // attacker-controlled and would be the payload of a log-injection attempt.
      logger?.warn("stripe.webhook.rejected", {
        reason: verified.reason,
        detail: verified.detail,
      });
      return result(400, "invalid_signature", null, { error: verified.reason });
    }

    let envelope: StripeEventEnvelope;
    try {
      // Parsed only now, and from the same bytes that were signed. `JSON.parse`
      // accepts a Buffer via its string coercion, which is exactly the round trip
      // the verifier must not do -- doing it here, after verification, is safe.
      envelope = parseEventEnvelope(
        JSON.parse(
          typeof delivery.payload === "string"
            ? delivery.payload
            : delivery.payload.toString("utf8"),
        ),
      );
    } catch (err) {
      // A signed body we cannot read is a version skew or a Stripe change, not an
      // attack: it is worth an error line. 400 rather than 500 because redelivering
      // the same bytes cannot help.
      logger?.error("stripe.webhook.unreadable", {
        error: err instanceof Error ? err.message : String(err),
        shape: err instanceof StripeShapeError,
      });
      return result(400, "invalid_payload", null, { error: "unreadable event payload" });
    }

    const now = clock();
    const claim = await store.claim(
      {
        id: envelope.id,
        type: envelope.type,
        livemode: envelope.livemode ? "live" : "test",
      },
      now,
      options.staleAfterMs,
    );

    if (claim.outcome === "duplicate") {
      // 200: the work is done. Stripe redelivers on anything else, and a duplicate
      // is the one case where redelivery would never stop being a duplicate.
      logger?.info("stripe.webhook.duplicate", {
        eventId: envelope.id,
        type: envelope.type,
        status: claim.record.status,
      });
      return result(200, "duplicate", envelope.id);
    }
    if (claim.outcome === "in_flight") {
      // Someone else is holding this event right now -- two Stripe deliveries
      // racing, or two app instances. 409 asks Stripe to come back later rather
      // than running the handler twice concurrently.
      logger?.warn("stripe.webhook.in_flight", { eventId: envelope.id, type: envelope.type });
      return result(409, "in_flight", envelope.id, { error: "event already in flight" });
    }

    return applyClaimed(envelope, claim.record.attempts, now);
  }

  function applyClaimed(
    envelope: StripeEventEnvelope,
    attempts: number,
    now: number,
  ): Promise<WebhookResult> {
    return applyEvent({ store, dispatcher, logger, maxAttempts }, envelope, attempts, now);
  }

  return { receive };
}

/** The deps `applyEvent` needs, shared by the receiver and the sweeper. */
interface ApplyDeps {
  store: StripeEventStore;
  dispatcher: StripeDispatcher;
  logger?: Logger;
  maxAttempts: number;
}

/**
 * Run the handler for an event this process has already claimed, and record the
 * result. The one place a `DispatchOutcome` -- or a throw -- becomes a ledger
 * status and an HTTP code, so a delivery and a sweep replay can never disagree
 * about what "failed" means.
 */
async function applyEvent(
  deps: ApplyDeps,
  envelope: StripeEventEnvelope,
  attempts: number,
  now: number,
): Promise<WebhookResult> {
  const { store, dispatcher, logger } = deps;
  try {
    const outcome = await dispatcher.dispatch(envelope, now);
    if (outcome.kind === "ignored") {
      await store.markIgnored(envelope.id, now);
      logger?.debug("stripe.webhook.ignored", {
        eventId: envelope.id,
        type: envelope.type,
        detail: outcome.detail,
      });
      return result(200, "ignored", envelope.id);
    }
    await store.markProcessed(envelope.id, outcome.orgId, now);
    logger?.info("stripe.webhook.processed", {
      eventId: envelope.id,
      type: envelope.type,
      orgId: outcome.orgId,
      detail: outcome.detail,
      attempts,
    });
    return result(200, "processed", envelope.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Recorded before the response is chosen, and in its own try: if the ledger
    // write also fails the row stays `received` and the stale window makes it
    // re-claimable, which is the same recovery path as a crash here.
    try {
      await store.markFailed(envelope.id, truncateError(message), now);
    } catch (ledgerErr) {
      logger?.error("stripe.webhook.ledger_write_failed", {
        eventId: envelope.id,
        error: ledgerErr instanceof Error ? ledgerErr.message : String(ledgerErr),
      });
    }
    const exhausted = attempts >= deps.maxAttempts;
    logger?.error("stripe.webhook.failed", {
      eventId: envelope.id,
      type: envelope.type,
      attempts,
      exhausted,
      error: message,
    });
    if (exhausted) return result(200, "exhausted", envelope.id, { error: message });
    return result(500, "failed", envelope.id, { error: message });
  }
}

function result(
  status: WebhookResult["status"],
  outcome: WebhookOutcome,
  eventId: string | null,
  extra: { error?: string } = {},
): WebhookResult {
  return {
    status,
    outcome,
    eventId,
    body: {
      received: status === 200,
      outcome,
      ...(eventId ? { eventId } : {}),
      ...(extra.error ? { error: extra.error } : {}),
    },
  };
}

/**
 * How the sweep gets an event back. `GET /v1/events/:id` -- Stripe keeps events
 * retrievable for 30 days, which is what makes replay possible at all: the ledger
 * stores no payload (schema.ts), deliberately, because a copy of every webhook body
 * is a second store of customer data to secure and expire, and Stripe already has
 * one that is authoritative.
 */
export interface StripeEventLookup {
  getEvent(id: string): Promise<StripeEventEnvelope | null>;
}

export interface SweepOptions {
  store: StripeEventStore;
  dispatcher: StripeDispatcher;
  events: StripeEventLookup;
  logger?: Logger;
  maxAttempts?: number;
  staleAfterMs?: number;
  /** Rows per run. Bounded so a scheduled sweep cannot become an unbounded job. */
  limit?: number;
  /**
   * Also retry rows that have already used up `maxAttempts`. Off by default: those
   * rows failed for a reason that redelivery did not fix, and an unattended sweep
   * that kept hammering them would turn one broken price id into a nightly incident.
   * An operator who has just fixed the cause turns this on for one run.
   */
  retryExhausted?: boolean;
  now?: () => number;
}

export interface SweepSummary {
  examined: number;
  processed: number;
  ignored: number;
  failed: number;
  /** Rows Stripe would not hand back -- past its 30-day window, or a test/live mix-up. */
  unavailable: number;
  /** Rows already taken by another worker, or held back by `retryExhausted`. */
  skipped: number;
}

/**
 * Finish the events that did not finish (M4.3).
 *
 * Stripe redelivers a failed webhook for about three days, so this is not the first
 * line of recovery -- the ledger's stale window plus Stripe's own retries handle the
 * ordinary crash. This is for what is left after that: the rows that outlived
 * Stripe's retries, and the ones a deploy fixed a week later. Re-claiming through
 * the same `claim` call is what keeps it safe to run beside live traffic.
 */
export async function sweepStripeEvents(options: SweepOptions): Promise<SweepSummary> {
  const { store, dispatcher, events, logger } = options;
  const clock = options.now ?? Date.now;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_DELIVERY_ATTEMPTS;
  const summary: SweepSummary = {
    examined: 0,
    processed: 0,
    ignored: 0,
    failed: 0,
    unavailable: 0,
    skipped: 0,
  };

  const rows = await store.pending(clock(), {
    staleAfterMs: options.staleAfterMs,
    limit: options.limit ?? 50,
  });
  for (const row of rows) {
    summary.examined += 1;
    if (!options.retryExhausted && row.attempts >= maxAttempts) {
      summary.skipped += 1;
      continue;
    }
    const now = clock();
    const claim = await store.claim(
      { id: row.id, type: row.type, livemode: row.livemode },
      now,
      options.staleAfterMs,
    );
    if (claim.outcome !== "claimed") {
      summary.skipped += 1;
      continue;
    }
    const envelope = await events.getEvent(row.id);
    if (!envelope) {
      await store.markFailed(row.id, "stripe no longer returns this event", now);
      summary.unavailable += 1;
      continue;
    }
    const applied = await applyEvent(
      { store, dispatcher, logger, maxAttempts },
      envelope,
      claim.record.attempts,
      now,
    );
    if (applied.outcome === "processed") summary.processed += 1;
    else if (applied.outcome === "ignored") summary.ignored += 1;
    else summary.failed += 1;
  }

  if (summary.examined > 0) logger?.info("stripe.sweep", { ...summary });
  return summary;
}
