import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ROUTE_PATHS,
  decideScreen,
  normalizePath,
  parseRoute,
  tokenFromSearch,
  type Route,
  type Screen,
} from "../src/routes.js";
import {
  checkSession,
  resolveAuthStatus,
  type AuthStatus,
  type SessionCheck,
} from "../src/session.js";

/**
 * Path routing and the auth gate (M1).
 *
 * Both defects these cover were invisible in the code and obvious in use: the
 * app switched screens only on workspace view state, so `/verify?token=`,
 * `/reset?token=` and `/invite?token=` all landed on the canvas with the token
 * ignored - every email the server sends was a dead end. And the gate tested
 * only for "anon", so while `/api/auth/me` was in flight a signed-out visitor
 * got the authenticated shell.
 *
 * The logic is pure so it can be tested exhaustively without a DOM: no jsdom or
 * happy-dom is installed in this repo (see the report).
 */

describe("normalizePath", () => {
  it("folds trailing slashes, case and index.html", () => {
    expect(normalizePath("/login")).toBe("/login");
    expect(normalizePath("/login/")).toBe("/login");
    expect(normalizePath("/LOGIN")).toBe("/login");
    expect(normalizePath("/Reset//")).toBe("/reset");
    expect(normalizePath("/index.html")).toBe("/");
    expect(normalizePath("/")).toBe("/");
    expect(normalizePath("")).toBe("/");
  });
});

describe("tokenFromSearch", () => {
  it("reads the token an email link carries", () => {
    expect(tokenFromSearch("?token=abc")).toBe("abc");
    expect(tokenFromSearch("token=abc")).toBe("abc");
    expect(tokenFromSearch("?foo=1&token=abc&bar=2")).toBe("abc");
    expect(tokenFromSearch("?token=a%2Bb")).toBe("a+b");
  });

  it("treats a missing or blank token as absent", () => {
    // A mail client that rewrites the link into `?token=` must land on "this
    // link is invalid", not post an empty token to the server.
    expect(tokenFromSearch("")).toBeNull();
    expect(tokenFromSearch("?token=")).toBeNull();
    expect(tokenFromSearch("?token=%20")).toBeNull();
    expect(tokenFromSearch("?other=x")).toBeNull();
  });

  it("can read another parameter", () => {
    expect(tokenFromSearch("?invite=inv_1", "invite")).toBe("inv_1");
  });
});

describe("parseRoute", () => {
  const cases: Array<[string, string, Route]> = [
    ["/", "", { kind: "app" }],
    ["/login", "", { kind: "login" }],
    ["/signup", "", { kind: "signup" }],
    ["/reset", "", { kind: "reset-request" }],
    ["/reset", "?token=rst_1", { kind: "reset-confirm", token: "rst_1" }],
    ["/verify", "?token=vrf_1", { kind: "verify", token: "vrf_1" }],
    ["/verify", "", { kind: "verify", token: null }],
    ["/invite", "?token=inv_1", { kind: "invite", token: "inv_1" }],
    ["/invite", "", { kind: "invite", token: null }],
    // Board share links hang off whatever path the app is on and are handled by
    // the workspace, not here.
    ["/", "?board=brd_1&invite=shr_1", { kind: "app" }],
    ["/anything/else", "", { kind: "app" }],
  ];

  for (const [pathname, search, expected] of cases) {
    it(`${pathname}${search} -> ${expected.kind}`, () => {
      expect(parseRoute(pathname, search)).toEqual(expected);
    });
  }

  it("covers every path the emails link to", () => {
    // The server builds `/verify`, `/reset` and `/invite` links in
    // `packages/server/src/email/templates.ts`; each must parse to a real route.
    for (const path of ROUTE_PATHS) {
      expect(parseRoute(path, "?token=t").kind).not.toBe("app");
    }
  });
});

/* --------------------------- the gate ------------------------------------- */

