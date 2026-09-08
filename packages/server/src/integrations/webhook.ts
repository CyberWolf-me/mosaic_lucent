import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * The inbound webhook receiver (Stage D7, ADR 0033).
 *
 * THE THREE DOCTRINES, copied verbatim from the Stripe receiver
 * (billing/webhook.ts) because ADR 0032 named it "the copied-verbatim
 * precedent":
 *
 * - THE RAW BODY IS THE MESSAGE. The signature covers exact bytes; a
 *   re-serialised body makes every signature fail. The route hands the
 *   receiver a Buffer and nothing in this file decodes before verify.
 * - VERIFICATION COMES FIRST, ALWAYS. Nothing touches the event ledger
 *   until the HMAC matches; writing before verifying would let anyone
 *   fill the ledger and claim event ids.
 * - THE SIGNATURE IS THE AUTHENTICATION. No session, no CSRF, no origin
 *   check; the route sits before every auth guard in the ladder.
 *
 * THE SIGNATURE IS ALSO THE ORG RESOLUTION (the one place this receiver
 * differs from Stripe's single-secret model): Linear webhooks are
 * configured per-org, so the receiver iterates the provider's ACTIVE
 * connections, resolves each `config.webhookSecretRef` through the
 * environment (a REFERENCE on the connection, never a value in the DB —
 * the same env-ref temporariness clause as credentialRef, ADR 0033),
 * computes the HMAC for EVERY candidate, and only then resolves the
 * match. Checking all candidates before resolving is a timing-hygiene
 * choice: an early exit on the first match would leak, through latency,
 * which org a given secret belongs to.
 *
 * Linear's scheme (the documented divergence from Stripe's t=,v1=
 * header): `X-Signature` is the bare hex HMAC-SHA256 of the raw request
 * body under the connection's webhook secret. No timestamp in the
 * header — Linear does not sign one — so the replay defence is the
 * delivery-level dedupe (identical bytes = the same ledger row), not a
 * tolerance window. The sweeper refetches current truth via getTask,
 * so a replayed event can never resurrect a stale value.
 */

/** A Linear signature is HMAC-SHA256 hex: always exactly 64 characters. */
const SIGNATURE_HEX_LENGTH = 64;

/** The bytes one webhook delivery may occupy. Linear entities are small;
 * a project list is not going to arrive as one issue update. This bound
 * exists so a public endpoint cannot park a giant body in memory. */
export const MAX_WEBHOOK_BYTES = 1_000_000;

export type IntegrationSignatureFailureReason =
  | "missing_header"
  | "malformed_header"
  | "no_candidate_secrets"
  | "no_match";

export interface SignatureCandidate {
  /** The connection id — how the caller learns WHICH org signed. */
  connectionId: string;
  orgId: string;
  /** The resolved secret VALUE (from the environment, at receive time). */
  secret: string;
}

export type LinearSignatureResult =
  | { ok: true; match: SignatureCandidate }
  | { ok: false; reason: IntegrationSignatureFailureReason; detail: string };

/**
 * Verify `X-Signature` against every candidate secret. Returns the
 * matching connection so the caller knows the org; `no_match` when none
 * verify. Hex-charset and length guards run BEFORE the constant-time
 * compare so a malformed header is a clean false, never a thrown
 * `timingSafeEqual` (a 500 on attacker input is an outage signal).
 */
