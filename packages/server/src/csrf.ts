import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * CSRF defence (M1.2).
 *
 * Browsers authenticate with the `lucent_session` cookie, which the browser
 * attaches to every same-site request, including cross-origin form posts.
 * SameSite=Lax stops the obvious case (third-party <form>) but does nothing
 * for top-level navigations or for any future cross-origin XHR — so the
 * defence-in-depth is a double-submit token: a second cookie (`lucent_csrf`)
 * holds a value the browser cannot read (httpOnly + a non-JS-readable name);
 * the client puts the same value into an `X-CSRF-Token` header on every
 * state-changing request, and the middleware compares them.
 *
 * The Origin check runs first and short-circuits with 403 when the request's
 * `Origin` header isn't on the allow-list. State-changing requests without
 * an Origin (server-to-server) bypass both checks and fall through to
 * bearer-auth-only — that's how the MCP client keeps working.
 */

export interface CsrfConfig {
  /** The CSRF cookie name. Default "lucent_csrf". */
  cookieName?: string;
  /** The header the browser sends back. Default "x-csrf-token". */
  headerName?: string;
  /** Same origin(s) the browser is allowed to come from. */
  allowedOrigins: string[];
  /** HMAC secret used to sign the token cookie value. */
  secret: string;
}

export interface CsrfResult {
  /** True when the request is allowed to proceed. */
  ok: boolean;
  /** Why a request was rejected. Empty when ok. */
  reason?: "origin" | "missing-header" | "missing-cookie" | "mismatch";
}

const DEFAULT_COOKIE = "lucent_csrf";
const DEFAULT_HEADER = "x-csrf-token";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Compare a CSRF cookie value against a header value. The cookie is signed
 * (HMAC of the random token); the header carries the raw token. A valid pair
 * proves the request is same-origin: only JS on our origin could have read
 * the cookie to echo it as a header.
 *
 * Scope: CSRF only fires when the request is authenticated via a session
 * cookie. A request that carries the `lucent_session` cookie is presumed to
 * be a browser; a request that doesn't is presumed to be programmatic
 * (MCP client, API key) and bypasses the check. The session-cookie presence
 * is passed in by the caller so this module stays HTTP-header agnostic.
 */
export function verifyCsrf(
  config: CsrfConfig,
  method: string,
  origin: string | undefined,
  cookieHeader: string | undefined,
  headerValue: string | undefined,
  /** True when the request already carries the session cookie. */
  hasSessionCookie: boolean,
): CsrfResult {
  if (SAFE_METHODS.has(method.toUpperCase())) return { ok: true };
  // Programmatic clients don't carry the session cookie; the bearer path is
  // their only authentication. Letting them through keeps MCP working.
  if (!hasSessionCookie) return { ok: true };

  // Origin check first — covers the simple case where the browser auto-fills
  // Origin on a cross-origin form POST. Browsers always send Origin on
  // state-changing requests, so a present-but-wrong Origin is unambiguous.
  if (origin !== undefined) {
    if (!config.allowedOrigins.includes(origin)) {
      return { ok: false, reason: "origin" };
    }
  }

  const cookieName = config.cookieName ?? DEFAULT_COOKIE;
  const _headerName = config.headerName ?? DEFAULT_HEADER;
  const cookie = extractCookie(cookieHeader ?? "", cookieName);
  const header = (headerValue ?? "").trim();

  if (cookie === null) return { ok: false, reason: "missing-cookie" };
  if (header.length === 0) return { ok: false, reason: "missing-header" };
  if (!timingSafeStringEqual(cookie, signToken(header, config.secret))) {
    return { ok: false, reason: "mismatch" };
  }
  return { ok: true };
}

/** Mint a CSRF cookie + the value the client should echo as the header. */
export function mintCsrf(config: CsrfConfig): { cookie: string; token: string } {
  const token = randomBytes(24).toString("hex");
  const signed = signToken(token, config.secret);
  const cookieName = config.cookieName ?? DEFAULT_COOKIE;
  const cookie = `${cookieName}=${signed}; Max-Age=2592000; Path=/; SameSite=Lax; HttpOnly`;
  return { cookie, token };
}

/** HMAC a random token so the cookie value is unforgeable without the secret. */
function signToken(token: string, secret: string): string {
  return createHmac("sha256", secret).update(token).digest("hex");
}

function extractCookie(header: string, name: string): string | null {
  for (const piece of header.split(";")) {
    const trimmed = piece.trim();
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) === name) return trimmed.slice(eq + 1);
  }
  return null;
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}
