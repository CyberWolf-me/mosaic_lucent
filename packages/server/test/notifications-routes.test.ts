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
import {
  InMemoryNotificationStore,
  NOTIFICATION_KINDS,
  type NotificationStore,
} from "../src/notifications.js";

/**
 * Notifications tray routes (M2.6).
 *
 * Six paths under `/api/notifications` cover the in-app tray:
 *   GET    /api/notifications                  paginated list with cursor
 *   GET    /api/notifications/unread-count     badge counter
 *   POST   /api/notifications/read             mark one read
 *   POST   /api/notifications/read-all         mark all read
 *   GET    /api/notifications/prefs            preferences (every kind)
 *   PUT    /api/notifications/prefs            set / reset one preference
 *
 * The store contract is pinned by `notifications.test.ts`; this file pins
 * the HTTP shape on top of it. Every assertion below proves a route answers
 * the right status for the right input and never reads or writes another
 * user's rows — the tenancy boundary lives in `markRead` (predicate on user
 * id), and these tests fail loudly if a request shape can smuggle past it.
 *
 * The harness runs the real `createApp` on a free port. Driving through HTTP
 * is the only way to assert CSRF, cookie auth, and body parsing at the same
 * time; unit-testing the handler blocks would let a wiring defect between
 * `requireCsrf` and the route slip past.
 */

const SECRET = "test-secret-at-least-16-chars";
const ORIGIN = "http://localhost:5173";

interface SignedUp {
  cookies: string;
  /** CSRF cookie + header value pair (matched at the route). */
  csrf: { cookieValue: string; headerValue: string };
  userId: string;
}

interface Harness {
  base: string;
  notifications: InMemoryNotificationStore;
  close: () => Promise<void>;
  signup: (email: string, name?: string) => Promise<SignedUp>;
  /** Make a request with the user's cookies + optional CSRF header. */
  request: (
    cookies: string,
    init: { method?: string; path: string; body?: unknown; csrf?: string },
  ) => Promise<{ status: number; body: any; headers: Record<string, string | string[]> }>;
}

/**
 * Opt-in overrides. Only the notification store so far: one test needs a store
 * whose markAllRead leaves rows behind, and the other eighteen must keep the
 * plain in-memory one byte for byte.
 */
interface HarnessOptions {
  notifications?: InMemoryNotificationStore;
}

async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const limits = limitsFromEnv();
  const config = readConfig({ LUCENT_REQUIRE_AUTH: "1", LUCENT_WEB_ORIGIN: ORIGIN });
  const userStore = new InMemoryUserStore();
  const notifications = options.notifications ?? new InMemoryNotificationStore();
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
    notifications,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  /**
   * Extract the value of a single cookie from a `set-cookie` header. The
   * value is the segment before the first `;`. Used to fold both the
   * session cookie and the CSRF cookie into one header the route can read.
   */
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

  /** Fetch the CSRF cookie + token once and cache; the route is idempotent. */
  async function csrfTokens(): Promise<{ cookieValue: string; headerValue: string }> {
    const res = await fetch(`${base}/api/auth/csrf`, {
      headers: { origin: ORIGIN },
    });
    const body = (await res.json()) as { token: string };
    const cookieValue = pickCookie(res.headers.get("set-cookie") ?? "", "lucent_csrf");
    if (!cookieValue) throw new Error("csrf route did not set a lucent_csrf cookie");
    return { cookieValue, headerValue: body.token };
  }

  /** Sign a user up and capture the session cookie + csrf pair. */
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

  /** Make an authenticated request. Cookies always sent; csrf optional. */
  const request: Harness["request"] = async (cookies, init) => {
    const headers: Record<string, string> = {
      origin: ORIGIN,
      cookie: cookies,
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
    // Node's Headers type is multi-value; copy to a plain object so callers
    // can read `headers["set-cookie"]` as a string.
    const headersOut: Record<string, string | string[]> = {};
    res.headers.forEach((value, key) => {
      headersOut[key] = value;
    });
    return { status: res.status, body, headers: headersOut };
  };

  return {
    base,
    notifications,
    close,
    signup,
    request,
  };
}

let open: Harness | null = null;

afterEach(async () => {
  await open?.close();
  open = null;
});

/** Seed one notification per kind for one user, so list/prefs assertions are exhaustive. */
async function seedEveryKind(
  store: NotificationStore,
  userId: string,
  prefix: string,
): Promise<void> {
  const kinds = NOTIFICATION_KINDS;
  for (let n = 0; n < kinds.length; n += 1) {
    // Per-user prefix so two users in the same suite do not collide on the
    // primary key (`notifications.id` is unique across the table).
    await store.create({
      id: `${prefix}_${userId}_${n}`,
      userId,
      orgId: null,
      kind: kinds[n]!,
      title: `t${n}`,
      createdAt: 1_000 + n,
    });
  }
}

