import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
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
import { MockProvider, MockImageProvider } from "@lucent/ai";
import {
  mintOauthState,
  verifyOauthState,
  resolveOauthUser,
  type OauthProfile,
} from "../src/oauth.js";

/**
 * M1.8: federated sign-in. The state protocol is tested pure, the flow end
 * to end over the real routes with a stubbed network — the token exchange
 * and profile fetch are the only outbound calls, and `exchangeCodeForProfile`
 * defaults to global `fetch`, which the route tests temporarily replace.
 */

const ORIGIN = "http://localhost:5173";
const SECRET = "test-secret-at-least-16-chars";

describe("oauth state", () => {
  it("mints and verifies a state for its provider", () => {
    const state = mintOauthState(SECRET, "google", 1000);
    expect(verifyOauthState(SECRET, "google", state, 2000)).toEqual({ ok: true });
  });

  it("rejects another provider's state, a forged one, and a stale one", () => {
    const state = mintOauthState(SECRET, "google", 1000);
    expect(verifyOauthState(SECRET, "github", state, 2000)).toMatchObject({
      ok: false,
      reason: "provider_mismatch",
    });
    // Tamper with the payload: signature no longer matches.
    const [body, sig] = state.split(".");
    const forged = `${`${body!["slice"] ? body : body}`.slice(0, -2)}xy.${sig}`;
    expect(verifyOauthState(SECRET, "google", forged, 2000)).toMatchObject({
      ok: false,
      reason: "bad_signature",
    });
    // A different secret minted it: bad signature, not expired.
    expect(verifyOauthState("another-secret-at-least-16c", "google", state, 2000)).toMatchObject({
      ok: false,
      reason: "bad_signature",
    });
    expect(verifyOauthState(SECRET, "google", state, 1000 + 10 * 60_000 + 1)).toMatchObject({
      ok: false,
      reason: "expired",
    });
    expect(verifyOauthState(SECRET, "google", "not-a-state", 2000)).toMatchObject({
      ok: false,
      reason: "malformed",
    });
  });

  it("states are unique per flow", () => {
    expect(mintOauthState(SECRET, "google", 1000)).not.toBe(mintOauthState(SECRET, "google", 1000));
  });
});

describe("resolveOauthUser", () => {
  const users = new InMemoryUserStore();
  const profile: OauthProfile = {
    providerAccountId: "sub-1",
    email: "NEW@Example.com",
    emailVerified: true,
    name: "New User",
  };

  it("creates an account, verified, with a personal org and an unusable password", async () => {
    const result = await resolveOauthUser({ userStore: users }, "google", profile, 1000);
    if (result.kind !== "user") throw new Error(`expected user, got ${JSON.stringify(result)}`);
    expect(result.linked).toBe("new");
    const user = result.user;
    expect(user.email).toBe("new@example.com");
    expect(user.emailVerifiedAt).toBe(1000);
    // `oauth:` hashes are rejected by verifyPassword's shape check, so these
    // accounts have no password until a reset mints one.
    expect(user.passwordHash.startsWith("oauth:")).toBe(true);
    const orgs = await users.listOrgsForUser(user.id);
    expect(orgs).toHaveLength(1);
    expect(orgs[0]!.role).toBe("owner");
  });

  it("signs the same identity in as the same user on the second login", async () => {
    const first = await resolveOauthUser({ userStore: users }, "google", profile, 1000);
    const second = await resolveOauthUser({ userStore: users }, "google", profile, 2000);
    if (first.kind !== "user" || second.kind !== "user") throw new Error("expected users");
    expect(second.user.id).toBe(first.user.id);
    expect(second.linked).toBe("existing");
  });

  it("links a verified email to the account that already owns it", async () => {
    const users = new InMemoryUserStore();
    await users.insert({
      id: "usr_human",
      email: "ana@example.com",
      name: "Ana",
      createdAt: 0,
      passwordHash: "0:0",
      tokenVersion: 0,
      emailVerifiedAt: 0,
    });
    const result = await resolveOauthUser(
      { userStore: users },
      "github",
      { providerAccountId: "gh-1", email: "ana@example.com", emailVerified: true, name: "Ana G" },
      1000,
    );
    if (result.kind !== "user") throw new Error("expected user");
    expect(result.user.id).toBe("usr_human");
    expect(result.linked).toBe("fresh-identity");
    // And the identity is now on file: next login skips the email lookup.
    const again = await resolveOauthUser(
      { userStore: users },
      "github",
      { providerAccountId: "gh-1", email: null, emailVerified: false, name: null },
      2000,
    );
    if (again.kind !== "user") throw new Error("expected user");
    expect(again.user.id).toBe("usr_human");
  });

  it("refuses an unverified email entirely", async () => {
    const users = new InMemoryUserStore();
    const before = await users.findByEmail("mallory@example.com");
    const result = await resolveOauthUser(
      { userStore: users },
      "google",
      {
        providerAccountId: "sub-evil",
        email: "mallory@example.com",
        emailVerified: false,
        name: "M",
      },
      1000,
    );
    expect(result).toMatchObject({ kind: "error" });
    expect(await users.findByEmail("mallory@example.com")).toBe(before);
  });
});

