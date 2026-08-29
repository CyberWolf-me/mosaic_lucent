import { describe, it, expect } from "vitest";
import {
  InMemorySessionStore,
  InMemoryUserStore,
  handleListSessions,
  handleLogin,
  handleLogout,
  handleRevokeSession,
  handleSignup,
  handleSignoutAll,
  type AuthContext,
} from "../src/accounts.js";
import { clearCookie, getCookie, parseCookies, serializeCookie } from "../src/cookies.js";
import { authenticate } from "../src/accounts.js";

/**
 * Sessions (M1). Cookie auth replaces the old HMAC-bearer path for browsers;
 * the bearer path stays for programmatic clients. The contract under test:
 *   - signup/login mint a session and return its id in Set-Cookie.
 *   - authenticate reads the cookie first, bearer second.
 *   - "Sign out everywhere" bumps tokenVersion so even an un-revoked session
 *     becomes invalid at the next request.
 *   - the device list reflects live sessions, marks the current one, and
 *     revocations clear the cookie when the current session is the target.
 */

const SECRET = "test-secret-at-least-16-chars";

function ctx(store: InMemoryUserStore, sessionStore?: InMemorySessionStore): AuthContext {
  return {
    userStore: store,
    secret: SECRET,
    ...(sessionStore
      ? {
          sessionStore,
          sessionCookie: {
            name: "lucent_session",
            cookieOptions: {
              httpOnly: true,
              sameSite: "Lax" as const,
              secure: false,
              path: "/",
              maxAgeMs: 60_000,
            },
          },
        }
      : {}),
  };
}

function setCookieValue(setCookie: string | undefined): string {
  if (!setCookie) throw new Error("expected a Set-Cookie header");
  const semi = setCookie.indexOf(";");
  const pair = semi === -1 ? setCookie : setCookie.slice(0, semi);
  const eq = pair.indexOf("=");
  if (eq === -1) throw new Error(`malformed cookie: ${setCookie}`);
  return pair.slice(eq + 1);
}

describe("sessions: cookie shape", () => {
  it("serializes an httpOnly + Lax + Max-Age cookie", () => {
    const header = serializeCookie("lucent_session", "abc123", {
      httpOnly: true,
      sameSite: "Lax",
      secure: false,
      path: "/",
      maxAgeMs: 60_000,
    });
    expect(header).toContain("lucent_session=abc123");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Path=/");
    expect(header).toContain("Max-Age=60");
    // No Secure flag in dev (http origin).
    expect(header).not.toContain("Secure");
  });

  it("parseCookies extracts the value behind the requested name", () => {
    const cookies = parseCookies("a=1; lucent_session=deadbeef; b=2");
    expect(getCookie(cookies, "lucent_session")).toBe("deadbeef");
    expect(getCookie(cookies, "missing")).toBeUndefined();
  });

  it("clearCookie emits a Max-Age=0 header that drops the browser copy", () => {
    const header = clearCookie("lucent_session");
    expect(header).toContain("lucent_session=");
    expect(header).toContain("Max-Age=0");
  });

  it("refuses a cookie name with forbidden characters", () => {
    expect(() => serializeCookie("bad name", "x")).toThrow(/invalid cookie name/);
  });
});

describe("sessions: signup and login mint a session", () => {
  it("signup returns a Set-Cookie and the body carries the same id", async () => {
    const store = new InMemoryUserStore();
    const sessions = new InMemorySessionStore();
    const result = await handleSignup(ctx(store, sessions), {
      email: "ana@example.com",
      password: "password123",
      name: "Ana",
    });
    expect(result.status).toBe(201);
    const cookie = setCookieValue(result.headers?.["set-cookie"]);
    expect(cookie).toMatch(/^[0-9a-f]{64}$/);
    const body = result.body as { sessionId: string };
    expect(body.sessionId).toBe(cookie);
    // The session is now findable in the store.
    const found = await sessions.find(cookie, Date.now());
    expect(found?.userId).toBeDefined();
  });

  it("login returns the same shape", async () => {
    const store = new InMemoryUserStore();
    const sessions = new InMemorySessionStore();
    await handleSignup(ctx(store, sessions), {
      email: "b@example.com",
      password: "password123",
      name: "B",
    });
    const result = await handleLogin(ctx(store, sessions), {
      email: "b@example.com",
      password: "password123",
    });
    expect(result.status).toBe(200);
    expect(result.headers?.["set-cookie"]).toBeDefined();
  });
});

