/* global __ENV */
import http from "k6/http";
import { fail } from "k6";

/**
 * Shared client for the k6 profiles. Deliberately small and explicit rather
 * than a framework: a load script that hides which request it is making is
 * useless when the numbers look wrong.
 *
 * Two protocol details drive the shape of this file:
 *
 *  - CSRF is skipped entirely for requests that carry no session cookie
 *    (packages/server/src/csrf.ts), because a programmatic client's only
 *    credential is its bearer token. k6 keeps a per-VU cookie jar and would
 *    replay the `lucent_session` cookie that signup sets, which flips CSRF
 *    checking back on and 403s every later POST. We therefore do both halves:
 *    clear the jar after authenticating, and send the double-submit header
 *    anyway, so the scripts work whichever way the jar behaves.
 *  - The free plan allows 3 boards per org and there is no env override
 *    (packages/server/src/plans.ts), so anything that needs many boards has to
 *    spread them over many orgs. `ensureOrgCapacity` below does that.
 */

export const BASE = __ENV.LUCENT_BASE_URL || "http://127.0.0.1:4387";
export const WS_BASE = BASE.replace(/^http/, "ws");
/** Boards per org on the free plan. Mirrors plans.ts; used to rotate orgs. */
export const FREE_BOARDS_PER_ORG = 3;

const JSON_TYPE = { "Content-Type": "application/json" };

/** Fetch a CSRF token, or null if the endpoint is unavailable. */
function csrfToken() {
  const res = http.get(`${BASE}/api/auth/csrf`, { tags: { name: "csrf" } });
  return res.status === 200 ? res.json("token") : null;
}

/**
 * Create (or, on a rerun with the same email, log into) an account and return
 * everything the rest of a script needs.
 */
export function signIn(email, password, name) {
  const csrf = csrfToken();
  const headers = Object.assign({}, JSON_TYPE, csrf ? { "x-csrf-token": csrf } : {});
  const body = JSON.stringify({ email, password, name: name || email });
  let res = http.post(`${BASE}/api/auth/signup`, body, { headers, tags: { name: "signup" } });
  if (res.status === 409) {
    res = http.post(`${BASE}/api/auth/login`, JSON.stringify({ email, password }), {
      headers,
      tags: { name: "login" },
    });
  }
  if (res.status !== 200 && res.status !== 201) {
    fail(`auth failed (${res.status}): ${res.body}`);
  }
  // Drop the session cookie so subsequent POSTs stay on the bearer-only path.
  http.cookieJar().clear(BASE);
  const memberships = res.json("memberships");
  return {
    token: res.json("token"),
    userId: res.json("user.id"),
    orgId: memberships && memberships.length ? memberships[0].orgId : null,
    csrf,
  };
}

/** Headers for an authenticated JSON request. */
export function auth(session) {
  const h = Object.assign({}, JSON_TYPE, { Authorization: `Bearer ${session.token}` });
  if (session.csrf) h["x-csrf-token"] = session.csrf;
  return h;
}

/** Create an org and return its id. Each org buys three more free boards. */
export function createOrg(session, name) {
  const res = http.post(`${BASE}/api/orgs`, JSON.stringify({ name }), {
    headers: auth(session),
    tags: { name: "orgs" },
  });
  if (res.status !== 201) fail(`org create failed (${res.status}): ${res.body}`);
  return res.json("id");
}

/**
 * Create a board. Returns `{ id }`, or null when the plan gate refuses (402),
 * which the caller answers by rotating to a fresh org rather than by failing:
 * hitting a documented entitlement is not a load-test failure.
 */
export function createBoard(session, orgId, name, workspace) {
  const payload = { orgId, name };
  if (workspace) payload.workspace = workspace;
  const res = http.post(`${BASE}/api/boards`, JSON.stringify(payload), {
    headers: auth(session),
    tags: { name: "board-create" },
  });
  if (res.status === 402) return null;
  if (res.status !== 201) fail(`board create failed (${res.status}): ${res.body}`);
  return { id: res.json("id"), status: res.status, timings: res.timings };
}

/**
 * A realtime ticket. Single-use and short-lived (60s by default), so mint one
 * immediately before each socket rather than reusing one across iterations.
 */
export function realtimeTicket(session) {
  const res = http.post(`${BASE}/api/realtime/ticket`, null, {
    headers: auth(session),
    tags: { name: "ticket" },
  });
  if (res.status !== 200) fail(`ticket failed (${res.status}): ${res.body}`);
  return res.json("ticket");
}

/** The websocket URL for a freshly minted ticket. */
export function socketUrl(ticket) {
  return `${WS_BASE}/ws?ticket=${encodeURIComponent(ticket)}`;
}

/** A unique, stable-per-run email so a rerun logs in instead of colliding. */
export function emailFor(runId, index) {
  return `k6-${runId}-${index}@lucent-load.test`;
}

/** The password every generated account uses (min length 8 per identity.ts). */
export const PASSWORD = "load-test-password";
