import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CSRF_HEADER, getCsrfToken, invalidateCsrfToken } from "../src/http.js";
import {
  NOTIFICATION_KINDS,
  badgeText,
  describeNotification,
  fetchNotifications,
  fetchUnreadCount,
  isNotificationKind,
  markAllNotificationsRead,
  markNotificationRead,
  notificationAge,
  safeRelativePath,
  startUnreadPoll,
  unreadAnnouncement,
  unreadLabel,
} from "../src/notifications.js";
import type { NotificationRow } from "../src/notifications.js";

/**
 * The notification client. Vitest runs in the node environment here (no jsdom,
 * no @testing-library — see `vite.config.ts`), which is why every decision the
 * tray makes lives in `notifications.ts` as a pure function or a poller with
 * injectable globals: this file can then cover the logic that would otherwise
 * only be reachable by rendering.
 *
 * What matters most is the poller's failure behaviour. A background loop that
 * throws, or that keeps 401ing once a minute forever, or that zeroes a badge
 * because one request timed out, is worse than no tray at all.
 */

/* localStorage: `hasSession()` gates every call, and there is no DOM to provide
 * one. Same stub the CSRF and board-client suites use. */
const store: Record<string, string> = {};
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
    removeItem: (k: string) => {
      delete store[k];
    },
  },
  configurable: true,
});

interface Recorded {
  url: string;
  init: RequestInit;
}