export function verifyLinearSignature(
  raw: Buffer,
  candidates: SignatureCandidate[],
  header: string | string[] | undefined | null,
): LinearSignatureResult {
  const headerValue = Array.isArray(header) ? header[0] : header;
  if (headerValue === undefined || headerValue === null || headerValue === "") {
    return { ok: false, reason: "missing_header", detail: "no X-Signature header" };
  }
  const signature = headerValue.trim().toLowerCase();
  if (signature.length !== SIGNATURE_HEX_LENGTH || !/^[0-9a-f]{64}$/.test(signature)) {
    return { ok: false, reason: "malformed_header", detail: "X-Signature is not a 64-char hex digest" };
  }
  if (candidates.length === 0) {
    return {
      ok: false,
      reason: "no_candidate_secrets",
      detail: "no active connection carries a resolvable webhookSecretRef",
    };
  }
  // ALL candidates are computed before any match resolves — the timing
  // hygiene the org-resolution design requires.
  let match: SignatureCandidate | null = null;
  for (const candidate of candidates) {
    const expected = createHmac("sha256", candidate.secret).update(raw).digest("hex");
    if (
      expected.length === SIGNATURE_HEX_LENGTH &&
      timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"))
    ) {
      match = candidate;
    }
  }
  if (!match) {
    return {
      ok: false,
      reason: "no_match",
      detail: "signature matches no active connection secret",
    };
  }
  return { ok: true, match };
}

/* -------------------------------------------------------------------------- */
/* Payload parsing — after verification, from the same signed bytes            */
/* -------------------------------------------------------------------------- */

/**
 * What a verified delivery reduces to: the ExternalTaskChange the D4
 * seam declared, or `ignored` for everything Lucent does not sync
 * inbound. Parsed ONLY from the exact bytes that were signed.
 *
 * Linear's webhook entity shape (the documented notification payload):
 * `{ action, type, created_at, data, url }` where an issue update
 * carries `type: "Issue"` and `data: { id, identifier, name, state,
 * ... }` with `state: { name, type }`. Non-issue entities (comments,
 * projects, labels) and the `create`/`remove` actions are `ignored`:
 * inbound create is a future import flow, and remove is the sweep's
 * documented link-GC decision — neither silently becomes a board write.
 */
export interface ParsedWebhook {
  kind: "change";
  change: { provider: string; externalId: string; status: string; at: number };
}

export type ParseResult =
  | { kind: "change"; change: { provider: string; externalId: string; status: string; at: number } }
  | { kind: "ignored"; reason: string };

export function parseLinearWebhook(provider: string, raw: Buffer, at: number): ParseResult {
  let body: {
    action?: unknown;
    type?: unknown;
    data?: { identifier?: unknown; state?: { name?: unknown } | null };
  };
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    // A signed body we cannot read is a provider change, not an attack.
    return { kind: "ignored", reason: "unreadable payload" };
  }
  if (typeof body.type !== "string" || body.type !== "Issue") {
    return { kind: "ignored", reason: `entity "${String(body.type)}" is not an issue` };
  }
  const action = typeof body.action === "string" ? body.action : "";
  if (action !== "update") {
    return { kind: "ignored", reason: `action "${action}" is not an update` };
  }
  const data = body.data ?? {};
  const identifier = typeof data.identifier === "string" ? data.identifier.trim() : "";
  const stateName = typeof data.state?.name === "string" ? data.state.name : "";
  if (!identifier || !stateName) {
    return { kind: "ignored", reason: "the issue update carries no identifier/state" };
  }
  return {
    kind: "change",
    change: { provider, externalId: identifier, status: stateName, at },
  };
}

/* -------------------------------------------------------------------------- */
/* The webhook scheme registry (Stage D8, ADR 0034)                            */
/* -------------------------------------------------------------------------- */

/**
 * WHAT ONE PROVIDER'S WEBHOOK DELIVERIES LOOK LIKE. The receiver owns the
 * generic half — claim ledger, org resolution, dedupe, queue ingest — and
 * each scheme owns exactly the provider-specific half: which header carries
 * the signature, how it verifies against the candidate secrets, and how the
 * verified bytes reduce to a change. A provider with no inbound scheme
 * (Jira in D8: Atlassian's Connect JWT/QSH model is its own project, not a
 * guess to make) answers the honest 404 at the route.
 */
export interface WebhookScheme {
  readonly name: string;
  /** The request header the signature arrives in (lowercased). */
  readonly signatureHeader: string;
  /** Verify the raw bytes against the candidates; resolve the org. */
  verify(
    raw: Buffer,
    candidates: SignatureCandidate[],
    header: string | string[] | undefined | null,
  ): LinearSignatureResult;
  /** Reduce the verified bytes to a change or an honest ignore. */
  parse(provider: string, raw: Buffer, at: number): ParseResult;
}

