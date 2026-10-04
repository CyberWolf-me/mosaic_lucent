import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { createHmac } from "node:crypto";
import { MockProvider, MockImageProvider } from "@lucent/ai";
import { createApp } from "../src/app.js";
import { InMemoryUserStore } from "../src/accounts.js";
import { InMemoryBoardStore } from "../src/boards.js";
import { InMemorySessionStore } from "../src/sessions.js";
import { UsageTracker, limitsFromEnv } from "../src/usage.js";
import { Telemetry } from "../src/telemetry.js";
import { Limiter } from "../src/limiter.js";
import { InMemoryTicketStore } from "../src/realtimeTicket.js";
import { readConfig } from "../src/config.js";
import { mintLiveKitToken, verifyLiveKitToken, type LiveKitConfig } from "../src/livekit.js";

/**
 * LiveKit token minting (E3 / R2): the wire-format contract, then the route.
 *
 * The format tests are the load-bearing ones. LiveKit's server accepts a
 * plain HS256 JWT with a documented claims shape; there is no SDK here (see
 * livekit.ts for why), which means the claim structure is ours to keep in
 * agreement with their docs — so each claim that matters to the product
 * (iss = api key, sub = user id for diarisation, video.room for scoping,
 * exp/nbf for the lifetime) is pinned by name. A change on either side
 * fails an assertion that says which claim moved.
 *
 * The route tests then prove the HTTP half: 503 unconfigured, 401
 * anonymous, and the full mint for an authenticated caller — the route the
 * web client's `fetchToken` has been pointing at since the STT provider
 * shipped.
 */

const SECRET = "test-secret-at-least-16-chars";
const API_KEY = "test-lk-key";
const API_SECRET = "test-lk-secret-with-enough-entropy";
const URL = "wss://lucent.test.livekit.cloud";
const CONFIG: LiveKitConfig = { apiKey: API_KEY, apiSecret: API_SECRET, url: URL };