describe("notifications routes — auth and shape", () => {
  it("answers 401 when the caller has no session cookie", async () => {
    const h = (open = await harness());
    const res = await fetch(`${h.base}/api/notifications`);
    expect(res.status).toBe(401);
  });

  it("answers 401 on the prefs path without a session", async () => {
    const h = (open = await harness());
    const res = await fetch(`${h.base}/api/notifications/prefs`);
    expect(res.status).toBe(401);
  });

  it("answers 401 on unread-count without a session", async () => {
    const h = (open = await harness());
    const res = await fetch(`${h.base}/api/notifications/unread-count`);
    expect(res.status).toBe(401);
  });

  it("answers 403 on a state-changing POST without a CSRF header", async () => {
    const h = (open = await harness());
    const u = await h.signup("csrf1@example.test");
    const res = await h.request(u.cookies, {
      method: "POST",
      path: "/api/notifications/read",
      body: { id: "anything" },
    });
    expect(res.status).toBe(403);
  });

  it("answers 403 on PUT /prefs without a CSRF header", async () => {
    const h = (open = await harness());
    const u = await h.signup("csrf2@example.test");
    const res = await h.request(u.cookies, {
      method: "PUT",
      path: "/api/notifications/prefs",
      body: { kind: "comment.mention", inApp: "off" },
    });
    expect(res.status).toBe(403);
  });
});