/** The Linear scheme — the two functions the D7 receiver was built on,
 * unchanged (behavior-pinned by the receiver suite). */
export const linearWebhookScheme: WebhookScheme = {
  name: "linear",
  signatureHeader: "x-signature",
  verify: verifyLinearSignature,
  parse: parseLinearWebhook,
};

/**
 * The GitHub scheme. `X-Hub-Signature-256` carries `sha256=<hex>` (the
 * documented prefix — stripped before the same constant-time compare).
 * The payload is the issues webhook: `{ action, issue: { number, state,
 * state_reason } }`; the status word COMPOSES state+state_reason — the
 * exact external observation ("closed:not_planned") the inbound queue
 * stores as externalValue and mapStatus translates. Only the status-
 * relevant actions emit: opened/reopened/closed. `edited` is ignored
 * (D7 is status-first; title/body edits are not status drift).
 */
export const githubWebhookScheme: WebhookScheme = {
  name: "github",
  signatureHeader: "x-hub-signature-256",
  verify(raw, candidates, header) {
    const headerValue = Array.isArray(header) ? header[0] : header;
    if (headerValue === undefined || headerValue === null || headerValue === "") {
      return {
        ok: false,
        reason: "missing_header",
        detail: "no X-Hub-Signature-256 header",
      };
    }
    // `sha256=<hex>`: reject the wrong prefix or a non-hex remainder.
    const value = headerValue.trim().toLowerCase();
    const GITHUB_PREFIX = "sha256=";
    if (!value.startsWith(GITHUB_PREFIX)) {
      return {
        ok: false,
        reason: "malformed_header",
        detail: "X-Hub-Signature-256 must be sha256=<hex>",
      };
    }
    const signature = value.slice(GITHUB_PREFIX.length);
    // Same compare as Linear, with the same guards — the raw bytes are the
    // message in both schemes.
    if (signature.length !== SIGNATURE_HEX_LENGTH || !/^[0-9a-f]{64}$/.test(signature)) {
      return {
        ok: false,
        reason: "malformed_header",
        detail: "X-Hub-Signature-256 is not a 64-char hex digest",
      };
    }
    if (candidates.length === 0) {
      return {
        ok: false,
        reason: "no_candidate_secrets",
        detail: "no active connection carries a resolvable webhookSecretRef",
      };
    }
    let match: SignatureCandidate | null = null;
    for (const candidate of candidates) {
      const expected = createHmac("sha256", candidate.secret).update(raw).digest("hex");
      if (
        expected.length === SIGNATURE_HEX_LENGTH &&
        timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"))
      ) {
        match = candidate;
      }
    }
    if (!match) {
      return { ok: false, reason: "no_match", detail: "signature matches no active connection secret" };
    }
    return { ok: true, match };
  },
  parse(provider, raw, at) {
    let body: {
      action?: unknown;
      issue?: { number?: unknown; state?: unknown; state_reason?: unknown } | null;
    };
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      return { kind: "ignored", reason: "unreadable payload" } as ParseResult;
    }
    const action = typeof body.action === "string" ? body.action : "";
    if (action !== "opened" && action !== "reopened" && action !== "closed") {
      return { kind: "ignored", reason: `action "${action}" does not change status` } as ParseResult;
    }
    const issue = body.issue;
    const number = issue && typeof issue.number === "number" ? issue.number : null;
    if (number === null) {
      return { kind: "ignored", reason: "the issue webhook carries no issue.number" } as ParseResult;
    }
    const state = issue && typeof issue.state === "string" ? issue.state : "";
    const stateReason =
      issue && typeof issue.state_reason === "string" ? issue.state_reason : null;
    if (!state) {
      return { kind: "ignored", reason: "the issue carries no state" } as ParseResult;
    }
    // The composed word — the exact observation (closed:not_planned).
    const word = state === "closed" && stateReason ? `closed:${stateReason}` : state;
    return {
      kind: "change",
      change: { provider, externalId: String(number), status: word, at },
    } as ParseResult;
  },
};

