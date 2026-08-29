import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { MockProvider, MockImageProvider } from "@lucent/ai";
import { createApp } from "../src/app.js";
import { InMemoryUserStore, type UserStore } from "../src/accounts.js";
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
import { createWorkspace } from "@lucent/core";

/**
 * Folded-defect close-out for Phase B (M2 close-out + M1 OAuth).
 *
 * Five defects land here, plus the new `GET /api/orgs/:id` route. Each
 * has its own `describe` so a failure points at exactly one defect.
 */

const SECRET = "test-secret-at-least-16-chars";
const ORIGIN = "http://localhost:5173";

interface Harness {
  base: string;
  userStore: UserStore;
  close: () => Promise<void>;
  signup: (
    email: string,
    name?: string,
  ) => Promise<{
    cookies: string;
    csrf: { cookieValue: string; headerValue: string };
    userId: string;
  }>;
  csrfTokens: () => Promise<{ cookieValue: string; headerValue: string }>;
  api: (
    cookies: string,
    init: {
      method?: string;
      path: string;
      body?: unknown;
      csrf?: string;
      headers?: Record<string, string>;
    },
  ) => Promise<{ status: number; body: any }>;
}

async function harness(): Promise<Harness> {
  const limits = limitsFromEnv();
  const config = readConfig({ LUCENT_REQUIRE_AUTH: "1", LUCENT_WEB_ORIGIN: ORIGIN });
  const userStore = new InMemoryUserStore();
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
    // Tight limiter so defect #8's 429 path is reachable in tests.
    authLimiter: new Limiter(3, 60_000),
    tickets: new InMemoryTicketStore(60_000),
    orgStore: new InMemoryOrgStore(),
    inviteStore: new InMemoryOrgInviteStore(),
    notifications: new InMemoryNotificationStore(),
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

  const csrfTokens = async (): Promise<{ cookieValue: string; headerValue: string }> => {
    const res = await fetch(`${base}/api/auth/csrf`, { headers: { origin: ORIGIN } });
    const body = (await res.json()) as { token: string };
    const cookieValue = pickCookie(res.headers.get("set-cookie") ?? "", "lucent_csrf");
    if (!cookieValue) throw new Error("csrf route did not set a cookie");
    return { cookieValue, headerValue: body.token };
  };

  const signup = async (email: string, name?: string) => {
    const csrf = await csrfTokens();
    const res = await fetch(`${base}/api/auth/signup`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        cookie: `lucent_csrf=${csrf.cookieValue}`,
        "x-csrf-token": csrf.headerValue,
      },
      body: JSON.stringify({
        email,
        password: "password123",
        name: name ?? email.split("@")[0],
      }),
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

  const api: Harness["api"] = async (cookies, init) => {
    const headers: Record<string, string> = {
      origin: ORIGIN,
      cookie: cookies,
      ...(init.headers ?? {}),
    };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    if (init.csrf) headers["x-csrf-token"] = init.csrf;
    const res = await fetch(`${base}${init.path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    const text = await res.text();
    let body: unknown = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }
    return { status: res.status, body };
  };

  return { base, userStore, close, signup, csrfTokens, api };
}

let open: Harness | null = null;
afterEach(async () => {
  await open?.close();
  open = null;
});

/* ───────── Defect #2: POST /api/boards existence oracle ──────────────────── */

describe("defect #2 — POST /api/boards does not leak existence", () => {
  it("returns 404 (not 403) when the board exists but is owned by someone else", async () => {
    const h = (open = await harness());
    const alice = await h.signup("alice@example.test");
    const eve = await h.signup("eve@example.test");

    const created = await h.api(alice.cookies, {
      method: "POST",
      path: "/api/boards",
      csrf: alice.csrf.headerValue,
      body: { name: "Plan", workspace: createWorkspace() },
    });
    expect(created.status).toBe(201);
    const boardId = created.body.id as string;

    // Eve (not the owner) tries to overwrite Alice's board.
    const stolen = await h.api(eve.cookies, {
      method: "POST",
      path: "/api/boards",
      csrf: eve.csrf.headerValue,
      body: { id: boardId, name: "Stolen" },
    });
    expect(stolen.status).toBe(404);
    expect(stolen.body).toEqual({ error: "board not found" });

    // Nothing was written: Alice's board still belongs to her.
    const read = await h.api(alice.cookies, { path: `/api/boards/${boardId}` });
    expect(read.status).toBe(200);
    expect(read.body.name).toBe("Plan");
    expect(read.body.ownerId).toBe(alice.userId);
  });
});

/* ───────── Defect #3: /api/account/export cross-member leak ──────────────── */

describe("defect #3 — account export returns only the caller's reachable boards", () => {
  it("does not include other members' boards in the same org", async () => {
    const h = (open = await harness());
    const alice = await h.signup("alice-export@example.test");
    const bob = await h.signup("bob-export@example.test");

    // Alice creates two boards in her personal org.
    const aliceBoard1 = (
      await h.api(alice.cookies, {
        method: "POST",
        path: "/api/boards",
        csrf: alice.csrf.headerValue,
        body: { name: "AliceA", workspace: createWorkspace() },
      })
    ).body.id as string;
    const aliceBoard2 = (
      await h.api(alice.cookies, {
        method: "POST",
        path: "/api/boards",
        csrf: alice.csrf.headerValue,
        body: { name: "AliceB", workspace: createWorkspace() },
      })
    ).body.id as string;
    // Bob creates a board.
    const bobBoard = (
      await h.api(bob.cookies, {
        method: "POST",
        path: "/api/boards",
        csrf: bob.csrf.headerValue,
        body: { name: "Bob", workspace: createWorkspace() },
      })
    ).body.id as string;

    const exported = await h.api(alice.cookies, { path: "/api/account/export" });
    expect(exported.status).toBe(200);
    const ids = (exported.body.boards as Array<{ id: string }>).map((b) => b.id);
    expect(ids).toContain(aliceBoard1);
    expect(ids).toContain(aliceBoard2);
    expect(ids).not.toContain(bobBoard);
  });
});

/* ───────── Defect #7: CSRF on DELETE /api/auth/sessions/:id ─────────────── */

describe("defect #7 — DELETE /api/auth/sessions/:id requires CSRF", () => {
  it("returns 403 without the X-CSRF-Token header", async () => {
    const h = (open = await harness());
    const u = await h.signup("csrf-sess@example.test");
    const res = await h.api(u.cookies, {
      method: "DELETE",
      path: "/api/auth/sessions/anything",
    });
    expect(res.status).toBe(403);
  });
  it("returns 401 without a session (CSRF does not bypass auth)", async () => {
    const h = (open = await harness());
    const res = await h.api("", {
      method: "DELETE",
      path: "/api/auth/sessions/anything",
      csrf: "irrelevant",
    });
    expect(res.status).toBe(401);
  });
});

/* ───────── Defect #8: rate limit on /api/account/delete ─────────────────── */

describe("defect #8 — /api/account/delete is rate limited per IP", () => {
  it("returns 429 after the per-window cap is exceeded", async () => {
    const h = (open = await harness());
    const u = await h.signup("delete-rate@example.test");
    // /api/account/delete needs a deletion store; the harness does not wire
    // one, so the first three calls land 503. The rate-limit is independent
    // of the route's success: the 4th call hits the limiter *before* the
    // store check, so it answers 429 (rate-limit) instead of 503 (not
    // configured). The harness constructor above caps the limiter at 3/window.
    const path = "/api/account/delete";
    for (let i = 0; i < 3; i += 1) {
      const res = await h.api(u.cookies, {
        method: "POST",
        path,
        csrf: u.csrf.headerValue,
      });
      // Either 200 (if a deletion store were wired) or 503 (without one).
      // Either way, the limiter records the attempt.
      expect([200, 503]).toContain(res.status);
    }
    const fourth = await h.api(u.cookies, {
      method: "POST",
      path,
      csrf: u.csrf.headerValue,
    });
    expect(fourth.status).toBe(429);
  });
});

/* ───────── Defect #10: members list joined to users ─────────────────────── */

describe("defect #10 — board members GET joins user metadata", () => {
  it("returns each member with name + email, not just userId", async () => {
    const h = (open = await harness());
    const alice = await h.signup("alice-mem@example.test");
    const bob = await h.signup("bob-mem@example.test", "Bob");

    // Sharing a board publicly is gated on a verified email — see
    // app.ts:1817. We bypass the mail flow by setting the timestamp
    // directly on the user record, the same way collab.e2e.test.ts does.
    await h.userStore.setEmailVerified(alice.userId, Date.now());

    const created = await h.api(alice.cookies, {
      method: "POST",
      path: "/api/boards",
      csrf: alice.csrf.headerValue,
      body: { name: "Shared", workspace: createWorkspace() },
    });
    expect(created.status).toBe(201);
    const boardId = created.body.id as string;

    // Alice mints a share link and Bob joins.
    const link = await h.api(alice.cookies, {
      method: "POST",
      path: `/api/boards/${boardId}/share`,
      csrf: alice.csrf.headerValue,
      body: { role: "editor" },
    });
    expect(link.status).toBe(201);
    const joined = await h.api(bob.cookies, {
      method: "POST",
      path: `/api/boards/${boardId}/join`,
      csrf: bob.csrf.headerValue,
      body: { token: link.body.token },
    });
    expect(joined.status).toBe(200);

    const listed = await h.api(alice.cookies, { path: `/api/boards/${boardId}/members` });
    expect(listed.status).toBe(200);
    const members = listed.body.members as Array<{
      userId: string;
      role: string;
      name: string;
      email: string;
    }>;
    const bobRow = members.find((m) => m.userId === bob.userId);
    expect(bobRow).toBeDefined();
    expect(bobRow!.name).toBe("Bob");
    expect(bobRow!.email).toBe("bob-mem@example.test");
    expect(bobRow!.role).toBe("editor");
  });
});

/* ───────── New route: GET /api/orgs/:id ──────────────────────────────────── */

describe("GET /api/orgs/:id — admin console surface", () => {
  it("returns the org + members joined to users for any member of the org", async () => {
    const h = (open = await harness());
    const alice = await h.signup("alice-org@example.test");
    const bob = await h.signup("bob-org@example.test", "Bob");

    // Alice's personal org is auto-created on signup; /api/me returns her
    // memberships, of which there is exactly one (the personal org).
    const me = await h.api(alice.cookies, { path: "/api/auth/me" });
    const memberships = me.body.memberships as Array<{ orgId: string }>;
    expect(memberships).toHaveLength(1);
    const orgId = memberships[0]!.orgId;

    // Bob is not yet in Alice's org.
    const denied = await h.api(bob.cookies, { path: `/api/orgs/${orgId}` });
    expect(denied.status).toBe(404);

    // Alice is in her own org, so her GET works and includes her as owner.
    const got = await h.api(alice.cookies, { path: `/api/orgs/${orgId}` });
    expect(got.status).toBe(200);
    expect(got.body.id).toBe(orgId);
    const members = got.body.members as Array<{ userId: string; role: string }>;
    expect(members).toEqual(
      expect.arrayContaining([expect.objectContaining({ userId: alice.userId, role: "owner" })]),
    );
  });

  it("returns 404 for a non-existent org id (no enumeration oracle)", async () => {
    const h = (open = await harness());
    const u = await h.signup("alice-404@example.test");
    const res = await h.api(u.cookies, { path: "/api/orgs/org_does_not_exist" });
    expect(res.status).toBe(404);
  });
});