let calls: Recorded[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Records every request; answers the CSRF mint, and anything else per handler. */
function stubFetch(handler?: (url: string, init: RequestInit) => Response | undefined) {
  const mock = vi.fn((url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    if (url === "/api/auth/csrf") return Promise.resolve(json({ token: "csrf-1" }));
    const custom = handler?.(url, init);
    return Promise.resolve(custom ?? json({ count: 0 }));
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

function headersOf(record: Recorded): Record<string, string> {
  return (record.init.headers ?? {}) as Record<string, string>;
}

function apiCalls(): Recorded[] {
  return calls.filter((c) => c.url !== "/api/auth/csrf");
}

function row(over: Partial<NotificationRow> = {}): NotificationRow {
  return {
    id: "ntf_1",
    orgId: null,
    kind: "comment.mention",
    title: "Ann mentioned you",
    body: "have a look at this",
    link: null,
    metadata: {},
    createdAt: 1_000,
    readAt: null,
    ...over,
  };
}

beforeEach(async () => {
  calls = [];
  store["lucent.token"] = "bearer_1";
  store["lucent.user"] = JSON.stringify({ id: "u1", email: "a@b.c", name: "Ann" });
  invalidateCsrfToken();
  stubFetch();
  // Boot behaviour: the app warms the CSRF pair once per load, so the mutating
  // calls below start from the state a real click starts from.
  await getCsrfToken();
  calls = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete store["lucent.token"];
  delete store["lucent.user"];
});

describe("notification calls", () => {
  it("reads the count from the account-scoped endpoint with the session attached", async () => {
    stubFetch((url) =>
      url === "/api/notifications/unread-count" ? json({ count: 3 }) : undefined,
    );
    const res = await fetchUnreadCount();
    expect(res).toEqual({ ok: true, value: 3 });
    const call = apiCalls()[0]!;
    expect(call.url).toBe("/api/notifications/unread-count");
    expect(call.init.credentials).toBe("include");
  });

  it("does not touch the network when there is no session", async () => {
    delete store["lucent.token"];
    delete store["lucent.user"];
    const res = await fetchUnreadCount();
    expect(res).toEqual({ ok: false, failure: "signed-out" });
    expect(apiCalls()).toHaveLength(0);
  });

  it("separates the permanent failures from the ones worth retrying", async () => {
    const statuses: [number, string][] = [
      [401, "signed-out"],
      [503, "unavailable"],
      [403, "error"],
      [500, "error"],
      [400, "error"],
    ];
    for (const [status, failure] of statuses) {
      stubFetch(() => json({ error: "no" }, status));
      expect(await fetchUnreadCount()).toEqual({ ok: false, failure });
    }
  });

  it("reports a dead socket as offline rather than as a signed-out session", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
    );
    expect(await fetchUnreadCount()).toEqual({ ok: false, failure: "offline" });
  });

  it("refuses a 200 that is not the answer it asked for", async () => {
    stubFetch(() => new Response("<html>proxy</html>", { status: 200 }));
    expect(await fetchUnreadCount()).toEqual({ ok: false, failure: "error" });
    stubFetch(() => json({ count: -4 }));
    expect(await fetchUnreadCount()).toEqual({ ok: false, failure: "error" });
  });

  it("pages with limit and cursor, and takes the badge from the same response", async () => {
    stubFetch(() => json({ notifications: [row({ id: "a" })], nextCursor: "1000.a", unread: 7 }));
    const res = await fetchNotifications({ limit: 20, cursor: "2000.b" });
    expect(apiCalls()[0]!.url).toBe("/api/notifications?limit=20&cursor=2000.b");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.notifications.map((r) => r.id)).toEqual(["a"]);
    expect(res.value.nextCursor).toBe("1000.a");
    expect(res.value.unread).toBe(7);
  });

  it("omits absent options rather than sending them empty", async () => {
    await fetchNotifications();
    expect(apiCalls()[0]!.url).toBe("/api/notifications");
  });

  it("drops a row it could not render instead of failing the whole page", async () => {
    stubFetch(() =>
      json({
        notifications: [row({ id: "good" }), { id: "no-title" }, null, { title: "no id" }],
        nextCursor: null,
        unread: 1,
      }),
    );
    const res = await fetchNotifications();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.notifications.map((r) => r.id)).toEqual(["good"]);
  });

  it("marks one row read with the CSRF header and returns the server's count", async () => {
    stubFetch(() => json({ changed: true, count: 2 }));
    const res = await markNotificationRead("ntf_1");
    expect(res).toEqual({ ok: true, value: { changed: true, count: 2 } });
    const call = apiCalls()[0]!;
    expect(call.url).toBe("/api/notifications/read");
    expect(call.init.method).toBe("POST");
    expect(headersOf(call)[CSRF_HEADER]).toBe("csrf-1");
    expect(call.init.credentials).toBe("include");
    expect(JSON.parse(String(call.init.body))).toEqual({ id: "ntf_1" });
  });

  it("marks everything read with the CSRF header", async () => {
    stubFetch(() => json({ changed: true, count: 0 }));
    const res = await markAllNotificationsRead();
    expect(res).toEqual({ ok: true, value: { changed: true, count: 0 } });
    const call = apiCalls()[0]!;
    expect(call.url).toBe("/api/notifications/read-all");
    expect(call.init.method).toBe("POST");
    expect(headersOf(call)[CSRF_HEADER]).toBe("csrf-1");
  });

  it("treats a mark-read reply with no count as a failure, not as zero unread", async () => {
    stubFetch(() => json({ changed: true }));
    expect(await markNotificationRead("ntf_1")).toEqual({ ok: false, failure: "error" });
  });
});