/** The registry the route reads. A provider absent from this map answers
 * the honest 404 — no inbound scheme exists for it (yet or ever). The
 * fake entry exists so the route machinery stays testable end to end
 * without a real provider (the D4 test-double's role; it parses the same
 * Linear-shaped test payloads the D7 route suite was built on). */
export const fakeWebhookScheme: WebhookScheme = {
  name: "fake",
  signatureHeader: "x-signature",
  verify: verifyLinearSignature,
  parse: parseLinearWebhook,
};

export const webhookSchemes: ReadonlyMap<string, WebhookScheme> = new Map([
  ["linear", linearWebhookScheme],
  ["github", githubWebhookScheme],
  ["fake", fakeWebhookScheme],
]);

export const INTEGRATION_EVENT_STATUSES = [
  "received",
  "processed",
  "ignored",
  "failed",
] as const;
export type IntegrationEventStatus = (typeof INTEGRATION_EVENT_STATUSES)[number];

export interface IntegrationWebhookEvent {
  /** sha256(provider + ":" + raw bytes hex) — identical bytes, identical row. */
  id: string;
  provider: string;
  orgId: string | null;
  externalId: string | null;
  status: IntegrationEventStatus;
  attempts: number;
  error?: string;
  claimedAt: number;
  receivedAt: number;
}

export type IntegrationEventClaim =
  | { outcome: "claimed"; event: IntegrationWebhookEvent }
  | { outcome: "duplicate"; event: IntegrationWebhookEvent }
  | { outcome: "in_flight"; event: IntegrationWebhookEvent };

export interface IntegrationWebhookEventStore {
  /**
   * The Stripe claim protocol, verbatim: first insert wins, a pending
   * re-claim past the stale window recovers a crashed worker, a fresh
   * claim by another holder is `in_flight`.
   */
  claim(input: {
    id: string;
    provider: string;
    orgId: string | null;
    externalId: string | null;
    now: number;
    staleAfterMs: number;
  }): Promise<IntegrationEventClaim>;
  /** pending(staleAt, now, limit) — the sweeper's work list. */
  pending(staleAt: number, now: number, limit: number): Promise<IntegrationWebhookEvent[]>;
  markProcessed(id: string, orgId: string | null, now: number): Promise<void>;
  markIgnored(id: string, now: number): Promise<void>;
  markFailed(id: string, error: string, now: number): Promise<void>;
  /**
   * Stage D10, ADR 0036: delete TERMINAL rows older than the horizon —
   * processed | ignored | exhausted (the complete set; FAILED is retryable
   * by the claim ladder's semantics and is NEVER pruned here). The cutoff
   * reads the TERMINAL timestamp (claimedAt, where the terminal marks
   * write), never receivedAt, so pending/in-flight rows are structurally
   * safe even against a query bug. Capped per run (bounded sweeps).
   *
   * The prune-replay rule (ADR 0036): pruning a dedupe row can allow an old
   * redelivery to look new — the second barrier is semantic, the ingest's
   * resolution-level dedupe plus the sweeper's refetch-current-truth arm,
   * which the ADR records and the tests pin.
   */
  pruneTerminal(terminalBefore: number, limit: number): Promise<number>;
}

export const DEFAULT_WEBHOOK_STALE_MS = 60_000;

/** The InMemory ledger twin (the pg-stripe-events doctrine; the PG pair
 * lands in Batch 2 with migration 0021). */
export class InMemoryIntegrationWebhookEventStore implements IntegrationWebhookEventStore {
  private readonly events = new Map<string, IntegrationWebhookEvent>();

