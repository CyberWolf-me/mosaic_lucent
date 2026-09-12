import type { AuthStatus } from "./session.js";

/**
 * Path-based routing, hand-rolled (M1).
 *
 * The app used to switch screens purely on workspace `view` state, so every link
 * in an email - `/verify?token=`, `/reset?token=`, `/invite?token=` - landed on
 * the canvas with the token ignored. This module maps `location.pathname` +
 * `location.search` onto a small Route union, and `decideScreen` folds the route
 * together with the auth status into the one screen to render.
 *
 * No router dependency on purpose: five paths, one `popstate` listener, and the
 * parsing kept pure so it is testable without a DOM. The server already serves
 * index.html for unknown non-asset paths (`server/src/static.ts`), which is what
 * makes a deep link work on a cold load.
 */

export type Route =
  | { kind: "app" }
  | { kind: "login" }
  | { kind: "signup" }
  /** `/reset` with no token: the "email me a link" form. */
  | { kind: "reset-request" }
  /** `/reset?token=`: the "pick a new password" form. */
  | { kind: "reset-confirm"; token: string }
  | { kind: "verify"; token: string | null }
  | { kind: "invite"; token: string | null };

/** Paths this module owns. Anything else is the workspace. */
export const ROUTE_PATHS = ["/login", "/signup", "/reset", "/verify", "/invite"] as const;

/**
 * Where the server sends a customer who hit a plan limit: DEFAULT_UPGRADE_URL
 * in packages/server/src/entitlements.ts, which every 402 body carries as
 * upgradeUrl. Deliberately not in ROUTE_PATHS -- there is no shell-level billing
 * screen, only a pane inside the settings modal -- so App.tsx consumes the path
 * on mount rather than parseRoute answering with a screen that does not exist.
 * The two strings have to agree; this is the one place the web half spells it.
 */
export const UPGRADE_PATH = "/settings/billing";

/**
 * Fold the cosmetic differences between equivalent paths (trailing slash, case,
 * an explicit index.html) so `parseRoute` can be a plain switch.
 */
export function normalizePath(pathname: string): string {
  let path = pathname.toLowerCase();
  if (path.endsWith("/index.html")) path = path.slice(0, -"index.html".length);
  if (path.length > 1 && path.endsWith("/")) path = path.replace(/\/+$/, "");
  return path.length > 0 ? path : "/";
}

/**
 * Pull a single-use token out of a query string. Empty is treated as absent: a
 * mail client that rewrites the link into `?token=` should show the "link is
 * invalid" screen, not post an empty token to the server.
 */
export function tokenFromSearch(search: string, key = "token"): string | null {
  const value = new URLSearchParams(search).get(key);
  return value !== null && value.trim().length > 0 ? value : null;
}

export function parseRoute(pathname: string, search: string): Route {
  switch (normalizePath(pathname)) {
    case "/login":
      return { kind: "login" };
    case "/signup":
      return { kind: "signup" };
    case "/reset": {
      const token = tokenFromSearch(search);
      return token !== null ? { kind: "reset-confirm", token } : { kind: "reset-request" };
    }
    case "/verify":
      return { kind: "verify", token: tokenFromSearch(search) };
    case "/invite":
      return { kind: "invite", token: tokenFromSearch(search) };
    default:
      // Unknown paths are the workspace, not a 404: the canvas is the product,
      // and `?board=`/`?invite=` share links hang off whatever path it is on.
      return { kind: "app" };
  }
}

/* --------------------------- screen decision ------------------------------ */

/** What `App` should actually render. */
export type Screen =
  | { kind: "loading" }
  | { kind: "auth"; mode: "login" | "signup" | "reset" }
  | { kind: "reset-confirm"; token: string }
  | { kind: "verify"; token: string | null }
  | { kind: "invite"; token: string | null }
  | { kind: "app" };

