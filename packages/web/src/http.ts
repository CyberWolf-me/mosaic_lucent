import { getToken } from "./session.js";

/**
 * The single fetch wrapper every client -> Lucent API call goes through (M1.2).
 *
 * Why one wrapper and not a header block per call site: the server
 * authenticates browsers with the httpOnly `lucent_session` cookie and guards
 * every state-changing route with a double-submit CSRF check
 * (`packages/server/src/csrf.ts`). A call that forgets `credentials: "include"`
 * is silently unauthenticated; a mutating call that forgets the CSRF header is
 * silently 403'd. Neither failure is visible in the code — it shows up as "the
 * product stopped working after login", which is exactly what happened when
 * `/api/generate` and `/api/image` were written without the header. So the
 * headers are built in one place, covered by one regression test that walks
 * every mutating call the client can make.
 *
 * Note the deliberate import direction: this module reads the bearer token from
 * `session.ts` (a leaf localStorage read) while `session.ts` posts through
 * `apiFetch`. Neither module touches the other while it is being evaluated, so
 * the cycle is inert.
 */

/**
 * Names taken from the server, not guessed:
 *  - the guard reads `req.headers["x-csrf-token"]` (`csrf.ts` DEFAULT_HEADER,
 *    used by `requireCsrf` in `app.ts`); HTTP header names are case-insensitive.
 *  - the mint route is `GET /api/auth/csrf` (`app.ts`), which answers
 *    `{ token }` and sets the signed `lucent_csrf` cookie.
 *
 * That cookie is HttpOnly, so JS can never read the pair back out of
 * `document.cookie`: the raw token only ever arrives in the mint response,
 * which is why it is cached in module memory here.
 */
export const CSRF_HEADER = "x-csrf-token";
const CSRF_MINT_PATH = "/api/auth/csrf";

/** Methods the server's CSRF guard skips (`csrf.ts` SAFE_METHODS). */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** True when this method needs the CSRF pair. Mirrors the server's rule. */
export function isMutating(method: string | undefined): boolean {
  return !SAFE_METHODS.has((method ?? "GET").toUpperCase());
}

export interface Credentials {
  /** Raw CSRF token from the mint endpoint, or null when we have none yet. */
  csrfToken: string | null;
  /**
   * Bearer token, still legitimate for two cases: a client that does not share
   * an origin with the API (no cookie is sent) and the pre-cookie sessions
   * already sitting in users' localStorage. A cookie session does not need it,
   * but sending both is harmless — the server accepts either.
   */
  bearer: string | null;
}

/**
 * Header construction, kept pure so it can be tested exhaustively without a
 * DOM. Returns a plain lowercase-keyed object rather than a `Headers` instance
 * so a test — or a human reading a failed assertion — can see the exact bag
 * that went out; `fetch` treats header names case-insensitively either way.
 */
export function buildHeaders(init: RequestInit, creds: Credentials): Record<string, string> {
  const headers = normalizeHeaders(init.headers);
  // String bodies only: a FormData or Blob body must keep the content-type the
  // platform generates, boundary included.
  if (typeof init.body === "string" && headers["content-type"] === undefined) {
    headers["content-type"] = "application/json";
  }
  if (isMutating(init.method) && creds.csrfToken !== null) {
    headers[CSRF_HEADER] = creds.csrfToken;
  }
  // An explicit authorization from the call site wins. Nothing does that today,
  // but silently overwriting a caller's header is a nasty thing to debug.
  if (creds.bearer !== null && headers.authorization === undefined) {
    headers.authorization = `Bearer ${creds.bearer}`;
  }
  return headers;
}

/**
 * The init every Lucent API call goes out with. `credentials: "include"` is the
 * non-negotiable part: without it the session cookie is not attached when the
 * client and API are not same-origin, and every authenticated call 401s.
 */
export function buildRequestInit(init: RequestInit, creds: Credentials): RequestInit {
  return { ...init, credentials: "include", headers: buildHeaders(init, creds) };
}

function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (headers === undefined) return out;
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) {
    for (const entry of headers) {
      const key = entry[0];
      const value = entry[1];
      if (key === undefined || value === undefined) continue;
      out[key.toLowerCase()] = value;
    }
    return out;
  }
  for (const [key, value] of Object.entries(headers)) {
    out[key.toLowerCase()] = value;
  }
  return out;
}

/* --------------------------- CSRF token ----------------------------------- */

let csrfToken: string | null = null;
let csrfPromise: Promise<string | null> | null = null;

/**
 * Fetch (once) the CSRF token whose signed twin the server drops as a cookie.
 * Deduplicated: a burst of parallel mutating calls shares one mint, because
 * every mint replaces the cookie — two racing mints would leave one caller
 * holding a token whose cookie has already been overwritten.
 */
