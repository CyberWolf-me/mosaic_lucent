import { createHmac, randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { scrypt as scryptCb } from "node:crypto";

/**
 * TOTP per RFC 6238 (M1.6).
 *
 * Hand-rolled to keep the dependency surface small. The algorithm is small
 * (HMAC-SHA1 over an 8-byte counter, truncated to a 6-digit code) but the
 * `otplib` package on npm brings in 20-odd transitive deps and a Buffer
 * polyfill we don't need on Node 22.
 *
 * Secret format: 20 random bytes, base32-encoded without padding so an
 * authenticator-app export is straightforward. The secret is stored once at
 * enrollment; subsequent verifications compare the candidate code against
 * the current and ±1 window slots to absorb clock skew.
 *
 * The same module carries the recovery-code machinery: 10 single-use codes
 * generated at enrollment, stored as scrypt hashes (so a DB read doesn't
 * leak usable codes), each consumed by deleting the row.
 */

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: string,
  keylen: number,
) => Promise<Buffer>;

const SCRYPT_KEYLEN = 32;
const SCRYPT_SALT_LEN = 16;

/** TOTP settings pinned at the values real authenticator apps expect. */
export const TOTP_DIGITS = 6;
export const TOTP_PERIOD = 30; // seconds
export const TOTP_WINDOW = 1; // accept ±1 period

/**
 * Base32 alphabet from RFC 4648 §6. We strip "=" padding because base32
 * authenticator URIs omit it, and authenticator apps tolerate the missing pad.
 */
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Generate a new TOTP secret + the matching base32 encoding. */
export function generateTotpSecret(): { secret: Buffer; base32: string } {
  const secret = randomBytes(20);
  return { secret, base32: base32Encode(secret) };
}

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const cleaned = s.replace(/=+$/, "").toUpperCase().replace(/\s+/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`invalid base32 character: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Compute the TOTP for `secret` at Unix time `now` (default: now). */
export function totp(secret: Buffer, now: number = Math.floor(Date.now() / 1000)): string {
  const counter = Math.floor(now / TOTP_PERIOD);
  return hotp(secret, counter);
}

function hotp(secret: Buffer, counter: number): string {
  const counterBuf = Buffer.alloc(8);
  // big-endian 64-bit counter.
  let c = counter;
  for (let i = 7; i >= 0; i -= 1) {
    counterBuf[i] = c & 0xff;
    c = Math.floor(c / 256);
  }
  const hmac = createHmac("sha1", secret).update(counterBuf).digest();
  // RFC 4226 §5.3 dynamic truncation.
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  const code = binary % 10 ** TOTP_DIGITS;
  return code.toString().padStart(TOTP_DIGITS, "0");
}

/** The counter (time-step index) a Unix timestamp falls in. */
export function totpCounterAt(now: number = Math.floor(Date.now() / 1000)): number {
  return Math.floor(now / TOTP_PERIOD);
}

/**
 * Verify a candidate and report *which* time step it matched, or undefined.
 *
 * The counter is the value the caller needs to make a code single-use: RFC
 * 6238 §5.2 requires the verifier to refuse an OTP it has already accepted,
 * and the only durable way to do that is to remember the highest counter
 * accepted and reject anything at or below it. `verifyTotp` throws that
 * information away, which is why the replay guard calls this instead.
 *
 * Slots are tried oldest-first so the returned counter is deterministic on
 * the (vanishingly unlikely) chance that one code matches two steps.
 */
export function matchTotpCounter(
  secret: Buffer,
  candidate: string,
  now: number = Math.floor(Date.now() / 1000),
  window: number = TOTP_WINDOW,
): number | undefined {
  if (!/^\d{6}$/.test(candidate)) return undefined;
  const counter = totpCounterAt(now);
  for (let offset = -window; offset <= window; offset += 1) {
    if (hotp(secret, counter + offset) === candidate) return counter + offset;
  }
  return undefined;
}

/**
 * Verify a 6-digit candidate. Returns true when the candidate matches the
 * current TOTP slot, the previous, or the next (within the configured
 * window). Skew tolerance is what makes a TOTP practical on a phone whose
 * clock drifts; ±1 period is the default most authenticators use.
 *
 * Note this is the *stateless* check — it says "this code is live", not
 * "this code has not been used". Anything authenticating a user must go
 * through `matchTotpCounter` plus the stored `lastCounter` so a captured
 * code cannot be replayed inside its 30-second window.
 */
export function verifyTotp(
  secret: Buffer,
  candidate: string,
  now: number = Math.floor(Date.now() / 1000),
  window: number = TOTP_WINDOW,
): boolean {
  return matchTotpCounter(secret, candidate, now, window) !== undefined;
}

/* ─────────────────────────── Recovery codes ───────────────────────────────── */

/** The set of characters used to render recovery codes (Crockford-style, no I/L/O/0/1). */
const RECOVERY_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/** Generate `count` recovery codes, each `length` chars (default 10). */
export function generateRecoveryCodes(count: number = 10, length: number = 10): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i += 1) {
    let code = "";
    for (let j = 0; j < length; j += 1) {
      code += RECOVERY_ALPHABET[randomBytes(1)[0]! % RECOVERY_ALPHABET.length];
    }
    codes.push(code);
  }
  return codes;
}

/** Hash a recovery code with scrypt so the DB stores an opaque string. */
export async function hashRecoveryCode(code: string): Promise<string> {
  const salt = randomBytes(SCRYPT_SALT_LEN).toString("hex");
  const hash = (await scrypt(code, salt, SCRYPT_KEYLEN)).toString("hex");
  return `${salt}:${hash}`;
}

/**
 * Constant-time verification against a stored `salt:hash`. The user normally
 * types the code as a single unbroken string; we accept any grouping
 * (spaces, dashes) by stripping non-alphanumerics before comparing.
 */
export async function verifyRecoveryCode(code: string, stored: string): Promise<boolean> {
  const normalized = code.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  if (normalized.length < 8) return false;
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const { timingSafeEqual } = await import("node:crypto");
  const expected = Buffer.from(hash, "hex");
  const actual = await scrypt(normalized, salt, SCRYPT_KEYLEN);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * Authenticator-app provisioning URI (otpauth://). The frontend shows this as a
 * QR code; the secret is the only thing the QR carries, so it never leaves
 * the user's device once shown.
 */
export function otpauthUri(opts: {
  issuer: string;
  accountName: string;
  secretBase32: string;
}): string {
  const label = `${encodeURIComponent(opts.issuer)}:${encodeURIComponent(opts.accountName)}`;
  const params = new URLSearchParams({
    secret: opts.secretBase32,
    issuer: opts.issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