  async claim(input: {
    id: string;
    provider: string;
    orgId: string | null;
    externalId: string | null;
    now: number;
    staleAfterMs: number;
  }): Promise<IntegrationEventClaim> {
    const existing = this.events.get(input.id);
    if (existing) {
      const stale = input.now - existing.claimedAt > input.staleAfterMs;
      // The claim ladder (the ledger's semantics): FAILED re-claims
      // immediately (the work errored, nobody is mid-flight); RECEIVED
      // inside the window is in_flight (a holder is presumed working);
      // RECEIVED past the window re-claims (the holder crashed).
      if (existing.status === "failed") {
        const reclaimed: IntegrationWebhookEvent = {
          ...existing,
          claimedAt: input.now,
          attempts: existing.attempts + 1,
        };
        this.events.set(input.id, reclaimed);
        return { outcome: "claimed", event: { ...reclaimed } };
      }
      if (existing.status === "received") {
        if (!stale) return { outcome: "in_flight", event: { ...existing } };
        const reclaimed: IntegrationWebhookEvent = {
          ...existing,
          claimedAt: input.now,
          attempts: existing.attempts + 1,
        };
        this.events.set(input.id, reclaimed);
        return { outcome: "claimed", event: { ...reclaimed } };
      }
      return { outcome: "duplicate", event: { ...existing } };
    }
    const row: IntegrationWebhookEvent = {
      id: input.id,
      provider: input.provider,
      orgId: input.orgId,
      externalId: input.externalId,
      status: "received",
      attempts: 1,
      claimedAt: input.now,
      receivedAt: input.now,
    };
    this.events.set(row.id, row);
    return { outcome: "claimed", event: { ...row } };
  }

  async pending(staleAt: number, now: number, limit: number): Promise<IntegrationWebhookEvent[]> {
    return [...this.events.values()]
      .filter(
        (e) =>
          (e.status === "received" || e.status === "failed") &&
          e.claimedAt <= staleAt &&
          e.claimedAt <= now,
      )
      .sort((a, b) => a.claimedAt - b.claimedAt)
      .slice(0, limit)
      .map((e) => ({ ...e }));
  }

  async markProcessed(id: string, orgId: string | null, now: number): Promise<void> {
    const found = this.events.get(id);
    if (found) this.events.set(id, { ...found, status: "processed", orgId, claimedAt: now });
  }

  async markIgnored(id: string, now: number): Promise<void> {
    const found = this.events.get(id);
    if (found) this.events.set(id, { ...found, status: "ignored", claimedAt: now });
  }

  async markFailed(id: string, error: string, now: number): Promise<void> {
    const found = this.events.get(id);
    if (found) this.events.set(id, { ...found, status: "failed", error, claimedAt: now });
  }

  async pruneTerminal(terminalBefore: number, limit: number): Promise<number> {
    // The terminal set only (failed is retryable — never pruned); the
    // cutoff reads claimedAt, where the terminal marks write.
    const TERMINAL = new Set(["processed", "ignored", "exhausted"]);
    const doomed = [...this.events.values()]
      .filter((e) => TERMINAL.has(e.status) && e.claimedAt < terminalBefore)
      .sort((a, b) => a.claimedAt - b.claimedAt)
      .slice(0, limit);
    for (const row of doomed) this.events.delete(row.id);
    return doomed.length;
  }
}

/* -------------------------------------------------------------------------- */
/* The receiver                                                                */
/* -------------------------------------------------------------------------- */

export type IntegrationWebhookOutcome =
  | "invalid_signature"
  | "invalid_payload"
  | "duplicate"
  | "in_flight"
  | "processed"
  | "ignored"
  | "no_subscription"
  | "failed";

export interface IntegrationWebhookResult {
  status: 200 | 400 | 409 | 500;
  outcome: IntegrationWebhookOutcome;
  eventId: string | null;
  body: { received: boolean; outcome: IntegrationWebhookOutcome; eventId?: string; error?: string };
}