export function getCsrfToken(): Promise<string | null> {
  if (csrfToken !== null) return Promise.resolve(csrfToken);
  if (csrfPromise === null) {
    csrfPromise = mintCsrfToken();
    // Release the de-dupe slot only after the assignment above. Clearing it
    // from inside `mintCsrfToken`'s own `finally` can run *before* that
    // assignment (a synchronous throw out of `fetch`), which would pin a stale
    // resolved promise here for the life of the page. `mintCsrfToken` never
    // rejects, so this cannot produce an unhandled rejection.
    void csrfPromise.finally(() => {
      csrfPromise = null;
    });
  }
  return csrfPromise;
}

async function mintCsrfToken(): Promise<string | null> {
  try {
    const res = await fetch(CSRF_MINT_PATH, { credentials: "include" });
    if (!res.ok) return null;
    const body = (await res.json()) as { token?: unknown };
    // Cache only a real token: remembering a bogus value would pin us to a pair
    // that can never verify, and then every mutating call 403s.
    if (typeof body.token === "string" && body.token.length > 0) {
      csrfToken = body.token;
      return body.token;
    }
    return null;
  } catch {
    // No token is better than a wrong one: the call still goes out, and a
    // client with no session cookie needs no CSRF pair at all.
    return null;
  }
}

/** Which federated sign-in providers this deployment serves (M1.8). */
export interface OauthProviders {
  google: boolean;
  github: boolean;
}

/**
 * Read the provider flags off the csrf mint response. A GET, cache-safe to
 * call on every auth screen mount; an unreachable API reads as "none", which
 * renders no buttons — the same answer an unconfigured deployment gives.
 */
export async function fetchOauthProviders(): Promise<OauthProviders> {
  try {
    const res = await fetch(CSRF_MINT_PATH, { credentials: "include" });
    if (!res.ok) return { google: false, github: false };
    const body = (await res.json()) as { oauth?: Partial<OauthProviders> };
    return { google: body.oauth?.google === true, github: body.oauth?.github === true };
  } catch {
    return { google: false, github: false };
  }
}

/** The token we already hold, without going to the network for one. */
function peekCsrfToken(): string | null {
  return csrfToken;
}

/**
 * Drop the cached token so the next call mints a fresh pair. Called after a
 * privilege change (login) and when the server rejects the pair we sent.
 */
export function invalidateCsrfToken(): void {
  csrfToken = null;
}

/**
 * Warm the pair in the background. Called once at boot and again after a session
 * change, so the token is already in hand by the time the user does anything
 * that needs it. Deliberately fire-and-forget: nothing waits on it, and
 * `apiFetch` recovers on its own if a mutating call beats it.
 */
export function primeCsrfToken(): void {
  void getCsrfToken();
}

/* --------------------------- the wrapper ---------------------------------- */

/**
 * Call our own API: session cookie attached, CSRF header on anything mutating,
 * bearer header when a legacy token session is what we have.
 *
 * One request per call in the normal case - the token is warmed at boot by
 * `primeCsrfToken`, so it is already in memory. Making every mutating call
 * *block* on a mint instead would put an extra request in front of every call
 * site, and would hide the request the caller actually made.
 *
 * The mint-and-replay below is the safety net that lets that be true. It fires
 * only on the server's own "csrf rejected" 403, which means the raw token was
 * missing (a mutating call beat the boot prime) or stale (another tab minted,
 * replacing the shared cookie). `requireCsrf` runs before the handler touches
 * any state, so replaying the request cannot double-apply it - and a body that
 * cannot be read twice is never replayed.
 */
export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const mutating = isMutating(init.method);
  const csrf = mutating ? peekCsrfToken() : null;
  const res = await fetch(input, buildRequestInit(init, { csrfToken: csrf, bearer: getToken() }));

  if (!mutating || res.status !== 403 || !canReplay(init)) return res;
  if (!(await isCsrfRejection(res))) return res;

  // Only discard a token the server actually refused; when we sent none, a token
  // some concurrent call has minted meanwhile is exactly what we want.
  if (csrf !== null) invalidateCsrfToken();
  const fresh = await getCsrfToken();
  if (fresh === null || fresh === csrf) return res;
  return fetch(input, buildRequestInit(init, { csrfToken: fresh, bearer: getToken() }));
}

/** A stream body cannot be sent twice, so such a request is never replayed. */
function canReplay(init: RequestInit): boolean {
  return init.body === undefined || init.body === null || typeof init.body === "string";
}

/**
 * Tell the CSRF guard's 403 apart from an ordinary permission denial. Reads a
 * clone so the caller still receives an unconsumed body.
 */
async function isCsrfRejection(res: Response): Promise<boolean> {
  if (typeof res.clone !== "function") return false;
  try {
    const body = (await res.clone().json()) as { error?: unknown };
    return body.error === "csrf rejected";
  } catch {
    return false;
  }
}
