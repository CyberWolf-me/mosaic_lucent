import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

/**
 * Password hashing and stateless session tokens (docs/06 security).
 *
 * Dependency-free on purpose: scrypt for passwords and an HMAC-signed token for
 * sessions, both from node:crypto. No JWT library, no bcrypt native build. This
 * is deliberately modest — a real deployment behind TLS with a persistent secret
 * — not a claim to have solved auth for every threat model. The signing secret
 * comes from the environment; a random one is generated for dev, which means
 * tokens don't survive a restart, and that is the correct dev behaviour.
 */

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: string,
  keylen: number,
) => Promise<Buffer>;
const SCRYPT_KEYLEN = 64;

/** Hash a password as `salt:hash`, both hex. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const hash = (await scrypt(password, salt, SCRYPT_KEYLEN)).toString("hex");
  return `${salt}:${hash}`;
}

/** Constant-time verification against a stored `salt:hash`. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, "hex");
  const actual = await scrypt(password, salt, SCRYPT_KEYLEN);
  // Lengths must match for timingSafeEqual; a mismatch is simply a failure.
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export interface TokenPayload {
  userId: string;
  /** Issued-at, seconds. */
  iat: number;
  /** Expiry, seconds. */
  exp: number;
  /**
   * The user's `tokenVersion` when this token was minted. Absent on tokens
   * issued before the field existed. The bearer-auth path compares it to the
   * live row, so `bumpTokenVersion` — "sign out everywhere", logout, a
   * password reset — invalidates outstanding bearer tokens without a
   * session store to enumerate. Without this field there is nothing to
   * compare and a stateless token could only ever expire.
   */
  ver?: number;
}

const base64url = (buf: Buffer) =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const fromBase64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

/**
 * Sign a session token: `base64url(payload).base64url(hmac)`. Compact, stateless,
 * and verifiable without a session store — the tradeoff is that it can't be
 * revoked before expiry, which is acceptable for short-lived tokens.
 */
export function issueToken(
  userId: string,
  secret: string,
  ttlSeconds = 7 * 24 * 3600,
  tokenVersion = 0,
): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: TokenPayload = { userId, iat: now, exp: now + ttlSeconds, ver: tokenVersion };
  const body = base64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = base64url(createHmac("sha256", secret).update(body).digest());
  return `${body}.${sig}`;
}

/** Verify a token's signature and expiry; returns the payload or null. */
export function verifyToken(
  token: string,
  secret: string,
  now: number = Date.now(),
): TokenPayload | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;

  const expectedSig = base64url(createHmac("sha256", secret).update(body).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let payload: TokenPayload;
  try {
    payload = JSON.parse(fromBase64url(body).toString("utf8")) as TokenPayload;
  } catch {
    return null;
  }
  if (typeof payload.userId !== "string" || typeof payload.exp !== "number") return null;
  if (payload.exp * 1000 < now) return null;
  return payload;
}

/** Pull a bearer token out of an Authorization header. */
export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1]!.trim() : null;
}