describe("notification presentation", () => {
  it("gives every server kind human copy and an icon", () => {
    for (const kind of NOTIFICATION_KINDS) {
      const view = describeNotification(row({ kind }));
      expect(view.kind).toBe(kind);
      expect(view.category).not.toBe("Notification");
      expect(view.icon).not.toBe("bell");
    }
    expect(NOTIFICATION_KINDS).toHaveLength(7);
  });

  it("still renders a kind this build has never heard of", () => {
    // The server stores the words it composed at write time precisely so a row
    // outlives the code that wrote it; an unknown kind must degrade, not vanish.
    const view = describeNotification(row({ kind: "board.exploded", title: "Something happened" }));
    expect(view.kind).toBeNull();
    expect(view.category).toBe("Notification");
    expect(view.icon).toBe("bell");
    expect(view.title).toBe("Something happened");
    expect(isNotificationKind("board.exploded")).toBe(false);
  });

  it("prefers the link the server stored", () => {
    const view = describeNotification(
      row({ link: "/?board=brd_9", metadata: { boardId: "brd_other" } }),
    );
    expect(view.href).toBe("/?board=brd_9");
  });

  it("falls back to the board in the payload when no link was stored", () => {
    const view = describeNotification(row({ kind: "board.invited", metadata: { boardId: "b 1" } }));
    expect(view.href).toBe("/?board=b%201");
  });

  it("uses the invite's accept path, and nothing else, for a workspace invite", () => {
    expect(
      describeNotification(row({ kind: "org.invited", metadata: { acceptPath: "/invite/t1" } }))
        .href,
    ).toBe("/invite/t1");
    expect(
      describeNotification(row({ kind: "org.invited", metadata: { orgId: "org_1" } })).href,
    ).toBeNull();
  });

  it("renders an informational row as text", () => {
    expect(
      describeNotification(row({ kind: "org.member_joined", metadata: { orgId: "o" } })).href,
    ).toBeNull();
  });

  it("refuses any link that could leave the app", () => {
    // `acceptPath` is caller-supplied and `link` is stored JSON, so by the time
    // either reaches an href it is data — including the two that look relative.
    for (const bad of [
      "javascript:alert(1)",
      "//evil.example/x",
      "https://evil.example",
      String.raw`/\evil.example`,
      "evil",
      "",
      42,
      null,
    ]) {
      expect(safeRelativePath(bad)).toBeNull();
    }
    expect(safeRelativePath("/?board=b1")).toBe("/?board=b1");
    expect(safeRelativePath("  /invite/t1  ")).toBe("/invite/t1");
    expect(describeNotification(row({ link: "javascript:alert(1)" })).href).toBeNull();
  });

  it("reads the read flag from readAt", () => {
    expect(describeNotification(row({ readAt: null })).read).toBe(false);
    expect(describeNotification(row({ readAt: 5 })).read).toBe(true);
  });

  it("labels age in the same ladder as the comment panel", () => {
    const now = 10 * 24 * 3600_000;
    expect(notificationAge(now - 5_000, now)).toBe("now");
    expect(notificationAge(now - 5 * 60_000, now)).toBe("5m");
    expect(notificationAge(now - 3 * 3600_000, now)).toBe("3h");
    expect(notificationAge(now - 2 * 24 * 3600_000, now)).toBe("2d");
  });

  it("puts the count in the accessible name, not only in the badge", () => {
    expect(unreadLabel(0)).toBe("Notifications, none unread");
    expect(unreadLabel(1)).toBe("Notifications, 1 unread");
    expect(unreadLabel(4)).toBe("Notifications, 4 unread");
    expect(badgeText(9)).toBe("9");
    expect(badgeText(1000)).toBe("99+");
  });

  it("says nothing in the live region when there is nothing to say", () => {
    expect(unreadAnnouncement(0)).toBe("");
    expect(unreadAnnouncement(1)).toBe("1 unread notification");
    expect(unreadAnnouncement(2)).toBe("2 unread notifications");
  });
});

/**
 * A stand-in for the two globals the poller touches. Node has neither, so the
 * poller's guards mean it runs headless — but then the visibility behaviour, the
 * part that keeps a backgrounded tab off the network, would go untested.
 */
function fakeDom(hidden = false) {
  const handlers = new Map<string, Set<() => void>>();
  const target = {
    addEventListener: (type: string, fn: () => void) => {
      const set = handlers.get(type) ?? new Set<() => void>();
      set.add(fn);
      handlers.set(type, set);
    },
    removeEventListener: (type: string, fn: () => void) => {
      handlers.get(type)?.delete(fn);
    },
  };
  let isHidden = hidden;
  vi.stubGlobal("document", {
    ...target,
    get visibilityState() {
      return isHidden ? "hidden" : "visible";
    },
  });
  vi.stubGlobal("window", target);
  return {
    fire: (type: string) => {
      for (const fn of [...(handlers.get(type) ?? [])]) fn();
    },
    setHidden: (value: boolean) => {
      isHidden = value;
    },
    listenerCount: () => [...handlers.values()].reduce((n, set) => n + set.size, 0),
  };
}