/* ------------------------------ route tests ------------------------------- */

interface Harness {
  base: string;
  userStore: InMemoryUserStore;
  close: () => Promise<void>;
}

async function harness(oauthEnv: Record<string, string> = {}): Promise<Harness> {
  const config = readConfig({
    LUCENT_REQUIRE_AUTH: "1",
    LUCENT_WEB_ORIGIN: ORIGIN,
    ...oauthEnv,
  });
  const userStore = new InMemoryUserStore();
  const { server, close } = createApp({
    config,
    provider: new MockProvider(),
    imageProvider: new MockImageProvider(),
    userStore,
    boardStore: new InMemoryBoardStore(),
    sessionStore: new InMemorySessionStore(),
    secret: SECRET,
    usage: new UsageTracker(limitsFromEnv()),
    limits: limitsFromEnv(),
    telemetry: new Telemetry(),
    authLimiter: new Limiter(50, 60_000),
    tickets: new InMemoryTicketStore(60_000),
    orgStore: new InMemoryOrgStore(),
    inviteStore: new InMemoryOrgInviteStore(),
    notifications: new InMemoryNotificationStore(),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, userStore, close };
}

const GOOGLE_ENV = {
  LUCENT_OAUTH_GOOGLE_CLIENT_ID: "google-client-id",
  LUCENT_OAUTH_GOOGLE_CLIENT_SECRET: "google-secret",
};

describe("oauth HTTP routes", () => {
  const fetchStubs: Array<() => void> = [];
  afterEach(() => {
    for (const restore of fetchStubs.splice(0)) restore();
  });

  /**
   * Replace fetch for the PROVIDER endpoints only. The app runs in-process,
   * so a blanket stub would answer the test's own requests to `h.base` —
   * those pass through to the real fetch.
   */
  function stubFetch(base: string, handler: (url: string) => unknown | Promise<unknown>) {
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      const target = String(url);
      if (target.startsWith(base) || target.startsWith("/")) {
        return original(target, init);
      }
      const body = await handler(target);
      if (body instanceof Response) return body;
      return new Response(JSON.stringify(body ?? {}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    fetchStubs.push(() => {
      globalThis.fetch = original;
    });
  }

  it("the csrf response names the configured providers", async () => {
    const h = await harness(GOOGLE_ENV);
    try {
      const res = await fetch(`${h.base}/api/auth/csrf`, { headers: { origin: ORIGIN } });
      const body = (await res.json()) as { oauth?: Record<string, boolean> };
      expect(body.oauth).toEqual({ google: true, github: false });
    } finally {
      await h.close();
    }
  });

  it("start redirects to the provider with a state cookie; unknown/unconfigured 4xx/5xx", async () => {
    const h = await harness(GOOGLE_ENV);
    try {
      const res = await fetch(`${h.base}/api/auth/oauth/google/start`, { redirect: "manual" });
      expect(res.status).toBe(302);
      const location = res.headers.get("location")!;
      expect(location).toContain("accounts.google.com");
      expect(location).toContain("client_id=google-client-id");
      expect(location).toContain(
        "redirect_uri=" + encodeURIComponent(`${ORIGIN}/api/auth/oauth/google/callback`),
      );
      expect(location).toContain("prompt=select_account");
      const cookie = res.headers.get("set-cookie")!;
      expect(cookie).toContain("lucent_oauth=");
      expect(cookie).toContain("HttpOnly");

      const unknown = await fetch(`${h.base}/api/auth/oauth/myspace/start`, { redirect: "manual" });
      expect(unknown.status).toBe(404);
    } finally {
      await h.close();
    }

    const bare = await harness();
    try {
      const res = await fetch(`${bare.base}/api/auth/oauth/google/start`, { redirect: "manual" });
      expect(res.status).toBe(503);
    } finally {
      await bare.close();
    }
  });

  it("callback: creates the user, mints a session, and lands on the app", async () => {
    const h = await harness(GOOGLE_ENV);
    try {
      // Start the flow to obtain a legitimate state + its cookie.
      const start = await fetch(`${h.base}/api/auth/oauth/google/start`, { redirect: "manual" });
      const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
      const stateCookie = start.headers.get("set-cookie")!.split(";")[0]!;

      stubFetch(h.base, (url) => {
        if (url.includes("oauth2.googleapis.com/token")) {
          return { access_token: "at-1" };
        }
        if (url.includes("openidconnect.googleapis.com/v1/userinfo")) {
          return {
            sub: "sub-route-1",
            email: "ROUTE@Example.com",
            email_verified: true,
            name: "Route User",
          };
        }
        return {};
      });

      const callback = await fetch(
        `${h.base}/api/auth/oauth/google/callback?code=abc&state=${encodeURIComponent(state)}`,
        { redirect: "manual", headers: { cookie: stateCookie } },
      );
      expect(callback.status).toBe(302);
      expect(callback.headers.get("location")).toBe(`${ORIGIN}/?auth=oauth`);
      const cookies = callback.headers.getSetCookie();
      expect(cookies.some((c) => c.startsWith("lucent_session="))).toBe(true);

      const user = await h.userStore.findByEmail("route@example.com");
      expect(user).toBeTruthy();
      expect(user!.emailVerifiedAt).not.toBeNull();
    } finally {
      await h.close();
    }
  });

  it("callback refuses a state that does not match the browser's cookie", async () => {
    const h = await harness(GOOGLE_ENV);
    try {
      const start = await fetch(`${h.base}/api/auth/oauth/google/start`, { redirect: "manual" });
      const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
      // A different browser's state cookie: the flow was started elsewhere.
      const otherState = mintOauthState(SECRET, "google", Date.now());
      const res = await fetch(
        `${h.base}/api/auth/oauth/google/callback?code=abc&state=${encodeURIComponent(state)}`,
        {
          redirect: "manual",
          headers: { cookie: `lucent_oauth=${encodeURIComponent(otherState)}` },
        },
      );
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("oauth_error=state_mismatch");
    } finally {
      await h.close();
    }
  });

  it("callback redirects with an error when the exchange fails", async () => {
    const h = await harness(GOOGLE_ENV);
    try {
      const start = await fetch(`${h.base}/api/auth/oauth/google/start`, { redirect: "manual" });
      const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
      const stateCookie = start.headers.get("set-cookie")!.split(";")[0]!;

      // Token endpoint refuses: the user sees a redirect, not a 500 JSON page.
      stubFetch(h.base, (url) => {
        if (url.includes("oauth2.googleapis.com/token")) {
          return new Response("denied", { status: 400 });
        }
        return {};
      });

      const res = await fetch(
        `${h.base}/api/auth/oauth/google/callback?code=abc&state=${encodeURIComponent(state)}`,
        { redirect: "manual", headers: { cookie: stateCookie } },
      );
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("oauth_error=exchange_failed");
      expect(await h.userStore.findByEmail("route@example.com")).toBeUndefined();
    } finally {
      await h.close();
    }
  });

  it("callback handles a provider-side denial (no code)", async () => {
    const h = await harness(GOOGLE_ENV);
    try {
      const start = await fetch(`${h.base}/api/auth/oauth/google/start`, { redirect: "manual" });
      const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
      const stateCookie = start.headers.get("set-cookie")!.split(";")[0]!;
      const res = await fetch(
        `${h.base}/api/auth/oauth/google/callback?error=access_denied&state=${encodeURIComponent(state)}`,
        { redirect: "manual", headers: { cookie: stateCookie } },
      );
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("oauth_error=provider_denied");
    } finally {
      await h.close();
    }
  });
});
