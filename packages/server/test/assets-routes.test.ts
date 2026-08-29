import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
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
import {
  AssetService,
  InMemoryAssetStore,
  InMemoryBlobBackend,
  NoThumbnailer,
} from "../src/assets.js";

/**
 * Asset-gateway route tests (M7 / M4 storage).
 *
 * Drives the real `createApp` over a free port so a single body of tests
 * exercises the cookie auth, the CSRF check, the JSON-or-binary content
 * split, and the asset service's own tenant boundary at once. Everything
 * that is not the gateway itself is mocked to the in-memory defaults so a
 * regression in the route wiring is the only thing that can turn this red.
 *
 * PNG fixture: a 1x1 byte string that decodes as a real image. Asset-service
 * validation sniffs the magic bytes, so anything that does not look like a
 * supported image must 400 out — which is what two of the tests check.
 */

const SECRET = "test-secret-at-least-16-chars";
const ORIGIN = "http://localhost:5173";

/** Smallest valid PNG: 8-byte signature + 13-byte IHDR + 12-byte IDAT (one black pixel) + IEND. */
const PNG_1x1 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x00, 0x00, 0x00, 0x00, 0x3a, 0x7e, 0x9b,
  0x55, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

/** Random non-image bytes — the validator must reject these with a 400. */
const NOT_AN_IMAGE = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);

interface SignedUp {
  cookies: string;
  csrf: { cookieValue: string; headerValue: string };
  userId: string;
}

interface Harness {
  base: string;
  close: () => Promise<void>;
  signup: (email: string, name?: string) => Promise<SignedUp>;
  request: (
    cookies: string,
    init: {
      method?: string;
      path: string;
      body?: Uint8Array | string | undefined;
      contentType?: string;
      csrf?: string;
      extraHeaders?: Record<string, string>;
    },
  ) => Promise<{
    status: number;
    body: any;
    headers: Record<string, string | string[]>;
    raw: Uint8Array;
  }>;
}