describe("sessions: authenticate reads cookie first, then bearer", () => {
  it("resolves a user from a valid session cookie", async () => {
    const store = new InMemoryUserStore();
    const sessions = new InMemorySessionStore();
    const c = ctx(store, sessions);
    const signup = await handleSignup(c, {
      email: "c@example.com",
      password: "password123",
      name: "C",
    });
    const cookie = setCookieValue(signup.headers?.["set-cookie"]);
    const user = await authenticate(c, `lucent_session=${cookie}`, null);
    expect(user?.email).toBe("c@example.com");
  });

  it("falls back to bearer when no cookie is present", async () => {
    const store = new InMemoryUserStore();
    const sessions = new InMemorySessionStore();
    const c = ctx(store, sessions);
    const signup = await handleSignup(c, {
      email: "d@example.com",
      password: "password123",
      name: "D",
    });
    const body = signup.body as { token: string };
    const user = await authenticate(c, null, body.token);
    expect(user?.email).toBe("d@example.com");
  });

  it("rejects a revoked session even if the cookie still arrives", async () => {
    const store = new InMemoryUserStore();
    const sessions = new InMemorySessionStore();
    const c = ctx(store, sessions);
    const signup = await handleSignup(c, {
      email: "e@example.com",
      password: "password123",
      name: "E",
    });
    const cookie = setCookieValue(signup.headers?.["set-cookie"]);
    await sessions.revoke(cookie, Date.now());
    const user = await authenticate(c, `lucent_session=${cookie}`, null);
    expect(user).toBeUndefined();
  });

  it("rejects a session whose tokenVersion is below the user's current value", async () => {
    const store = new InMemoryUserStore();
    const sessions = new InMemorySessionStore();
    const c = ctx(store, sessions);
    const signup = await handleSignup(c, {
      email: "f@example.com",
      password: "password123",
      name: "F",
    });
    const cookie = setCookieValue(signup.headers?.["set-cookie"]);
    // Simulate "Sign out everywhere": bump version. The session row stays,
    // but the stamped tokenVersion is now stale.
    await store.bumpTokenVersion((signup.body as { user: { id: string } }).user.id, Date.now());
    const user = await authenticate(c, `lucent_session=${cookie}`, null);
    expect(user).toBeUndefined();
    // And the stale row is best-effort cleaned up.
    const found = await sessions.find(cookie, Date.now());
    expect(found).toBeUndefined();
  });
});