/** What the receiver needs to resolve orgs + store + hand off a change. */
export interface IntegrationWebhookReceiverOptions {
  /** The provider name the route matched (e.g. "linear"). */
  provider: string;
  /**
   * The provider's scheme (Stage D8): which header carries the signature,
   * how it verifies, how the bytes parse. The receiver keeps the generic
   * half — claim, ledger, dedupe, ingest.
   */
  scheme: WebhookScheme;
  /**
   * The candidate secrets, pre-resolved by the caller (the route reads
   * active connections + their `config.webhookSecretRef` values through
   * the environment). Computed here as HMACs, all before any match.
   */
  candidates: SignatureCandidate[];
  events: IntegrationWebhookEventStore;
  /** Where a verified change lands: the inbound queue's ingest. */
  onChange: (change: { provider: string; externalId: string; status: string; at: number }, orgId: string) => Promise<void>;
  staleAfterMs?: number;
  now?: () => number;
}

export interface IntegrationWebhookDelivery {
  /** The untouched request body — a Buffer, the safer seam. */
  payload: Buffer;
  /** The `X-Signature` header value. */
  signature: string | string[] | undefined | null;
}

export interface IntegrationWebhookReceiver {
  receive(delivery: IntegrationWebhookDelivery): Promise<IntegrationWebhookResult>;
}

export function integrationWebhookEventId(provider: string, raw: Buffer): string {
  // sha256 over provider + the exact bytes: a redelivered body IS the
  // same event; two identical-looking updates from different deliveries
  // (different bytes, e.g. different createdAt) are two events.
  return createHash("sha256").update(`${provider}:`).update(raw).digest("hex");
}

export function createIntegrationWebhookReceiver(
  options: IntegrationWebhookReceiverOptions,
): IntegrationWebhookReceiver {
  const { provider, candidates, events } = options;
  const clock = options.now ?? Date.now;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_WEBHOOK_STALE_MS;

  function result(
    status: IntegrationWebhookResult["status"],
    outcome: IntegrationWebhookOutcome,
    eventId: string | null,
    extra: { error?: string } = {},
  ): IntegrationWebhookResult {
    return {
      status,
      outcome,
      eventId,
      body: {
        received: status === 200,
        outcome,
        ...(eventId ? { eventId } : {}),
        ...extra,
      },
    };
  }

  async function receive(delivery: IntegrationWebhookDelivery): Promise<IntegrationWebhookResult> {
    const now = clock();
    const raw = delivery.payload;

    // Doctrine 1 + 2: verify the exact bytes, before anything is ledgered.
    // The scheme owns the header format and the compare; the org resolution
    // (all candidates computed before any match) is either scheme's.
    const verified = options.scheme.verify(raw, candidates, delivery.signature);
    if (!verified.ok) {
      // The reason only — never the body, which is attacker-controlled.
      return result(400, "invalid_signature", null, { error: verified.reason });
    }

    // A subscription nobody configured secrets for: the signature cannot
    // be the auth because there is no auth to be. The honest 401-shape
    // answer (this status is part of the protocol: the provider's
    // dashboard shows it and the operator fixes the config).
    if (candidates.length === 0) {
      return result(400, "no_subscription", null, {
        error: "no active connection carries a resolvable webhookSecretRef",
      });
    }

    const parsed = options.scheme.parse(provider, raw, now);
    const externalId = parsed.kind === "change" ? parsed.change.externalId : null;
    const eventId = integrationWebhookEventId(provider, raw);

    // Verify-before-ledger: the claim happens only after the HMAC held.
    const claim = await events.claim(
      { id: eventId, provider, orgId: verified.match.orgId, externalId, now, staleAfterMs },
    );
    if (claim.outcome === "duplicate") {
      return result(200, "duplicate", eventId);
    }
    if (claim.outcome === "in_flight") {
      return result(409, "in_flight", eventId, { error: "event already in flight" });
    }

    if (parsed.kind === "ignored") {
      await events.markIgnored(eventId, now);
      return result(200, "ignored", eventId);
    }

    try {
      await options.onChange(parsed.change, verified.match.orgId);
      await events.markProcessed(eventId, verified.match.orgId, now);
      return result(200, "processed", eventId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      try {
        await events.markFailed(eventId, message.slice(0, 300), now);
      } catch {
        // The row stays `received`; the stale window makes it re-claimable.
      }
      return result(500, "failed", eventId, { error: message.slice(0, 300) });
    }
  }

  return { receive };
}