describe("unread poller", () => {
  it("fetches once immediately, then on the interval, and not after it is stopped", async () => {
    vi.useFakeTimers();
    stubFetch(() => json({ count: 1 }));
    const counts: number[] = [];
    const stop = startUnreadPoll({ onCount: (c) => counts.push(c), intervalMs: 60_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(counts).toEqual([1]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(counts).toEqual([1, 1]);
    stop();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(counts).toEqual([1, 1]);
  });

  it("gives up for good on a dead session instead of 401ing every minute", async () => {
    vi.useFakeTimers();
    stubFetch(() => json({ error: "authentication required" }, 401));
    const stopped: string[] = [];
    const stop = startUnreadPoll({
      onCount: () => expect.unreachable("no count from a 401"),
      onStopped: (failure) => stopped.push(failure),
      intervalMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toEqual(["signed-out"]);
    const sent = apiCalls().length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(apiCalls()).toHaveLength(sent);
    stop();
  });

  it("gives up on a deployment with the feature switched off", async () => {
    vi.useFakeTimers();
    stubFetch(() => json({ error: "notifications not configured" }, 503));
    const stopped: string[] = [];
    const stop = startUnreadPoll({
      onCount: () => undefined,
      onStopped: (failure) => stopped.push(failure),
      intervalMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toEqual(["unavailable"]);
    stop();
  });

  it("keeps the last known count through a failure and recovers on the next tick", async () => {
    vi.useFakeTimers();
    let broken = false;
    stubFetch(() => (broken ? json({ error: "boom" }, 500) : json({ count: 4 })));
    const counts: number[] = [];
    const stop = startUnreadPoll({ onCount: (c) => counts.push(c), intervalMs: 1_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(counts).toEqual([4]);
    broken = true;
    await vi.advanceTimersByTimeAsync(1_000);
    // No zero, no throw: the badge still shows 4 and the loop is still alive.
    expect(counts).toEqual([4]);
    broken = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(counts).toEqual([4, 4]);
    stop();
  });

  it("survives a fetch that rejects outright", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
    );
    const counts: number[] = [];
    const stop = startUnreadPoll({ onCount: (c) => counts.push(c), intervalMs: 1_000 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(counts).toEqual([]);
    stop();
  });

  it("does not poll while the tab is hidden, and catches up the moment it is not", async () => {
    const dom = fakeDom(true);
    vi.useFakeTimers();
    stubFetch(() => json({ count: 2 }));
    const counts: number[] = [];
    const stop = startUnreadPoll({ onCount: (c) => counts.push(c), intervalMs: 60_000 });
    await vi.advanceTimersByTimeAsync(180_000);
    expect(counts).toEqual([]);
    expect(apiCalls()).toHaveLength(0);

    dom.setHidden(false);
    dom.fire("visibilitychange");
    await vi.advanceTimersByTimeAsync(0);
    expect(counts).toEqual([2]);

    dom.setHidden(true);
    dom.fire("visibilitychange");
    await vi.advanceTimersByTimeAsync(600_000);
    expect(counts).toEqual([2]);

    stop();
    expect(dom.listenerCount()).toBe(0);
  });

  it("counts one alt-tab as one fetch even though two events fire", async () => {
    const dom = fakeDom();
    vi.useFakeTimers();
    stubFetch(() => json({ count: 5 }));
    const counts: number[] = [];
    const stop = startUnreadPoll({ onCount: (c) => counts.push(c), intervalMs: 60_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(counts).toEqual([5]);

    // Returning to the window fires both, and neither is redundant in general —
    // but together they must not double the request.
    dom.fire("visibilitychange");
    dom.fire("focus");
    await vi.advanceTimersByTimeAsync(0);
    expect(counts).toEqual([5]);

    // Once the burst window has passed, a real return does refresh.
    await vi.advanceTimersByTimeAsync(6_000);
    dom.fire("focus");
    await vi.advanceTimersByTimeAsync(0);
    expect(counts).toEqual([5, 5]);
    stop();
  });
});