function b64urlDecode(part: string): string {
  return Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

describe("mintLiveKitToken (wire format)", () => {
  it("is an HS256 JWT with LiveKit's documented grant payload", () => {
    const minted = mintLiveKitToken({
      config: CONFIG,
      room: "brd_abc",
      identity: "usr_1",
      name: "Ada",
      ttlSeconds: 300,
      now: () => 1_700_000_000_000,
    });
    const [header, payload, signature] = minted.token.split(".");
    expect(b64urlDecode(header!)).toBe(JSON.stringify({ alg: "HS256", typ: "JWT" }));

    const claims = JSON.parse(b64urlDecode(payload!)) as Record<string, unknown>;
    expect(claims.iss).toBe(API_KEY);
    expect(claims.sub).toBe("usr_1");
    expect(claims.name).toBe("Ada");
    expect(claims.nbf).toBe(1_700_000_000);
    expect(claims.exp).toBe(1_700_000_300);
    expect(claims.video).toEqual({
      room: "brd_abc",
      // roomJoin admits to the room (signal 401 without it — found by a
      // real headless join, not by reading docs harder).
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
      canUpdateOwnMetadata: false,
    });

    // The signature is a real HMAC over header.payload with the api secret.
    const expected = createHmac("sha256", API_SECRET).update(`${header}.${payload}`).digest();
    const expectedB64 = Buffer.from(expected)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(signature).toBe(expectedB64);
    expect(minted.url).toBe(URL);
    expect(minted.expiresAt).toBe(1_700_000_300_000);
  });

  it("round-trips through verifyLiveKitToken and rejects tampering", () => {
    const minted = mintLiveKitToken({ config: CONFIG, room: "r", identity: "usr_2" });
    const ok = verifyLiveKitToken(minted.token, API_SECRET);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect((ok.payload.video as { room: string }).room).toBe("r");

    const [h, p] = minted.token.split(".");
    const tamperedPayload = b64urlDecode(p!).replace('"usr_2"', '"usr_admin"');
    const reencoded = Buffer.from(tamperedPayload)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const bad = verifyLiveKitToken(`${h}.${reencoded}.deadbeef`, API_SECRET);
    expect(bad.ok).toBe(false);
    expect(bad.ok ? "" : bad.reason).toBe("signature mismatch");
  });

  it("never grants a token below the minimum lifetime", () => {
    const minted = mintLiveKitToken({
      config: CONFIG,
      room: "r",
      identity: "u",
      ttlSeconds: 1,
      now: () => 0,
    });
    const claims = JSON.parse(b64urlDecode(minted.token.split(".")[1]!)) as {
      exp: number;
      nbf: number;
    };
    expect(claims.exp - claims.nbf).toBeGreaterThanOrEqual(60);
  });
});

describe("POST /api/livekit/token (route)", () => {
  let base: string;
  let close: () => Promise<void>;

  afterEach(async () => {
    if (close) await close();
  });

  async function boot(livekitEnv: Record<string, string> = {}): Promise<void> {
    const limits = limitsFromEnv();
    const config = readConfig({
      LUCENT_REQUIRE_AUTH: "1",
      LUCENT_LIVEKIT_API_KEY: livekitEnv.LUCENT_LIVEKIT_API_KEY ?? "",
      LUCENT_LIVEKIT_API_SECRET: livekitEnv.LUCENT_LIVEKIT_API_SECRET ?? "",
      LUCENT_LIVEKIT_URL: livekitEnv.LUCENT_LIVEKIT_URL ?? "",
    });
    const app = createApp({
      config,
      provider: new MockProvider(),
      imageProvider: new MockImageProvider(),
      userStore: new InMemoryUserStore(),
      boardStore: new InMemoryBoardStore(),
      secret: SECRET,
      usage: new UsageTracker(limits),
      limits,
      telemetry: new Telemetry(),
      authLimiter: new Limiter(1000, 60_000),
      tickets: new InMemoryTicketStore(60_000),
      sessionStore: new InMemorySessionStore(),
    });
    await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
    const { port } = app.server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
    close = app.close;
  }

  async function signup(): Promise<string> {
    const res = await fetch(`${base}/api/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "voice@example.com", password: "password123", name: "Voice" }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { token: string }).token;
  }

  it("503s when LiveKit is not configured", async () => {
    await boot();
    const token = await signup();
    const res = await fetch(`${base}/api/livekit/token`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(503);
  });

  it("401s for anonymous callers", async () => {
    await boot({
      LUCENT_LIVEKIT_API_KEY: API_KEY,
      LUCENT_LIVEKIT_API_SECRET: API_SECRET,
      LUCENT_LIVEKIT_URL: URL,
    });
    const res = await fetch(`${base}/api/livekit/token`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("mints a per-user token for an authenticated caller (their private room)", async () => {
    await boot({
      LUCENT_LIVEKIT_API_KEY: API_KEY,
      LUCENT_LIVEKIT_API_SECRET: API_SECRET,
      LUCENT_LIVEKIT_URL: URL,
    });
    const token = await signup();
    const res = await fetch(`${base}/api/livekit/token`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; url: string; expiresAt: number };
    expect(body.url).toBe(URL);
    expect(body.expiresAt).toBeGreaterThan(Date.now());

    const verified = verifyLiveKitToken(body.token, API_SECRET);
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.payload.iss).toBe(API_KEY);
      expect(typeof verified.payload.sub).toBe("string");
      // docs/26 F1: an arbitrary room name ("brd_meeting") is refused now;
      // board rooms and the refusal are pinned in voice-security.test.ts.
      expect((verified.payload.video as { room: string }).room).toMatch(/^user-/);
    }
  });

  it("uses the caller's private room — not a shared one — when the body omits one", async () => {
    await boot({
      LUCENT_LIVEKIT_API_KEY: API_KEY,
      LUCENT_LIVEKIT_API_SECRET: API_SECRET,
      LUCENT_LIVEKIT_URL: URL,
    });
    const token = await signup();
    const res = await fetch(`${base}/api/livekit/token`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string };
    const verified = verifyLiveKitToken(body.token, API_SECRET);
    if (verified.ok) {
      expect((verified.payload.video as { room: string }).room).toMatch(/^user-usr_/);
    } else {
      expect.fail("token failed verification");
    }
  });

  describe("POST /api/livekit/dispatch", () => {
    it("answers 503 when LiveKit is not configured", async () => {
      await boot();
      const token = await signup();
      const res = await fetch(`${base}/api/livekit/dispatch`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ room: "voice_brd_test" }),
      });
      expect(res.status).toBe(503);
    });

    it("answers 401 when caller has no session", async () => {
      await boot({
        LUCENT_LIVEKIT_API_KEY: API_KEY,
        LUCENT_LIVEKIT_API_SECRET: API_SECRET,
        LUCENT_LIVEKIT_URL: URL,
      });
      const res = await fetch(`${base}/api/livekit/dispatch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ room: "voice_brd_test" }),
      });
      expect(res.status).toBe(401);
    });

    it("answers 400 when body is missing room and boardId", async () => {
      await boot({
        LUCENT_LIVEKIT_API_KEY: API_KEY,
        LUCENT_LIVEKIT_API_SECRET: API_SECRET,
        LUCENT_LIVEKIT_URL: URL,
      });
      const token = await signup();
      const res = await fetch(`${base}/api/livekit/dispatch`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });
  });
});
