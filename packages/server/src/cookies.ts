/**
 * Cookie helpers (M1).
 *
 * A small dependency-free parser/serializer because the rest of the server is
 * deliberately framework-free. The `http` module has no built-in cookie API,
 * so any session-based scheme ends up writing one of these.
 *
 * `Set-Cookie` parsing is lenient — we accept the common attribute set Lucent
 * uses and silently drop unknown ones. RFC 6265 §5.2 enumerates the standard
 * attributes; anything else is treated as opaque so a future cookie format
 * change doesn't break an old browser.
 */

export interface CookieOptions {
  /** ms until expiry, or 0 / negative for a session cookie. */
  maxAgeMs?: number;
  /** Path scope. Defaults to "/". */
  path?: string;
  /** Domain scope. Omit for host-only. */
  domain?: string;
  /** Secure flag (https only). */
  secure?: boolean;
  /** SameSite policy. Default "Lax" — required for CSRF defence in M1.2. */
  sameSite?: "Strict" | "Lax" | "None";
  /** HttpOnly flag. Default true — required so the cookie isn't readable from JS. */
  httpOnly?: boolean;
}

const COOKIE_NAME_RE = /^[\u0021-\u003A\u003C\u005D-\u007E]+$/;

/**
 * Serialize a single `Set-Cookie` header value. Always escapes characters
 * forbidden in a name (RFC 6265 §4.1.1) and refuses values that include a
 * `;` or whitespace without quoting — those would truncate the attribute set.
 */
export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  if (!COOKIE_NAME_RE.test(name)) {
    throw new Error(`invalid cookie name: ${JSON.stringify(name)}`);
  }
  // eslint-disable-next-line no-control-regex -- rejecting control characters is exactly what this check is for
  if (/[\u0000-\u001F\u007F]/.test(value)) {
    throw new Error("cookie value contains a control character");
  }
  const parts: string[] = [`${name}=${value}`];
  if (options.maxAgeMs !== undefined) {
    if (options.maxAgeMs > 0) {
      parts.push(`Max-Age=${Math.floor(options.maxAgeMs / 1000)}`);
    }
  }
  parts.push(`Path=${options.path ?? "/"}`);
  if (options.domain) parts.push(`Domain=${options.domain}`);
  if (options.secure ?? true) parts.push("Secure");
  parts.push(`SameSite=${options.sameSite ?? "Lax"}`);
  if (options.httpOnly ?? true) parts.push("HttpOnly");
  return parts.join("; ");
}

/**
 * A clearing `Set-Cookie` header — same name, empty value, `Max-Age=0`. The
 * browser removes the cookie immediately on receipt.
 */
export function clearCookie(name: string, path: string = "/"): string {
  const parts = [`${name}=`, "Max-Age=0", `Path=${path}`, "SameSite=Lax", "HttpOnly"];
  // Note: omit Secure here so a dev cookie (http://localhost) also clears.
  // Production cookies set Secure on creation; browsers match by name+path
  // regardless of the Secure attribute, so this still clears them.
  return parts.join("; ");
}

export interface ParsedCookie {
  name: string;
  value: string;
}

/**
 * Parse a `Cookie:` header value. Returns the parsed cookies in declaration
 * order; duplicates are kept (last write wins on the consumer side).
 */
export function parseCookies(header: string | undefined | null): ParsedCookie[] {
  if (!header) return [];
  // RFC 6265 says the separator is `; ` but some clients use `;`. Split on
  // `;`, trim each piece, and only accept entries that look like `name=value`.
  return header
    .split(";")
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((piece) => {
      const eq = piece.indexOf("=");
      if (eq === -1) return null;
      const name = piece.slice(0, eq).trim();
      const value = piece.slice(eq + 1).trim();
      if (!name) return null;
      return { name, value };
    })
    .filter((c): c is ParsedCookie => c !== null);
}

/** Convenience: extract the first cookie with a given name, or undefined. */
export function getCookie(cookies: ParsedCookie[], name: string): string | undefined {
  for (const c of cookies) {
    if (c.name === name) return c.value;
  }
  return undefined;
}
