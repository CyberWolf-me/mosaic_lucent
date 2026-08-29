import { afterEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import { MockProvider, MockImageProvider } from "@lucent/ai";
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
import { createWorkspace } from "@lucent/core";
import type { MailMessage, Mailer } from "../src/email/index.js";

/**
 * Request provenance and the mail path.
 *
 * Four defects that all live at the same seam -- what the server records about
 * the request in front of it, and what it puts in the recipient's inbox:
 *
 *   1. The two mail-sending auth routes were unmetered, so either was a free
 *      mail cannon aimed at any address the caller typed.
 *   2. Sessions were minted with no device and no address, leaving the
 *      account-settings session list unable to do the one job it has.
 *   3. Audit rows recorded `clientKey(req)` as `ip`, which for a bearer client
 *      is `usr:<id>` -- the actor id a second time, and no address at all.
 *   4. The org invite mail was hand-rolled, text-only and anonymous, and a
 *      failed send answered 400 *after* committing the invite.
 */

const SECRET = "test-secret-at-least-16-chars";
const ORIGIN = "http://localhost:5173";
const UA = "Mozilla/5.0 (Windows NT 10.0) TestAgent/1.2";

interface Harness {
  sent: MailMessage[];
  close: () => Promise<void>;
  signup: (
    email: string,
    opts?: { name?: string; userAgent?: string },
  ) => Promise<{
    cookies: string;
    csrf: { cookieValue: string; headerValue: string };
    userId: string;
    token: string;
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
  post: (
    path: string,
    body: unknown,
    headers?: Record<string, string>,
  ) => Promise<{ status: number; body: any; retryAfter: string | null }>;
}

async function harness(opts: { mailer?: Mailer; perWindow?: number } = {}): Promise<Harness> {
  const limits = limitsFromEnv();
  const config = readConfig({ LUCENT_REQUIRE_AUTH: "1", LUCENT_WEB_ORIGIN: ORIGIN });
  const sent: MailMessage[] = [];
  const mailer: Mailer = opts.mailer ?? {
    send: async (msg) => {
      sent.push(msg);
    },
  };
  const { server, close } = createApp({
    config,
    provider: new MockProvider(),
    imageProvider: new MockImageProvider(),
    userStore: new InMemoryUserStore(),
    boardStore: new InMemoryBoardStore(),
    sessionStore: new InMemorySessionStore(),
    secret: SECRET,
    usage: new UsageTracker(limits),
    limits,
    telemetry: new Telemetry(),
    // Small enough that the throttles are reachable in a test, large enough
    // that a signup plus a couple of calls still fits.
    authLimiter: new Limiter(opts.perWindow ?? 3, 60_000),
    tickets: new InMemoryTicketStore(60_000),
    orgStore: new InMemoryOrgStore(),
    inviteStore: new InMemoryOrgInviteStore(),
    notifications: new InMemoryNotificationStore(),
    mailer,
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

  const csrfTokens = async () => {
    const res = await fetch(`${base}/api/auth/csrf`, { headers: { origin: ORIGIN } });
    const body = (await res.json()) as { token: string };
    const cookieValue = pickCookie(res.headers.get("set-cookie") ?? "", "lucent_csrf");
    if (!cookieValue) throw new Error("csrf route did not set a cookie");
    return { cookieValue, headerValue: body.token };
  };

  const signup: Harness["signup"] = async (email, o = {}) => {
    const csrf = await csrfTokens();
    const res = await fetch(`${base}/api/auth/signup`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        cookie: `lucent_csrf=${csrf.cookieValue}`,
        "x-csrf-token": csrf.headerValue,
        ...(o.userAgent ? { "user-agent": o.userAgent } : {}),
      },
      body: JSON.stringify({
        email,
        password: "password123",
        name: o.name ?? email.split("@")[0],
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { user: { id: string }; token: string };
    const sessionCookie = pickCookie(res.headers.get("set-cookie") ?? "", "lucent_session");
    if (!sessionCookie) throw new Error("signup did not set a session cookie");
    return {
      cookies: `lucent_session=${sessionCookie}; lucent_csrf=${csrf.cookieValue}`,
      csrf,
      userId: body.user.id,
      token: body.token,
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

  // Unauthenticated POST -- the shape the mail-request routes are called with.
  const post: Harness["post"] = async (path, body, headers = {}) => {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text };
    }
    return { status: res.status, body: parsed, retryAfter: res.headers.get("retry-after") };
  };

  return { sent, close, signup, csrfTokens, api, post };
}

let open: Harness | null = null;
afterEach(async () => {
  await open?.close();
  open = null;
});

describe("mail-request throttling", () => {
  it("caps repeated requests for one address", async () => {
    const h = (open = await harness());
    // Three fit the window; the fourth is the same mailbox being buried.
    for (let i = 0; i < 3; i += 1) {
      const res = await h.post("/api/auth/reset/request", { email: "victim@example.com" });
      expect(res.status).toBe(204);
    }
    const refused = await h.post("/api/auth/reset/request", { email: "victim@example.com" });
    expect(refused.status).toBe(429);
    expect(refused.body.error).toBe("too many attempts");
    // The header, not just the field: a client that backs off reads this one.
    expect(refused.retryAfter).toBeTruthy();
    expect(Number(refused.retryAfter)).toBeGreaterThan(0);
  });

  it("caps one host walking a list of addresses", async () => {
    const h = (open = await harness());
    // Two per address stays under the per-address cap of three, so anything
    // refused here can only have come from the shared per-IP bucket -- which is
    // the bucket the address bucket cannot see, and the whole reason it exists.
    expect((await h.post("/api/auth/reset/request", { email: "a@example.com" })).status).toBe(204);
    expect((await h.post("/api/auth/reset/request", { email: "a@example.com" })).status).toBe(204);
    expect((await h.post("/api/auth/reset/request", { email: "b@example.com" })).status).toBe(204);
    const refused = await h.post("/api/auth/reset/request", { email: "b@example.com" });
    expect(refused.status).toBe(429);
  });

  it("counts verification and reset mail in the same buckets", async () => {
    const h = (open = await harness());
    expect((await h.post("/api/auth/verify/request", { email: "c@example.com" })).status).toBe(204);
    expect((await h.post("/api/auth/verify/request", { email: "c@example.com" })).status).toBe(204);
    expect((await h.post("/api/auth/reset/request", { email: "c@example.com" })).status).toBe(204);
    // Four mails to one address, whichever route asked for them.
    expect((await h.post("/api/auth/reset/request", { email: "c@example.com" })).status).toBe(429);
  });

  it("does not spend the login bucket", async () => {
    const h = (open = await harness());
    // A user fat-fingering their password is the user most likely to need a
    // reset link in the next ten seconds. Sharing `applyAuthLimiter`'s bucket
    // would make failed logins swallow exactly that request.
    for (let i = 0; i < 3; i += 1) {
      const res = await h.post("/api/auth/login", {
        email: "locked@example.com",
        password: "wrong-password",
      });
      expect(res.status).toBe(401);
    }
    const reset = await h.post("/api/auth/reset/request", { email: "locked@example.com" });
    expect(reset.status).toBe(204);
  });
});

describe("session provenance", () => {
  it("records the device and address that created the session", async () => {
    const h = (open = await harness({ perWindow: 20 }));
    const alice = await h.signup("alice@example.com", { userAgent: UA });
    const listed = await h.api(alice.cookies, { path: "/api/auth/sessions" });
    expect(listed.status).toBe(200);
    expect(listed.body.sessions).toHaveLength(1);
    const session = listed.body.sessions[0];
    // Both were null on every session ever minted, which left the account
    // settings session list unable to answer the one question it is for:
    // is one of these logins not mine?
    expect(session.userAgent).toBe(UA);
    expect(String(session.ip)).toContain("127.0.0.1");
    expect(session.current).toBe(true);
  });

  it("truncates an absurd user-agent rather than storing it whole", async () => {
    const h = (open = await harness({ perWindow: 20 }));
    const long = "U".repeat(2000);
    const bob = await h.signup("bob@example.com", { userAgent: long });
    const listed = await h.api(bob.cookies, { path: "/api/auth/sessions" });
    expect(String(listed.body.sessions[0].userAgent)).toHaveLength(400);
  });
});

describe("audit provenance", () => {
  it("records an address for a bearer-authenticated actor, not the actor id again", async () => {
    const h = (open = await harness({ perWindow: 20 }));
    const alice = await h.signup("alice@example.com", { userAgent: UA });
    // Bearer, no cookie: the programmatic client is the shape that exposed the
    // defect. `clientKey(req)` answers "whose rate-limit bucket is this", so for
    // this request it returned `usr:<id>` -- the audit row recorded the actor id
    // a second time in the `ip` column and lost the address entirely.
    const created = await h.post(
      "/api/orgs",
      { name: "Acme" },
      { authorization: `Bearer ${alice.token}`, "user-agent": UA },
    );
    expect(created.status).toBe(201);
    const orgId = created.body.id as string;

    const audit = await h.api(alice.cookies, { path: `/api/orgs/${orgId}/audit` });
    expect(audit.status).toBe(200);
    const entry = audit.body.entries.find((e: any) => e.action === "org.create");
    expect(entry).toBeTruthy();
    expect(String(entry.ip)).toContain("127.0.0.1");
    expect(String(entry.ip).startsWith("usr:")).toBe(false);
    expect(entry.ip).not.toBe(alice.userId);
    // The column existed and nothing ever wrote it.
    expect(entry.userAgent).toBe(UA);
  });
});

describe("DELETE /api/orgs/:id", () => {
  it("refuses while the org still holds boards", async () => {
    const h = (open = await harness({ perWindow: 20 }));
    const alice = await h.signup("alice@example.com");
    const org = await h.api(alice.cookies, {
      method: "POST",
      path: "/api/orgs",
      csrf: alice.csrf.headerValue,
      body: { name: "Acme" },
    });
    expect(org.status).toBe(201);
    const orgId = org.body.id as string;
    const board = await h.api(alice.cookies, {
      method: "POST",
      path: "/api/boards",
      csrf: alice.csrf.headerValue,
      body: { name: "Plan", orgId, workspace: createWorkspace() },
    });
    expect(board.status).toBe(201);

    const refused = await h.api(alice.cookies, {
      method: "DELETE",
      path: `/api/orgs/${orgId}`,
      csrf: alice.csrf.headerValue,
    });
    expect(refused.status).toBe(409);
    // Still there, and still readable.
    expect((await h.api(alice.cookies, { path: `/api/orgs/${orgId}` })).status).toBe(200);
  });

  it("writes the audit entry before the org row it references is gone", async () => {
    const h = (open = await harness({ perWindow: 20 }));
    const alice = await h.signup("alice@example.com");
    const org = await h.api(alice.cookies, {
      method: "POST",
      path: "/api/orgs",
      csrf: alice.csrf.headerValue,
      body: { name: "Doomed" },
    });
    const orgId = org.body.id as string;

    // `audit_log.org_id` cascades, so an entry written after the delete has no
    // row to reference: Postgres refuses it with a foreign-key violation (the
    // route answered 500 past the point of no return) and the in-memory store
    // drops it with this warning. Either way the deletion of a tenant was the
    // one action that never made it into the trail.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const deleted = await h.api(alice.cookies, {
        method: "DELETE",
        path: `/api/orgs/${orgId}`,
        csrf: alice.csrf.headerValue,
      });
      expect(deleted.status).toBe(204);
      const dropped = warn.mock.calls.some((call) =>
        String(call[0]).includes("audit entry dropped"),
      );
      expect(dropped).toBe(false);
    } finally {
      warn.mockRestore();
    }
    expect((await h.api(alice.cookies, { path: `/api/orgs/${orgId}` })).status).toBe(404);
  });
});

describe("org invite mail", () => {
  it("names the inviter and the workspace, and carries an HTML part", async () => {
    const h = (open = await harness({ perWindow: 20 }));
    const alice = await h.signup("alice@example.com", { name: "Alice Ackerman" });
    const org = await h.api(alice.cookies, {
      method: "POST",
      path: "/api/orgs",
      csrf: alice.csrf.headerValue,
      body: { name: "Acme Design" },
    });
    const orgId = org.body.id as string;

    const invited = await h.api(alice.cookies, {
      method: "POST",
      path: `/api/orgs/${orgId}/invites`,
      csrf: alice.csrf.headerValue,
      body: { email: "newbie@example.com", role: "editor" },
    });
    expect(invited.status).toBe(204);

    expect(h.sent).toHaveLength(1);
    const mail = h.sent[0]!;
    expect(mail.to).toBe("newbie@example.com");
    // The hand-rolled body named neither of these and had no HTML part at all,
    // on the one mail a new teammate ever receives from us.
    expect(mail.subject).toContain("Alice Ackerman");
    expect(mail.subject).toContain("Acme Design");
    expect(mail.html).toBeTruthy();
    expect(mail.html).toContain("Acme Design");
    expect(mail.text).toContain(`${ORIGIN}/invite?token=`);
    expect(mail.html).toContain(`${ORIGIN}/invite?token=`);
  });

  it("escapes an inviter name that arrives as markup", async () => {
    const h = (open = await harness({ perWindow: 20 }));
    // The name is a profile field the inviter controls, and it reaches the
    // template unfiltered.
    const alice = await h.signup("alice@example.com", { name: "<img src=x onerror=alert(1)>" });
    const org = await h.api(alice.cookies, {
      method: "POST",
      path: "/api/orgs",
      csrf: alice.csrf.headerValue,
      body: { name: "Acme" },
    });
    await h.api(alice.cookies, {
      method: "POST",
      path: `/api/orgs/${org.body.id}/invites`,
      csrf: alice.csrf.headerValue,
      body: { email: "newbie@example.com" },
    });
    const mail = h.sent[0]!;
    expect(mail.html).not.toContain("<img");
    expect(mail.html).toContain("&lt;img");
  });

  it("keeps the invite when the mail cannot be sent", async () => {
    const rejecting: Mailer = {
      send: async () => {
        throw new Error("smtp down");
      },
    };
    const h = (open = await harness({ perWindow: 20, mailer: rejecting }));
    const alice = await h.signup("alice@example.com");
    const org = await h.api(alice.cookies, {
      method: "POST",
      path: "/api/orgs",
      csrf: alice.csrf.headerValue,
      body: { name: "Acme" },
    });
    const orgId = org.body.id as string;

    // The send used to throw into the route's catch, answering 400 *after* the
    // invite row was committed: the owner was told it failed while the link
    // worked, and inviting again mailed a second live token for the same seat.
    const invited = await h.api(alice.cookies, {
      method: "POST",
      path: `/api/orgs/${orgId}/invites`,
      csrf: alice.csrf.headerValue,
      body: { email: "newbie@example.com" },
    });
    expect(invited.status).toBe(204);

    const invites = await h.api(alice.cookies, { path: `/api/orgs/${orgId}/invites` });
    expect(invites.status).toBe(200);
    expect(invites.body.invites).toHaveLength(1);
    expect(invites.body.invites[0].email).toBe("newbie@example.com");
  });
});
