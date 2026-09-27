import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createWorkspace } from "@lucent/core";
import {
  CSRF_HEADER,
  apiFetch,
  buildHeaders,
  buildRequestInit,
  getCsrfToken,
  invalidateCsrfToken,
  isMutating,
} from "../src/http.js";
import { generate, generateImage } from "../src/api.js";
import * as boards from "../src/boards.js";
import * as session from "../src/session.js";
import * as notifications from "../src/notifications.js";
import * as meetings from "../src/meetings.js";
import { configureLiveKit, fetchLiveKitToken } from "../src/stt/livekit.js";

const TURN = { speaker: "Ann", at: 1, text: "We ship Friday." };

/**
 * The CSRF header is the defect that broke the product: `/api/generate` and
 * `/api/image` were written with a hand-rolled `fetch` that sent the session
 * cookie and no `x-csrf-token`, so the server's guard 403'd the main generation
 * loop for every signed-in user while the code looked perfectly fine.
 *
 * So the header is not tested per call site — it is tested by walking *every*
 * mutating call the client can make. A new endpoint added with a bare `fetch`
 * fails here, which is the point: this must not be able to come back.
 */

const ws = createWorkspace();

/**
 * The board list route is org-scoped: `GET /api/boards` without an orgId is a
 * 400 (app.ts:2277), so the list calls below name a tenant and the recorded
 * URL carries the query string.
 */
const ORG = "org_1";
const BOARDS_URL = `/api/boards?orgId=${ORG}`;

/* localStorage: jsdom/happy-dom are not installed, so stub the three methods
 * `session.ts` uses. See the report - component tests need a DOM environment. */
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
let mints = 0;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * One response body that satisfies every client parser at once, so a single
 * table can drive calls that expect a board, a user, a ticket or operations.
 */
const ANY_BODY = {
  ok: true,
  id: "brd_1",
  name: "Board",
  updatedAt: 1,
  workspace: ws,
  role: "editor",
  boards: [],
  members: [],
  ticket: "tkt_1",
  revoked: 1,
  token: "tok_from_server",
  user: { id: "u1", email: "a@b.c", name: "Ann" },
  operations: [],
  explanation: null,
  provider: "mock",
  src: "data:image/png;base64,AA",
};

