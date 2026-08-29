import { afterEach, describe, expect, it } from "vitest";
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
import { InMemoryOrgStore } from "../src/orgs.js";
import { InMemoryUsageStore } from "../src/usageStore.js";

/**
 * Analytics trend endpoint test (M7).
 *
 * The dashboard reads `GET /api/analytics/:orgId/trend?kind=…&days=…` to
 * drive the per-kind sparkline. This test pins the wire contract: the
 * endpoint is owner-gated, validates `kind`, and returns one row per day
 * in the window — both as the dashboard expects.
 */

const SECRET = "test-secret-at-least-16-chars";
const ORIGIN = "http://localhost:5173";

interface Harness {
  base: string;
  close: () => Promise<void>;
  signup: (email: string) => Promise<{
    cookies: string;
    csrf: { cookieValue: string; headerValue: string };
    userId: string;
    orgId: string;
  }>;
  request: (
    cookies: string,
    init: { method?: string; path: string; csrf?: string },
  ) => Promise<{ status: number; body: any }>;
}

async function harness(): Promise<Harness> {
  const limits = limitsFromEnv();
  const config = readConfig({ LUCENT_REQUIRE_AUTH: "1", LUCENT_WEB_ORIGIN: ORIGIN });
  const userStore = new InMemoryUserStore();
  const orgStore = new InMemoryOrgStore();
  orgStore.userFinder = (id: string) => userStore.findById(id);
  const usageStore = new InMemoryUsageStore();
  const { server, close } = createApp({
    config,
    provider: new MockProvider(),
    imageProvider: new MockImageProvider(),
    userStore,
    boardStore: new InMemoryBoardStore(),
    secret: SECRET,
    usage: new UsageTracker(limits),
    limits,
    telemetry: new Telemetry(),
    authLimiter: new Limiter(1000, 60_000),
    tickets: new InMemoryTicketStore(60_000),
    sessionStore: new InMemorySessionStore(),
    orgStore,
    usageStore,
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

  async function signup(email: string) {
    const csrf = await csrfTokens();
    const res = await fetch(`${base}/api/auth/signup`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        cookie: `lucent_csrf=${csrf.cookieValue}`,
        "x-csrf-token": csrf.headerValue,
      },
      body: JSON.stringify({ email, password: "password123", name: email.split("@")[0] }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      user: { id: string };
      memberships: Array<{ orgId: string }>;
    };
    const sessionCookie = pickCookie(res.headers.get("set-cookie") ?? "", "lucent_session");
    if (!sessionCookie) throw new Error("signup did not set a session cookie");
    return {
      cookies: `lucent_session=${sessionCookie}; lucent_csrf=${csrf.cookieValue}`,
      csrf,
      userId: body.user.id,
      orgId: body.memberships[0]!.orgId,
    };
  }

  async function request(cookies: string, init: { method?: string; path: string; csrf?: string }) {
    const headers: Record<string, string> = { origin: ORIGIN, cookie: cookies };
    if (init.csrf) headers["x-csrf-token"] = init.csrf;
    const res = await fetch(`${base}${init.path}`, { method: init.method ?? "GET", headers });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  return { base, close, signup, request };
}

describe("analytics trend endpoint (M7)", () => {
  let h: Harness;

  afterEach(async () => {
    if (h) await h.close();
  });

  it("returns an empty list when no events have been recorded", async () => {
    h = await harness();
    const owner = await h.signup("alice@example.com");
    const res = await h.request(owner.cookies, {
      path: `/api/analytics/${owner.orgId}/trend?kind=ai.generationsPerMonth&days=30`,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ rows: [] });
  });

  it("rejects an empty `kind`", async () => {
    h = await harness();
    const owner = await h.signup("bob@example.com");
    const res = await h.request(owner.cookies, {
      path: `/api/analytics/${owner.orgId}/trend?days=30`,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/kind/i);
  });

  it("requires owner role", async () => {
    h = await harness();
    const a = await h.signup("a@example.com");
    const b = await h.signup("b@example.com");
    // `b` signed up as the owner of their own personal org; they are not a
    // member of `a`'s. The endpoint must answer 404 (the same masking the
    // rest of the org surface uses), not 200 or 403.
    const res = await h.request(b.cookies, {
      path: `/api/analytics/${a.orgId}/trend?kind=ai.generationsPerMonth&days=30`,
    });
    expect(res.status).toBe(404);
  });
});