describe("GET /api/notifications", () => {
  it("returns the user's notifications newest-first with the unread badge", async () => {
    const h = (open = await harness());
    const u = await h.signup("list1@example.test");
    await seedEveryKind(h.notifications, u.userId, "list1");
    const res = await h.request(u.cookies, { path: "/api/notifications" });
    expect(res.status).toBe(200);
    const body = res.body as {
      notifications: Array<{ id: string; kind: string }>;
      nextCursor: string | null;
      unread: number;
    };
    expect(body.notifications).toHaveLength(NOTIFICATION_KINDS.length);
    // newest-first; ids were created with createdAt = 1000 + n ascending.
    expect(body.notifications[0]!.id).toBe(`list1_${u.userId}_6`);
    expect(body.notifications[body.notifications.length - 1]!.id).toBe(`list1_${u.userId}_0`);
    expect(body.unread).toBe(NOTIFICATION_KINDS.length);
    // First page (default size 30) covers every seeded row, so no next cursor.
    expect(body.nextCursor).toBeNull();
  });

  it("pages on the returned cursor and never repeats or skips a row", async () => {
    const h = (open = await harness());
    const u = await h.signup("list2@example.test");
    // Seed 10 with monotonically increasing timestamps so a size-4 page
    // exercises several boundaries.
    for (let n = 0; n < 10; n += 1) {
      await h.notifications.create({
        id: `list2_${n}`,
        userId: u.userId,
        orgId: null,
        kind: "comment.reply",
        title: `r${n}`,
        createdAt: 1_000 + n,
      });
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const path = `/api/notifications?limit=4${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const res = await h.request(u.cookies, { path });
      expect(res.status).toBe(200);
      const body = res.body as { notifications: Array<{ id: string }>; nextCursor: string | null };
      for (const row of body.notifications) {
        expect(seen).not.toContain(row.id);
        seen.push(row.id);
      }
      cursor = body.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1, 0].map((n) => `list2_${n}`));
  });

  it("answers 400 on a malformed cursor", async () => {
    const h = (open = await harness());
    const u = await h.signup("list3@example.test");
    const res = await h.request(u.cookies, {
      path: "/api/notifications?cursor=not-a-cursor",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid cursor");
  });

  it("clamps an absurd limit at the store's page maximum and answers 200", async () => {
    const h = (open = await harness());
    const u = await h.signup("list4@example.test");
    await h.notifications.create({
      id: "list4_0",
      userId: u.userId,
      orgId: null,
      kind: "comment.reply",
      title: "x",
      createdAt: 1,
    });
    const res = await h.request(u.cookies, { path: "/api/notifications?limit=100000" });
    expect(res.status).toBe(200);
    const body = res.body as { notifications: unknown[] };
    expect(body.notifications).toHaveLength(1);
  });
});

describe("GET /api/notifications/unread-count", () => {
  it("answers the badge number, dropping after a mark-read", async () => {
    const h = (open = await harness());
    const u = await h.signup("unread1@example.test");
    await seedEveryKind(h.notifications, u.userId, "unread1");
    const before = await h.request(u.cookies, { path: "/api/notifications/unread-count" });
    expect(before.status).toBe(200);
    expect(before.body.count).toBe(NOTIFICATION_KINDS.length);
    // Mark one read; the badge must move accordingly.
    const mark = await h.request(u.cookies, {
      method: "POST",
      path: "/api/notifications/read",
      csrf: u.csrf.headerValue,
      body: { id: `unread1_${u.userId}_0` },
    });
    expect(mark.status).toBe(200);
    const after = await h.request(u.cookies, { path: "/api/notifications/unread-count" });
    expect(after.body.count).toBe(NOTIFICATION_KINDS.length - 1);
  });
});

describe("POST /api/notifications/read", () => {
  it("marks one notification read and reports changed=true on the first call", async () => {
    const h = (open = await harness());
    const u = await h.signup("read1@example.test");
    await h.notifications.create({
      id: "read1_0",
      userId: u.userId,
      orgId: null,
      kind: "comment.reply",
      title: "r",
      createdAt: 1,
    });
    const first = await h.request(u.cookies, {
      method: "POST",
      path: "/api/notifications/read",
      csrf: u.csrf.headerValue,
      body: { id: "read1_0" },
    });
    expect(first.status).toBe(200);
    expect(first.body.changed).toBe(true);
    expect(first.body.count).toBe(0);
    // A second call returns changed=false; nothing else changed.
    const second = await h.request(u.cookies, {
      method: "POST",
      path: "/api/notifications/read",
      csrf: u.csrf.headerValue,
      body: { id: "read1_0" },
    });
    expect(second.body.changed).toBe(false);
  });

  it("refuses to mark another user's notification (changed=false, no count change)", async () => {
    const h = (open = await harness());
    const u1 = await h.signup("read2a@example.test");
    const u2 = await h.signup("read2b@example.test");
    await h.notifications.create({
      id: "read2_0",
      userId: u1.userId,
      orgId: null,
      kind: "comment.reply",
      title: "r",
      createdAt: 1,
    });
    const res = await h.request(u2.cookies, {
      method: "POST",
      path: "/api/notifications/read",
      csrf: u2.csrf.headerValue,
      body: { id: "read2_0" },
    });
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(false);
    // u1's tray is untouched.
    const own = await h.request(u1.cookies, { path: "/api/notifications/unread-count" });
    expect(own.body.count).toBe(1);
  });

  it("answers 400 when the body has no id", async () => {
    const h = (open = await harness());
    const u = await h.signup("read3@example.test");
    const res = await h.request(u.cookies, {
      method: "POST",
      path: "/api/notifications/read",
      csrf: u.csrf.headerValue,
      body: {},
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("id is required");
  });
});

/**
 * A store whose markAllRead clears only a bounded batch, which is what a
 * Postgres implementation with a LIMIT -- or one that marks just the page it
 * listed -- does. The plain in-memory store marks every row in a single pass,
 * so under it a route that answered a hardcoded zero and a route that read the
 * count back are indistinguishable. This is the store that tells them apart.
 *
 * Built from the public surface rather than by reaching into rows: list gives
 * the newest page, markRead reports whether it changed anything, and that is
 * the whole implementation.
 */
class BatchedMarkAllStore extends InMemoryNotificationStore {
  constructor(private readonly batch: number) {
    super();
  }

  override async markAllRead(userId: string, at: number): Promise<number> {
    let changed = 0;
    for (const row of await this.list(userId, this.batch)) {
      if (await this.markRead(userId, row.id, at)) changed += 1;
    }
    return changed;
  }
}

describe("POST /api/notifications/read-all", () => {
  it("marks every unread row read and reports the count changed", async () => {
    const h = (open = await harness());
    const u = await h.signup("readall1@example.test");
    await seedEveryKind(h.notifications, u.userId, "readall1");
    const res = await h.request(u.cookies, {
      method: "POST",
      path: "/api/notifications/read-all",
      csrf: u.csrf.headerValue,
    });
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(NOTIFICATION_KINDS.length);
    expect(res.body.count).toBe(0);
    // Re-running reads nothing new.
    const second = await h.request(u.cookies, {
      method: "POST",
      path: "/api/notifications/read-all",
      csrf: u.csrf.headerValue,
    });
    expect(second.body.changed).toBe(0);
  });

  it("reports the count it read back, not a zero the store never earned", async () => {
    // The route used to answer a literal "count: 0", true only because the
    // in-memory store marks everything in one pass. The tray takes this number
    // as its badge, so against any store that leaves a row behind -- a batched
    // one here, or a notification that arrived mid-request anywhere -- the
    // literal hid unread items until the next poll.
    const batch = 2;
    const h = (open = await harness({ notifications: new BatchedMarkAllStore(batch) }));
    const u = await h.signup("readall3@example.test");
    await seedEveryKind(h.notifications, u.userId, "readall3");
    const res = await h.request(u.cookies, {
      method: "POST",
      path: "/api/notifications/read-all",
      csrf: u.csrf.headerValue,
    });
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(batch);
    expect(res.body.count).toBe(NOTIFICATION_KINDS.length - batch);
    // The badge route agrees, which is the point: one number, two paths to it.
    const badge = await h.request(u.cookies, { path: "/api/notifications/unread-count" });
    expect(badge.body.count).toBe(NOTIFICATION_KINDS.length - batch);
  });

  it("does not affect another user's tray", async () => {
    const h = (open = await harness());
    const u1 = await h.signup("readall2a@example.test");
    const u2 = await h.signup("readall2b@example.test");
    await seedEveryKind(h.notifications, u1.userId, "readall2");
    await seedEveryKind(h.notifications, u2.userId, "readall2");
    await h.request(u1.cookies, {
      method: "POST",
      path: "/api/notifications/read-all",
      csrf: u1.csrf.headerValue,
    });
    // u2 is untouched.
    const own = await h.request(u2.cookies, { path: "/api/notifications/unread-count" });
    expect(own.body.count).toBe(NOTIFICATION_KINDS.length);
  });
});

describe("GET /api/notifications/prefs", () => {
  it("answers one pref per kind in catalogue order, every pref explicit=false at first", async () => {
    const h = (open = await harness());
    const u = await h.signup("prefs1@example.test");
    const res = await h.request(u.cookies, { path: "/api/notifications/prefs" });
    expect(res.status).toBe(200);
    const body = res.body as { prefs: Array<{ kind: string; explicit: boolean }> };
    expect(body.prefs.map((p) => p.kind)).toEqual([...NOTIFICATION_KINDS]);
    expect(body.prefs.every((p) => p.explicit === false)).toBe(true);
  });
});

describe("PUT /api/notifications/prefs", () => {
  it("stores a single-channel update and leaves the other channel alone", async () => {
    const h = (open = await harness());
    const u = await h.signup("prefs2@example.test");
    // Default for board.invited has email=on. Flip only inApp to off and
    // confirm the persisted row reflects that and email stays on.
    const put = await h.request(u.cookies, {
      method: "PUT",
      path: "/api/notifications/prefs",
      csrf: u.csrf.headerValue,
      body: { kind: "board.invited", inApp: "off" },
    });
    expect(put.status).toBe(200);
    const body = put.body as {
      prefs: Array<{ kind: string; inApp: string; email: string; explicit: boolean }>;
    };
    const row = body.prefs.find((p) => p.kind === "board.invited")!;
    expect(row).toEqual({ kind: "board.invited", inApp: "off", email: "on", explicit: true });
    // Re-read independently to confirm persistence (not just echoed back).
    const read = await h.request(u.cookies, { path: "/api/notifications/prefs" });
    const reread = (
      read.body as {
        prefs: Array<{ kind: string; inApp: string; email: string; explicit: boolean }>;
      }
    ).prefs.find((p) => p.kind === "board.invited")!;
    expect(reread).toEqual({ kind: "board.invited", inApp: "off", email: "on", explicit: true });
  });

  it("resets a kind to the catalogue default when reset=true", async () => {
    const h = (open = await harness());
    const u = await h.signup("prefs3@example.test");
    // First set explicit, then reset.
    await h.request(u.cookies, {
      method: "PUT",
      path: "/api/notifications/prefs",
      csrf: u.csrf.headerValue,
      body: { kind: "comment.mention", inApp: "off", email: "off" },
    });
    const reset = await h.request(u.cookies, {
      method: "PUT",
      path: "/api/notifications/prefs",
      csrf: u.csrf.headerValue,
      body: { kind: "comment.mention", reset: true },
    });
    expect(reset.status).toBe(200);
    const row = (
      reset.body as {
        prefs: Array<{ kind: string; inApp: string; email: string; explicit: boolean }>;
      }
    ).prefs.find((p) => p.kind === "comment.mention")!;
    expect(row).toEqual({ kind: "comment.mention", inApp: "on", email: "on", explicit: false });
  });

  it("answers 400 for an unknown kind rather than storing a preference nothing will read", async () => {
    const h = (open = await harness());
    const u = await h.signup("prefs4@example.test");
    const res = await h.request(u.cookies, {
      method: "PUT",
      path: "/api/notifications/prefs",
      csrf: u.csrf.headerValue,
      body: { kind: "comment.mentions", inApp: "off" },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("unknown notification kind");
  });
});