/** Records every request; answers the mint route with a fresh, numbered token. */
function stubFetch(handler?: (url: string) => Response | undefined) {
  const mock = vi.fn((url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    // The handler goes first so a test can make the mint itself fail.
    const custom = handler?.(url);
    if (custom !== undefined) return Promise.resolve(custom);
    if (url === "/api/auth/csrf") {
      mints += 1;
      return Promise.resolve(json({ token: `csrf-${mints}` }));
    }
    return Promise.resolve(json(ANY_BODY));
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

function headersOf(record: Recorded): Record<string, string> {
  return (record.init.headers ?? {}) as Record<string, string>;
}

function requestsTo(url: string): Recorded[] {
  return calls.filter((c) => c.url === url);
}

beforeEach(async () => {
  calls = [];
  mints = 0;
  store["lucent.token"] = "bearer_1";
  store["lucent.user"] = JSON.stringify({ id: "u1", email: "a@b.c", name: "Ann" });
  invalidateCsrfToken();
  stubFetch();
  // Boot behaviour: `App` warms the pair once per page load. Await it so each
  // test starts from the steady state the app is in by the time a user clicks.
  await getCsrfToken();
  calls = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete store["lucent.token"];
  delete store["lucent.user"];
});

/* --------------------------- the regression table ------------------------- */

interface ClientCall {
  name: string;
  url: string;
  method: string;
  run: () => Promise<unknown>;
}

/** Every state-changing request the web client can send. Keep this exhaustive. */
const MUTATING: ClientCall[] = [
  { name: "generate", url: "/api/generate", method: "POST", run: () => generate("hi", ws) },
  { name: "generateImage", url: "/api/image", method: "POST", run: () => generateImage("a cat") },
  {
    name: "saveBoard",
    url: "/api/boards",
    method: "POST",
    run: () => boards.saveBoard(ORG, "b", ws),
  },
  {
    name: "createShareLink",
    url: "/api/boards/brd_1/share",
    method: "POST",
    run: () => boards.createShareLink("brd_1", "editor"),
  },
  {
    name: "revokeShareLinks",
    url: "/api/boards/brd_1/share",
    method: "DELETE",
    run: () => boards.revokeShareLinks("brd_1"),
  },
  {
    name: "joinBoard",
    url: "/api/boards/brd_1/join",
    method: "POST",
    run: () => boards.joinBoard("brd_1", "shr_1"),
  },
  {
    name: "setMemberRole",
    url: "/api/boards/brd_1/members/u2",
    method: "PATCH",
    run: () => boards.setMemberRole("brd_1", "u2", "viewer"),
  },
  {
    name: "removeMember",
    url: "/api/boards/brd_1/members/u2",
    method: "DELETE",
    run: () => boards.removeMember("brd_1", "u2"),
  },
  {
    name: "fetchRealtimeTicket",
    url: "/api/realtime/ticket",
    method: "POST",
    run: () => boards.fetchRealtimeTicket(),
  },
  {
    name: "signup",
    url: "/api/auth/signup",
    method: "POST",
    run: () => session.attemptSignup("Ann", "a@b.c", "password123"),
  },
  {
    name: "login",
    url: "/api/auth/login",
    method: "POST",
    run: () => session.attemptLogin("a@b.c", "password123"),
  },
  {
    name: "two-factor verify",
    url: "/api/auth/2fa/verify",
    method: "POST",
    run: () => session.verifyTwoFactor("lgn_1", "123456"),
  },
  {
    name: "reset request",
    url: "/api/auth/reset/request",
    method: "POST",
    run: () => session.requestPasswordReset("a@b.c"),
  },
  {
    name: "reset confirm",
    url: "/api/auth/reset/confirm",
    method: "POST",
    run: () => session.confirmPasswordReset("rst_1", "password123"),
  },
  {
    name: "verify email",
    url: "/api/auth/verify/confirm",
    method: "POST",
    run: () => session.confirmEmailVerification("vrf_1"),
  },
  {
    name: "accept invite",
    url: "/api/invites/accept",
    method: "POST",
    run: () => session.acceptInvite("inv_1"),
  },
  {
    name: "mark notification read",
    url: "/api/notifications/read",
    method: "POST",
    run: () => notifications.markNotificationRead("n1"),
  },
  {
    name: "mark all notifications read",
    url: "/api/notifications/read-all",
    method: "POST",
    run: () => notifications.markAllNotificationsRead(),
  },
  // docs/28 F13/F17: meeting capture writes and proposal-create (the server
  // now checks CSRF on all of them).
  {
    name: "saveMeeting",
    url: "/api/boards/brd_1/meetings",
    method: "POST",
    run: () => meetings.saveMeeting("brd_1", { turns: [TURN], startedAt: 1 }),
  },
  {
    name: "appendMeetingTurns",
    url: "/api/boards/brd_1/meetings/mtg_1/turns",
    method: "POST",
    run: () => meetings.appendMeetingTurns("brd_1", "mtg_1", [TURN]),
  },
  {
    name: "endMeeting",
    url: "/api/boards/brd_1/meetings/mtg_1/end",
    method: "POST",
    run: () => meetings.endMeeting("brd_1", "mtg_1"),
  },
  {
    name: "createServerProposal",
    url: "/api/boards/brd_1/proposals",
    method: "POST",
    run: () => boards.createServerProposal("brd_1", { operations: [], request: "r" }),
  },
  // docs/28 F23: the LiveKit speech provider's token request used a bare
  // fetch — a 403 for every cookie session on Lucent's own token route.
  {
    name: "fetchLiveKitToken",
    url: "/api/livekit/token",
    method: "POST",
    run: () => {
      configureLiveKit({ url: "wss://rtc.example", tokenUrl: "/api/livekit/token", room: "r" });
      return fetchLiveKitToken("r");
    },
  },
  {
    name: "logout",
    url: "/api/auth/logout",
    method: "POST",
    // Fire-and-forget by design; a microtask is enough for the request to leave.
    run: async () => {
      session.clearSession();
      await Promise.resolve();
    },
  },
];

describe("every mutating client call carries the CSRF header", () => {
  for (const call of MUTATING) {
    it(`${call.name} -> ${call.method} ${call.url}`, async () => {
      await call.run();
      const sent = requestsTo(call.url);
      expect(sent, `no request to ${call.url}`).toHaveLength(1);
      const record = sent[0]!;
      expect(record.init.method).toBe(call.method);
      expect(headersOf(record)[CSRF_HEADER]).toBe("csrf-1");
      // Without this the cookie is not attached cross-origin and the call is
      // silently unauthenticated.
      expect(record.init.credentials).toBe("include");
    });
  }

  it("covers every path the client posts to", () => {
    // Guards against a call being deleted from the table instead of fixed.
    expect(new Set(MUTATING.map((c) => `${c.method} ${c.url}`)).size).toBe(MUTATING.length);
    expect(MUTATING).toHaveLength(24);
  });

  it("a third-party LiveKit token server gets neither the CSRF token nor the cookies", async () => {
    configureLiveKit({
      url: "wss://rtc.example",
      tokenUrl: "https://tokens.example.com/issue",
      room: "r",
    });
    await fetchLiveKitToken("r");
    const record = requestsTo("https://tokens.example.com/issue")[0];
    expect(record, "no token request").toBeDefined();
    expect(headersOf(record!)[CSRF_HEADER]).toBeUndefined();
    expect(record!.init.credentials).toBe("omit");
  });
});

/* --------------------------- reads and credentials ------------------------ */

describe("safe methods", () => {
  const READS: Array<{ name: string; url: string; run: () => Promise<unknown> }> = [
    { name: "listBoards", url: BOARDS_URL, run: () => boards.listBoards(ORG) },
    { name: "fetchBoard", url: "/api/boards/brd_1", run: () => boards.fetchBoard("brd_1") },
    {
      name: "listMembers",
      url: "/api/boards/brd_1/members",
      run: () => boards.listMembers("brd_1"),
    },
    { name: "checkSession", url: "/api/auth/me", run: () => session.checkSession() },
  ];

  for (const read of READS) {
    it(`${read.name} sends the cookie but no CSRF header`, async () => {
      await read.run();
      const record = requestsTo(read.url)[0];
      expect(record, `no request to ${read.url}`).toBeDefined();
      expect(record!.init.credentials).toBe("include");
      // The server skips the guard for safe methods; sending the header anyway
      // would be noise, and asserting its absence keeps `isMutating` honest.
      expect(headersOf(record!)[CSRF_HEADER]).toBeUndefined();
    });
  }

  it("classifies methods the same way the server does", () => {
    expect(isMutating(undefined)).toBe(false);
    expect(isMutating("get")).toBe(false);
    expect(isMutating("HEAD")).toBe(false);
    expect(isMutating("OPTIONS")).toBe(false);
    expect(isMutating("post")).toBe(true);
    expect(isMutating("PATCH")).toBe(true);
    expect(isMutating("DELETE")).toBe(true);
    expect(isMutating("PUT")).toBe(true);
  });
});

describe("bearer token", () => {
  it("is sent while a legacy token session exists", async () => {
    await boards.listBoards(ORG);
    expect(headersOf(requestsTo(BOARDS_URL)[0]!).authorization).toBe("Bearer bearer_1");
  });

  it("is omitted for a cookie-only session", async () => {
    delete store["lucent.token"];
    await boards.listBoards(ORG);
    // The cached user still says "signed in", so the call must go out - just
    // without an `Authorization: Bearer ` that carries nothing.
    expect(headersOf(requestsTo(BOARDS_URL)[0]!).authorization).toBeUndefined();
  });

  it("is omitted when the stored token is an empty string", async () => {
    // `saveSession(res.token, ...)` in the legacy ProfileMenu path stores "" for
    // a cookie session; `Bearer ` with no token is worse than no header.
    store["lucent.token"] = "";
    await boards.listBoards(ORG);
    expect(headersOf(requestsTo(BOARDS_URL)[0]!).authorization).toBeUndefined();
  });

  it("does not reach the server at all when signed out", async () => {
    delete store["lucent.token"];
    delete store["lucent.user"];
    expect(await boards.listBoards(ORG)).toEqual([]);
    expect(await boards.saveBoard(ORG, "b", ws)).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

/* --------------------------- mint, rotate, self-heal ---------------------- */

describe("csrf token lifecycle", () => {
  it("mints once and reuses the token across calls", async () => {
    await boards.saveBoard(ORG, "b", ws);
    await boards.fetchRealtimeTicket();
    // The pair was warmed in beforeEach; nothing should mint again.
    expect(requestsTo("/api/auth/csrf")).toHaveLength(0);
    expect(headersOf(requestsTo("/api/realtime/ticket")[0]!)[CSRF_HEADER]).toBe("csrf-1");
  });

  it("shares one mint between parallel callers", async () => {
    invalidateCsrfToken();
    const [a, b] = await Promise.all([getCsrfToken(), getCsrfToken()]);
    expect(a).toBe(b);
    // Two mints would leave one caller holding a token whose cookie the other
    // mint has already replaced.
    expect(requestsTo("/api/auth/csrf")).toHaveLength(1);
  });

  it("sends the call without a header rather than blocking on a mint", async () => {
    invalidateCsrfToken();
    await boards.fetchRealtimeTicket();
    // No token yet: the request still goes out (a client with no session cookie
    // needs no pair at all), and the 403 path below is what recovers.
    const first = requestsTo("/api/realtime/ticket")[0]!;
    expect(headersOf(first)[CSRF_HEADER]).toBeUndefined();
  });

  it("mints and replays exactly once when the server rejects the pair", async () => {
    let posts = 0;
    stubFetch((url) => {
      if (url !== "/api/realtime/ticket") return undefined;
      posts += 1;
      return posts === 1
        ? json({ error: "csrf rejected", reason: "missing" }, 403)
        : json(ANY_BODY);
    });
    calls = [];

    expect(await boards.fetchRealtimeTicket()).toBe("tkt_1");
    const sent = requestsTo("/api/realtime/ticket");
    expect(sent).toHaveLength(2);
    // The stale token is thrown away, a fresh pair minted, and the replay
    // carries the new token - not the one the server just refused.
    expect(headersOf(sent[0]!)[CSRF_HEADER]).toBe("csrf-1");
    expect(requestsTo("/api/auth/csrf")).toHaveLength(1);
    expect(headersOf(sent[1]!)[CSRF_HEADER]).toBe("csrf-2");
  });

  it("does not replay an ordinary 403", async () => {
    stubFetch((url) =>
      url === "/api/boards/brd_1/share" ? json({ error: "not the owner" }, 403) : undefined,
    );
    calls = [];
    expect(await boards.createShareLink("brd_1", "editor")).toBeNull();
    // A permission denial is not a CSRF failure: replaying it would double the
    // request and mask the real answer.
    expect(requestsTo("/api/boards/brd_1/share")).toHaveLength(1);
    expect(requestsTo("/api/auth/csrf")).toHaveLength(0);
  });

  it("gives up after one replay instead of looping", async () => {
    stubFetch((url) =>
      url === "/api/realtime/ticket" ? json({ error: "csrf rejected" }, 403) : undefined,
    );
    calls = [];
    expect(await boards.fetchRealtimeTicket()).toBeNull();
    expect(requestsTo("/api/realtime/ticket")).toHaveLength(2);
  });

  it("rotates the pair when the session changes", async () => {
    await session.attemptLogin("a@b.c", "password123");
    // Login is a privilege change: the token minted before it is dropped and a
    // fresh one warmed in the background, so the next mutating call does not pay
    // for the 403 path. Awaiting the warm mint is what a real user's think time
    // does for free.
    expect(requestsTo("/api/auth/csrf")).toHaveLength(1);
    await getCsrfToken();
    calls = [];
    await boards.fetchRealtimeTicket();
    expect(headersOf(requestsTo("/api/realtime/ticket")[0]!)[CSRF_HEADER]).toBe("csrf-2");
  });

  it("survives a mint the server refuses", async () => {
    invalidateCsrfToken();
    stubFetch((url) => (url === "/api/auth/csrf" ? json({ error: "nope" }, 500) : undefined));
    calls = [];
    expect(await getCsrfToken()).toBeNull();
    // A bogus token would pin every later call to a pair that can never verify.
    expect(await boards.saveBoard(ORG, "b", ws)).not.toBeNull();
  });
});

/* --------------------------- pure header construction --------------------- */

describe("buildHeaders", () => {
  const creds = { csrfToken: "csrf_x", bearer: "bearer_x" };

  it("adds the CSRF header only to mutating requests", () => {
    expect(buildHeaders({ method: "POST" }, creds)[CSRF_HEADER]).toBe("csrf_x");
    expect(buildHeaders({ method: "delete" }, creds)[CSRF_HEADER]).toBe("csrf_x");
    expect(buildHeaders({}, creds)[CSRF_HEADER]).toBeUndefined();
    expect(buildHeaders({ method: "GET" }, creds)[CSRF_HEADER]).toBeUndefined();
  });

  it("omits the CSRF header when there is no token to send", () => {
    expect(buildHeaders({ method: "POST" }, { csrfToken: null, bearer: null })).toEqual({});
  });

  it("defaults content-type for a string body only", () => {
    expect(buildHeaders({ method: "POST", body: "{}" }, creds)["content-type"]).toBe(
      "application/json",
    );
    // A URLSearchParams / FormData / Blob body must keep the content-type the
    // platform generates, boundary included.
    const form = buildHeaders({ method: "POST", body: new URLSearchParams("a=b") }, creds);
    expect(form["content-type"]).toBeUndefined();
  });

  it("keeps a caller's own headers and lowercases the keys", () => {
    const out = buildHeaders(
      { method: "POST", body: "{}", headers: { "Content-Type": "text/plain", "X-Trace": "t1" } },
      creds,
    );
    expect(out["content-type"]).toBe("text/plain");
    expect(out["x-trace"]).toBe("t1");
  });

  it("never overwrites an explicit authorization header", () => {
    const out = buildHeaders({ headers: { Authorization: "Bearer other" } }, creds);
    expect(out.authorization).toBe("Bearer other");
  });

  it("accepts every HeadersInit shape", () => {
    expect(buildHeaders({ headers: new Headers({ "X-A": "1" }) }, creds)["x-a"]).toBe("1");
    expect(buildHeaders({ headers: [["X-B", "2"]] }, creds)["x-b"]).toBe("2");
    expect(buildHeaders({ headers: { "X-C": "3" } }, creds)["x-c"]).toBe("3");
  });
});

describe("buildRequestInit", () => {
  it("always includes credentials and preserves the rest of the init", () => {
    const signal = new AbortController().signal;
    const out = buildRequestInit(
      { method: "POST", body: "{}", signal },
      {
        csrfToken: "c",
        bearer: null,
      },
    );
    expect(out.credentials).toBe("include");
    expect(out.method).toBe("POST");
    expect(out.body).toBe("{}");
    expect(out.signal).toBe(signal);
  });
});

describe("apiFetch", () => {
  it("passes the URL and init through untouched apart from auth", async () => {
    await apiFetch("/api/anything", { method: "PUT", body: "x" });
    const record = requestsTo("/api/anything")[0]!;
    expect(record.init.method).toBe("PUT");
    expect(record.init.body).toBe("x");
    expect(headersOf(record)[CSRF_HEADER]).toBe("csrf-1");
  });
});

/* --------------------------- the login defect itself ---------------------- */

describe("a successful login leaves a usable session", () => {
  it("persists a cookie-only login and keeps talking to the server", async () => {
    delete store["lucent.token"];
    delete store["lucent.user"];
    stubFetch((url) =>
      url === "/api/auth/login"
        ? json({ user: { id: "u1", email: "a@b.c", name: "Ann" }, memberships: [] })
        : undefined,
    );
    calls = [];

    const result = await session.attemptLogin("a@b.c", "password123");
    expect(result.kind).toBe("ok");
    // The defect: the screen posted the login and dropped the response, so
    // nothing here was true and every board call short-circuited to "offline".
    expect(session.hasSession()).toBe(true);
    expect(session.getSessionUser()?.email).toBe("a@b.c");
    // No bearer token in a cookie session - which is exactly why the old
    // `getToken()` gate turned the whole board API into a no-op.
    expect(session.getToken()).toBeNull();
    await boards.listBoards(ORG);
    expect(requestsTo(BOARDS_URL)).toHaveLength(1);
  });

  it("reports a two-factor challenge instead of claiming success", async () => {
    stubFetch((url) =>
      url === "/api/auth/login" ? json({ requires2fa: true, loginToken: "lgn_9" }) : undefined,
    );
    calls = [];
    const result = await session.attemptLogin("a@b.c", "password123");
    expect(result).toEqual({ kind: "2fa", loginToken: "lgn_9" });
  });

  it("turns a field-level signup rejection into one readable message", async () => {
    stubFetch((url) =>
      url === "/api/auth/signup"
        ? json({ error: "invalid", errors: [{ field: "password", message: "too short" }] }, 400)
        : undefined,
    );
    calls = [];
    const result = await session.attemptSignup("Ann", "a@b.c", "short");
    expect(result).toMatchObject({ kind: "error" });
    expect(result.kind === "error" && result.message).toContain("password");
  });

  it("names the Lucent server when the transport fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const result = await session.attemptLogin("a@b.c", "password123");
    expect(result.kind === "error" && result.message).toMatch(/reach the Lucent server/i);
  });
});