async function harness(): Promise<Harness> {
  const limits = limitsFromEnv();
  const config = readConfig({ LUCENT_REQUIRE_AUTH: "1", LUCENT_WEB_ORIGIN: ORIGIN });
  const userStore = new InMemoryUserStore();
  const assetService = new AssetService({
    store: new InMemoryAssetStore(),
    blobs: new InMemoryBlobBackend(),
    thumbnails: new NoThumbnailer(),
  });
  const { server, close } = createApp({
    config,
    provider: new MockProvider(),
    imageProvider: new MockImageProvider(),
    userStore,
    boardStore: new InMemoryBoardStore(),
    sessionStore: new InMemorySessionStore(),
    secret: SECRET,
    usage: new UsageTracker(limits),
    limits,
    telemetry: new Telemetry(),
    authLimiter: new Limiter(1000, 60_000),
    tickets: new InMemoryTicketStore(60_000),
    assetService,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  function pickCookie(setCookie: string | string[] | undefined, name: string): string | undefined {
    const list = Array.isArray(setCookie) ? setCookie : [setCookie ?? ""];
    for (const raw of list) {
      const eq = raw.indexOf("=");
      if (eq < 0) continue;
      if (raw.slice(0, eq).trim() !== name) continue;
      return raw.slice(eq + 1).split(";")[0] ?? "";
    }
    return undefined;
  }

  async function csrfTokens(): Promise<{ cookieValue: string; headerValue: string }> {
    const res = await fetch(`${base}/api/auth/csrf`, { headers: { origin: ORIGIN } });
    const body = (await res.json()) as { token: string };
    const cookieValue = pickCookie(res.headers.get("set-cookie") ?? "", "lucent_csrf");
    if (!cookieValue) throw new Error("csrf route did not set a lucent_csrf cookie");
    return { cookieValue, headerValue: body.token };
  }

  const signup = async (email: string, name?: string): Promise<SignedUp> => {
    const csrf = await csrfTokens();
    const res = await fetch(`${base}/api/auth/signup`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        cookie: `lucent_csrf=${csrf.cookieValue}`,
        "x-csrf-token": csrf.headerValue,
      },
      body: JSON.stringify({ email, password: "password123", name: name ?? email.split("@")[0] }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { user: { id: string } };
    const sessionCookie = pickCookie(res.headers.get("set-cookie") ?? "", "lucent_session");
    if (!sessionCookie) throw new Error("signup did not set a session cookie");
    return {
      cookies: `lucent_session=${sessionCookie}; lucent_csrf=${csrf.cookieValue}`,
      csrf,
      userId: body.user.id,
    };
  };

  const request: Harness["request"] = async (cookies, init) => {
    const headers: Record<string, string> = {
      origin: ORIGIN,
      cookie: cookies,
    };
    if (init.body instanceof Uint8Array) {
      headers["content-type"] = init.contentType ?? "image/png";
    } else if (init.body !== undefined) {
      headers["content-type"] = init.contentType ?? "application/json";
    }
    if (init.csrf) headers["x-csrf-token"] = init.csrf;
    if (init.extraHeaders) Object.assign(headers, init.extraHeaders);
    const body =
      init.body instanceof Uint8Array
        ? Buffer.from(init.body)
        : init.body !== undefined
          ? init.body
          : undefined;
    const res = await fetch(`${base}${init.path}`, {
      method: init.method ?? "GET",
      headers,
      body,
    });
    const raw = new Uint8Array(await res.arrayBuffer());
    const text = new TextDecoder().decode(raw);
    let parsed: unknown = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text };
    }
    const headersOut: Record<string, string | string[]> = {};
    res.headers.forEach((value, key) => {
      headersOut[key] = value;
    });
    return { status: res.status, body: parsed, headers: headersOut, raw };
  };

  return { base, close, signup, request };
}

describe("asset gateway routes", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await harness();
  });

  afterEach(async () => {
    await h.close();
  });

  it("uploads, serves and deletes an image for the caller's org", async () => {
    const owner = await h.signup("alice@example.com");

    // Upload without CSRF must 403.
    const missing = await h.request(owner.cookies, {
      method: "POST",
      path: "/api/assets",
      body: PNG_1x1,
      contentType: "image/png",
    });
    expect(missing.status).toBe(403);

    const upload = await h.request(owner.cookies, {
      method: "POST",
      path: "/api/assets",
      body: PNG_1x1,
      csrf: owner.csrf.headerValue,
    });
    expect(upload.status).toBe(201);
    expect(upload.body).toMatchObject({
      mime: "image/png",
      bytes: PNG_1x1.byteLength,
      deduped: false,
    });
    expect(String(upload.body.url)).toMatch(/^\/api\/assets\//);

    const get = await h.request(owner.cookies, {
      path: String(upload.body.url),
    });
    expect(get.status).toBe(200);
    expect(get.raw.byteLength).toBe(PNG_1x1.byteLength);
    expect(Array.from(get.raw.slice(0, 8))).toEqual(Array.from(PNG_1x1.slice(0, 8)));

    const del = await h.request(owner.cookies, {
      method: "DELETE",
      path: String(upload.body.url),
      csrf: owner.csrf.headerValue,
    });
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ ok: true });

    const after = await h.request(owner.cookies, { path: String(upload.body.url) });
    expect(after.status).toBe(404);
  });

  it("rejects bytes that do not decode to an allowed mime", async () => {
    const owner = await h.signup("bob@example.com");
    const res = await h.request(owner.cookies, {
      method: "POST",
      path: "/api/assets",
      body: NOT_AN_IMAGE,
      csrf: owner.csrf.headerValue,
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(res.body.error).toBeTruthy();
  });

  it("refuses to serve another org's asset", async () => {
    const alice = await h.signup("alice2@example.com");
    const bob = await h.signup("bob2@example.com");
    const upload = await h.request(alice.cookies, {
      method: "POST",
      path: "/api/assets",
      body: PNG_1x1,
      csrf: alice.csrf.headerValue,
    });
    expect(upload.status).toBe(201);
    const url = String(upload.body.url);
    // Bob is authenticated; the route should NOT leak Alice's bytes — either a
    // 404 (no membership) or a 404 from the tenant check is fine, the point
    // is that Bob can never read another user's asset.
    const fromBob = await h.request(bob.cookies, { path: url });
    expect(fromBob.status).toBe(404);
    // Alice can still read her own.
    const fromAlice = await h.request(alice.cookies, { path: url });
    expect(fromAlice.status).toBe(200);
  });

  it("rejects anonymous requests with 401", async () => {
    const res = await fetch(`${h.base}/api/assets`);
    expect(res.status).toBe(401);
  });
});