describe("decideScreen", () => {
  const ROUTES: Route[] = [
    { kind: "app" },
    { kind: "login" },
    { kind: "signup" },
    { kind: "reset-request" },
    { kind: "reset-confirm", token: "rst_1" },
    { kind: "verify", token: "vrf_1" },
    { kind: "invite", token: "inv_1" },
  ];
  const STATUSES: AuthStatus[] = ["loading", "authed", "anon"];

  /** Every route x every status, spelled out. */
  const TABLE: Record<string, Screen> = {
    "app/loading": { kind: "loading" },
    "app/authed": { kind: "app" },
    "app/anon": { kind: "auth", mode: "login" },
    "login/loading": { kind: "loading" },
    "login/authed": { kind: "app" },
    "login/anon": { kind: "auth", mode: "login" },
    "signup/loading": { kind: "loading" },
    "signup/authed": { kind: "app" },
    "signup/anon": { kind: "auth", mode: "signup" },
    "reset-request/loading": { kind: "loading" },
    "reset-request/authed": { kind: "app" },
    "reset-request/anon": { kind: "auth", mode: "reset" },
    // No session needed to redeem an emailed token, so no spinner either.
    "reset-confirm/loading": { kind: "reset-confirm", token: "rst_1" },
    "reset-confirm/authed": { kind: "reset-confirm", token: "rst_1" },
    "reset-confirm/anon": { kind: "reset-confirm", token: "rst_1" },
    "verify/loading": { kind: "verify", token: "vrf_1" },
    "verify/authed": { kind: "verify", token: "vrf_1" },
    "verify/anon": { kind: "verify", token: "vrf_1" },
    // Accepting an invite does need a session; the token stays in the URL while
    // the visitor signs in.
    "invite/loading": { kind: "loading" },
    "invite/authed": { kind: "invite", token: "inv_1" },
    "invite/anon": { kind: "auth", mode: "login" },
  };

  for (const route of ROUTES) {
    for (const auth of STATUSES) {
      it(`${route.kind} + ${auth}`, () => {
        expect(decideScreen(route, auth)).toEqual(TABLE[`${route.kind}/${auth}`]);
      });
    }
  }

  it("never shows the workspace while the session check is in flight", () => {
    // The defect verbatim: the gate tested only `auth === "anon"`, so during the
    // check every visitor - signed out included - was served the app shell.
    for (const route of ROUTES) {
      const screen = decideScreen(route, "loading");
      expect(screen.kind).not.toBe("app");
    }
  });

  it("has a row for every route and status combination", () => {
    expect(Object.keys(TABLE)).toHaveLength(ROUTES.length * STATUSES.length);
  });
});

describe("resolveAuthStatus", () => {
  it("is loading until the check answers", () => {
    expect(resolveAuthStatus(null, false)).toBe("loading");
    expect(resolveAuthStatus(null, true)).toBe("loading");
  });

  it("trusts the server when it answers", () => {
    const user = { id: "u1", email: "a@b.c", name: "Ann" };
    expect(resolveAuthStatus({ kind: "authed", user }, false)).toBe("authed");
    expect(resolveAuthStatus({ kind: "anon" }, true)).toBe("anon");
  });

  it("keeps a known session when the server is unreachable", () => {
    // A stopped backend is not a signed-out user: bouncing them to the login
    // screen would also lock them out of the offline localStorage flow.
    expect(resolveAuthStatus({ kind: "unreachable" }, true)).toBe("authed");
    expect(resolveAuthStatus({ kind: "unreachable" }, false)).toBe("anon");
  });
});

/* --------------------------- checkSession --------------------------------- */

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

beforeEach(() => {
  store["lucent.token"] = "bearer_1";
  store["lucent.user"] = JSON.stringify({ id: "u1", email: "a@b.c", name: "Ann" });
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete store["lucent.token"];
  delete store["lucent.user"];
});

function respond(status: number, body: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
      ),
    ),
  );
}

describe("checkSession", () => {
  it("returns the user and refreshes the cache on 200", async () => {
    respond(200, { user: { id: "u2", email: "b@b.c", name: "Bo" }, memberships: [] });
    const check = await checkSession();
    expect(check).toEqual({ kind: "authed", user: { id: "u2", email: "b@b.c", name: "Bo" } });
    // The synchronous readers (`ui/Chrome.tsx`, `ui/Settings.tsx`) read this.
    expect(JSON.parse(store["lucent.user"]!).email).toBe("b@b.c");
    // A cookie session has no bearer token; refreshing the user must not drop
    // the one a legacy session still has.
    expect(store["lucent.token"]).toBe("bearer_1");
  });

  it("forgets a dead credential on 401", async () => {
    respond(401, { error: "unauthorized" });
    expect(await checkSession()).toEqual({ kind: "anon" });
    expect(store["lucent.token"]).toBeUndefined();
    expect(store["lucent.user"]).toBeUndefined();
  });

  it("reports unreachable - not signed out - on a server error", async () => {
    respond(500, { error: "boom" });
    expect(await checkSession()).toEqual({ kind: "unreachable" });
    expect(store["lucent.user"]).toBeDefined();
  });

  it("reports unreachable when the transport fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    expect(await checkSession()).toEqual({ kind: "unreachable" });
    expect(store["lucent.user"]).toBeDefined();
  });

  it("reports unreachable when the body is not a usable user", async () => {
    respond(200, { user: { id: "u1" } });
    // A half-shaped user would render as a blank account menu; treat it as "don't
    // know" rather than signing someone in with no name or email.
    expect(await checkSession()).toEqual({ kind: "unreachable" });
  });
});

describe("the check and the gate together", () => {
  const cases: Array<[SessionCheck, boolean, AuthStatus]> = [
    [{ kind: "authed", user: { id: "u1", email: "a@b.c", name: "Ann" } }, true, "authed"],
    [{ kind: "anon" }, false, "anon"],
    [{ kind: "unreachable" }, true, "authed"],
    [{ kind: "unreachable" }, false, "anon"],
  ];
  for (const [check, cached, expected] of cases) {
    it(`${check.kind} + cached=${cached} -> ${expected}`, () => {
      expect(resolveAuthStatus(check, cached)).toBe(expected);
    });
  }
});