describe("sessions: device list, revoke, sign-out", () => {
  it("lists live sessions and marks the current one", async () => {
    const store = new InMemoryUserStore();
    const sessions = new InMemorySessionStore();
    const c = ctx(store, sessions);
    const signup = await handleSignup(c, {
      email: "g@example.com",
      password: "password123",
      name: "G",
    });
    const cookie = setCookieValue(signup.headers?.["set-cookie"]);

    const result = await handleListSessions(c, `lucent_session=${cookie}`, null);
    expect(result.status).toBe(200);
    const body = result.body as { sessions: Array<{ id: string; current: boolean }> };
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]?.current).toBe(true);
  });

  it("revokes a single non-current session by id", async () => {
    const store = new InMemoryUserStore();
    const sessions = new InMemorySessionStore();
    const c = ctx(store, sessions);
    const signup = await handleSignup(c, {
      email: "h@example.com",
      password: "password123",
      name: "H",
    });
    const cookieA = setCookieValue(signup.headers?.["set-cookie"]);
    // Mint a second session for the same user (e.g. a second browser).
    const user = await store.findByEmail("h@example.com");
    expect(user).toBeDefined();
    const second = await sessions.create({
      userId: user!.id,
      tokenVersion: user!.tokenVersion,
      now: Date.now(),
    });
    const cookieB = second.id;

    // Revoke B from the context of A's cookie.
    const result = await handleRevokeSession(c, cookieB, `lucent_session=${cookieA}`, null);
    expect(result.status).toBe(204);
    // B is gone; A is still there.
    expect(await sessions.find(cookieA, Date.now())).toBeDefined();
    expect(await sessions.find(cookieB, Date.now())).toBeUndefined();
    // The response did NOT clear the cookie because the revoked one wasn't
    // the current one.
    expect(result.headers?.["set-cookie"]).toBeUndefined();
  });

  it("revoking the current session clears the cookie", async () => {
    const store = new InMemoryUserStore();
    const sessions = new InMemorySessionStore();
    const c = ctx(store, sessions);
    const signup = await handleSignup(c, {
      email: "i@example.com",
      password: "password123",
      name: "I",
    });
    const cookie = setCookieValue(signup.headers?.["set-cookie"]);
    const result = await handleRevokeSession(c, cookie, `lucent_session=${cookie}`, null);
    expect(result.status).toBe(204);
    expect(result.headers?.["set-cookie"]).toContain("Max-Age=0");
  });

  it("refuses to revoke a session that isn't the caller's", async () => {
    const store = new InMemoryUserStore();
    const sessions = new InMemorySessionStore();
    const c = ctx(store, sessions);
    await handleSignup(c, { email: "j@example.com", password: "password123", name: "J" });
    const result = await handleRevokeSession(c, "not_a_real_session_id", null, null);
    // The auth path runs first; the revoke never happens.
    expect(result.status).toBe(401);
  });

  it("logout clears the cookie but is idempotent on a missing session", async () => {
    const store = new InMemoryUserStore();
    const sessions = new InMemorySessionStore();
    const c = ctx(store, sessions);
    const result = await handleLogout(c, null);
    expect(result.status).toBe(204);
    expect(result.headers?.["set-cookie"]).toContain("Max-Age=0");
  });

  it("signout-all bumps tokenVersion and revokes every session", async () => {
    const store = new InMemoryUserStore();
    const sessions = new InMemorySessionStore();
    const c = ctx(store, sessions);
    const signup = await handleSignup(c, {
      email: "k@example.com",
      password: "password123",
      name: "K",
    });
    const cookie = setCookieValue(signup.headers?.["set-cookie"]);
    // Mint a second session for the same user.
    const user = (signup.body as { user: { id: string } }).user;
    await sessions.create({ userId: user.id, tokenVersion: 0, now: Date.now() });

    const result = await handleSignoutAll(c, `lucent_session=${cookie}`, null);
    expect(result.status).toBe(200);
    expect((result.body as { revoked: number }).revoked).toBe(2);

    // Cookie clearing + invalidation: the cookie arrives but authenticate
    // rejects because the live session was revoked.
    const stillAuthed = await authenticate(c, `lucent_session=${cookie}`, null);
    expect(stillAuthed).toBeUndefined();
  });
});

describe("sessions: in-memory store properties", () => {
  it("expires rows past their ttl", async () => {
    const store = new InMemorySessionStore();
    const session = await store.create({
      userId: "u",
      tokenVersion: 0,
      now: 1000,
      ttlMs: 100,
    });
    expect(await store.find(session.id, 1050)).toBeDefined();
    expect(await store.find(session.id, 1101)).toBeUndefined();
  });

  it("revokeAllForUser only touches the requested user's sessions", async () => {
    const store = new InMemorySessionStore();
    const a = await store.create({ userId: "u1", tokenVersion: 0, now: Date.now() });
    const b = await store.create({ userId: "u2", tokenVersion: 0, now: Date.now() });
    expect(await store.revokeAllForUser("u1", Date.now())).toBe(1);
    expect(await store.find(a.id, Date.now())).toBeUndefined();
    expect(await store.find(b.id, Date.now())).toBeDefined();
  });

  it("listForUser excludes revoked sessions", async () => {
    const store = new InMemorySessionStore();
    const a = await store.create({ userId: "u", tokenVersion: 0, now: Date.now() });
    await store.create({ userId: "u", tokenVersion: 0, now: Date.now() });
    await store.revoke(a.id, Date.now());
    const list = await store.listForUser("u");
    expect(list).toHaveLength(1);
  });
});
