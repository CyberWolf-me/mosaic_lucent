import { createHmac, timingSafeEqual as timingSafeEqualBytes } from "node:crypto";

/**
 * LiveKit access-token minting (E3 / R2).
 *
 * LiveKit Cloud authorises a client with a JWT the application mints and
 * hands over — the server is the only side that holds the API secret, the
 * client never sees it, exactly like the LLM provider key. The wire format
 * is plain JWT (HS256) with a LiveKit-defined claims payload:
 *
 *   header:  { alg: "HS256", typ: "JWT" }
 *   payload: { iss: <api key>, sub: <identity>, nbf, exp, name?, video: {
 *               room, canPublish: true, canSubscribe: true } }
 *
 * Implemented with `node:crypto` HMAC rather than the `livekit` server SDK:
 * the SDK would add a dependency and its own token-claim surface for what
 * is, on the wire, one signed JSON object — the same reasoning the repo
 * applied to Stripe (billing/stripe.ts) and the whole framework-free server
 * (ADR 0002). The cost is owning the claim shape, and the tests pin it: if
 * LiveKit ever diverges, the failing assertion names the exact claim.
 *
 * No vendor lock: `LUCENT_LIVEKIT_URL` points at LiveKit Cloud *or* a
 * self-hosted server; the token format is identical.
 */

/** The LiveKit API credentials a deployment configures. */
export interface LiveKitConfig {
  /** The public key half ("APIKeyString" in the LiveKit console). */
  apiKey: string;
  /** The secret half. Never leaves this module's call site. */
  apiSecret: string;
  /** wss://… URL clients connect to; returned to the browser untouched. */
  url: string;
}

/** Everything the mint needs; everything else is defaulted. */
export interface MintLiveKitTokenInput {
  config: LiveKitConfig;
  /** Room name — per-board in the product (`brd_…`), so presence is scoped. */
  room: string;
  /** The authenticated user id; becomes `sub` and is how LiveKit identifies the speaker (diarisation rides on it). */
  identity: string;
  /** Display name for the LiveKit participant list. */
  name?: string;
  /** Token lifetime in seconds. LiveKit's own default is 6h; we default far shorter (10m) because the client re-mints on every session start. */
  ttlSeconds?: number;
  /** Test seam for the expiry math. */
  now?: () => number;
}

export interface MintedLiveKitToken {
  token: string;
  /** The connection URL from config, echoed for the client. */
  url: string;
  /** Epoch ms when the token stops authorising. */
  expiresAt: number;
}

/** Minimum sensible lifetime: one turn of speech plus margin. */
export const MIN_TTL_SECONDS = 60;
export const DEFAULT_TTL_SECONDS = 600;

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Mint one access token. The claims are LiveKit's documented grant set;
 * `canPublish`/`canSubscribe` are explicit so a future "viewer mic-muted"
 * policy has a clear place to change rather than an implicit default.
 */
export function mintLiveKitToken(input: MintLiveKitTokenInput): MintedLiveKitToken {
  const ttl = Math.max(MIN_TTL_SECONDS, input.ttlSeconds ?? DEFAULT_TTL_SECONDS);
  const nowMs = (input.now ?? Date.now)();
  const nowSec = Math.floor(nowMs / 1000);

  const header = { alg: "HS256", typ: "JWT" };
  const payload: Record<string, unknown> = {
    iss: input.config.apiKey,
    sub: input.identity,
    nbf: nowSec,
    exp: nowSec + ttl,
    video: {
      room: input.room,
      // roomJoin is what the signal path actually authorizes: without it
      // LiveKit answers 401 "permissions denied" on connect (found by a
      // real headless join, 2026-09-17 — publish/subscribe alone do not
      // admit anyone to the room).
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
    },
    ...(input.name ? { name: input.name } : {}),
  };

  const headerB64 = base64url(JSON.stringify(header));
  const payloadB64 = base64url(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = base64url(
    createHmac("sha256", input.config.apiSecret).update(signingInput).digest(),
  );

  return {
    token: `${signingInput}.${signature}`,
    url: input.config.url,
    expiresAt: nowMs + ttl * 1000,
  };
}

/**
 * Decode + verify a token minted by `mintLiveKitToken` — the test-side proof
 * that the wire format is a well-formed LiveKit JWT. Verification is
 * constant-time through `timingSafeEqual` on the recomputed signature.
 */
export function verifyLiveKitToken(
  token: string,
  apiSecret: string,
): { ok: true; payload: Record<string, unknown> } | { ok: false; reason: string } {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "not a JWS compact serialization" };
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];
  const expected = base64url(
    createHmac("sha256", apiSecret).update(`${headerB64}.${payloadB64}`).digest(),
  );
  const a = Buffer.from(signatureB64);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqualBytes(a, b)) {
    return { ok: false, reason: "signature mismatch" };
  }
  try {
    const payload = JSON.parse(
      Buffer.from(payloadB64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
    );
    return { ok: true, payload: payload as Record<string, unknown> };
  } catch {
    return { ok: false, reason: "payload is not JSON" };
  }
}