/**
 * The single place that decides what a visitor sees. Pure, so every combination
 * of route and auth status is a table row in `test/routes.test.ts`.
 *
 * Three rules worth stating:
 *  - `loading` is never skipped for the workspace. Rendering the shell while
 *    `/api/auth/me` is still in flight flashed the authenticated UI at
 *    signed-out visitors.
 *  - `/verify` and `/reset?token=` render immediately whatever the auth status,
 *    because redeeming an email token needs no session - gating them behind the
 *    check only adds a spinner to a link that already works.
 *  - `/invite` does need a session, so a signed-out visitor gets the sign-in
 *    screen with the token left in the address bar; accepting resumes once they
 *    are in.
 */
export function decideScreen(route: Route, auth: AuthStatus): Screen {
  switch (route.kind) {
    case "reset-confirm":
      return { kind: "reset-confirm", token: route.token };
    case "verify":
      return { kind: "verify", token: route.token };
    case "invite":
      if (auth === "loading") return { kind: "loading" };
      return auth === "authed"
        ? { kind: "invite", token: route.token }
        : { kind: "auth", mode: "login" };
    case "login":
    case "signup":
    case "reset-request":
      if (auth === "loading") return { kind: "loading" };
      // Already signed in: the sign-in form would be a dead end. `App` cleans
      // the path so a reload doesn't come back here.
      if (auth === "authed") return { kind: "app" };
      return { kind: "auth", mode: route.kind === "reset-request" ? "reset" : route.kind };
    case "app":
      if (auth === "loading") return { kind: "loading" };
      return auth === "authed" ? { kind: "app" } : { kind: "auth", mode: "login" };
  }
}

/* --------------------------- browser plumbing ----------------------------- */

/** Read the live route. Guarded so an SSR/test import can't crash on `window`. */
export function currentRoute(): Route {
  if (typeof window === "undefined") return { kind: "app" };
  return parseRoute(window.location.pathname, window.location.search);
}

/**
 * Push a path and tell subscribers. `pushState` deliberately does not fire
 * `popstate`, so we dispatch one: that keeps `App` on a single listener for both
 * in-app navigation and the browser's own Back button.
 */
export function navigate(path: string): void {
  if (typeof window === "undefined") return;
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/** Rewrite the current entry - used to drop a consumed token from the URL. */
export function replacePath(path: string): void {
  if (typeof window === "undefined") return;
  window.history.replaceState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/**
 * Strip a single-use token from the address bar without adding a history entry.
 * The tokens in these links are credentials; leaving one visible turns a
 * one-time email link into something forwardable (and re-submittable on reload).
 */
export function clearTokenFromUrl(): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (!url.searchParams.has("token")) return;
  url.searchParams.delete("token");
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
}

export function subscribeToRoute(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("popstate", listener);
  return () => window.removeEventListener("popstate", listener);
}

/* ------------------------- view/lens query (UX-1) ------------------------- */

/**
 * View/lens share the address bar with capability tokens (`?board=`, `?invite=`,
 * `?token=`). These helpers read/write only `view`/`lens`, preserving every
 * other param. Writes use `replaceState` (no history entry) so Back keeps
 * working; they never dispatch `popstate`, so the write-back effect in App.tsx
 * cannot loop with the route listener.
 */
export function getViewQuery(): { view?: string; lens?: string } {
  if (typeof window === "undefined") return {};
  const params = new URLSearchParams(window.location.search);
  const view = params.get("view");
  const lens = params.get("lens");
  return {
    ...(view && view.trim().length > 0 ? { view } : {}),
    ...(lens && lens.trim().length > 0 ? { lens } : {}),
  };
}

export function setViewQuery(view: string, lens?: string): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (view && view.trim().length > 0) url.searchParams.set("view", view);
  else url.searchParams.delete("view");
  if (lens && lens.trim().length > 0) url.searchParams.set("lens", lens);
  else url.searchParams.delete("lens");
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
}
