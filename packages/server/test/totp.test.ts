import { describe, it, expect } from "vitest";
import {
  base32Decode,
  base32Encode,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  otpauthUri,
  matchTotpCounter,
  totp,
  totpCounterAt,
  verifyRecoveryCode,
  verifyTotp,
} from "../src/totp.js";
import {
  InMemoryPendingTwoFactorStore,
  InMemoryTotpStore,
  handleBeginTotpEnrollment,
  handleConfirmTotpEnrollment,
  handleDisableTotp,
  handleLogin,
  handleVerifyTwoFactorLogin,
  recordPendingTwoFactor,
  _clearPendingTwoFactorForTests,
  handleSignup,
  InMemorySessionStore,
  InMemoryUserStore,
  type AuthContext,
  type PendingTwoFactorStore,
} from "../src/accounts.js";
import { hashPendingToken } from "../src/totpStore.js";

/**
 * TOTP + recovery codes (M1.6).
 *
 * Properties under test:
 *   - totp() is deterministic for (secret, time) — same input, same output.
 *   - verifyTotp() accepts the current and ±1 slots.
 *   - Recovery codes are stored hashed and consumed once; bad codes don't match.
 *   - Login returns {requires2fa, loginToken} when 2FA is on, and the
 *     second-step verifier mints the same session as a password-only login.
 *   - Disabling 2FA requires a valid code (TOTP or recovery) so a stolen
 *     cookie can't quietly remove it.
 */

const SECRET = "test-secret-at-least-16-chars";

function ctx(
  opts: {
    userStore?: InMemoryUserStore;
    totp?: InMemoryTotpStore;
    sessions?: InMemorySessionStore;
    /**
     * Pinned wall clock. Every handler reads `ctx.now`, so assigning to it after
     * construction steps time forward for the whole context — which the replay
     * tests need, since a TOTP is only meaningful relative to a clock.
     */
    now?: number;
    /** Injected pending-2FA store; omitted means the process-local fallback. */
    pending?: PendingTwoFactorStore;
  } = {},
): AuthContext {
  const sessions = opts.sessions ?? new InMemorySessionStore();
  return {
    userStore: opts.userStore ?? new InMemoryUserStore(),
    secret: SECRET,
    sessionStore: sessions,
    sessionCookie: {
      name: "lucent_session",
      cookieOptions: {
        httpOnly: true,
        sameSite: "Lax",
        secure: false,
        path: "/",
        maxAgeMs: 60_000,
      },
    },
    totpStore: opts.totp ?? new InMemoryTotpStore(),
    totpIssuer: "TestCo",
    now: opts.now,
    pendingTwoFactorStore: opts.pending,
  };
}

describe("totp: RFC 6238 primitives", () => {
  it("base32 roundtrips random bytes", () => {
    const cases = [Buffer.alloc(0), Buffer.from([0xff]), Buffer.alloc(20)];
    for (const buf of cases) {
      expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true);
    }
  });

  it("generateTotpSecret returns a 20-byte secret", () => {
    const { secret, base32 } = generateTotpSecret();
    expect(secret.length).toBe(20);
    expect(base32.length).toBeGreaterThan(0);
  });

  it("totp() is deterministic for a fixed (secret, time)", () => {
    const { secret } = generateTotpSecret();
    const t = 1_700_000_000;
    expect(totp(secret, t)).toBe(totp(secret, t));
  });

  it("verifyTotp accepts the current slot and rejects the slot two periods away", () => {
    const { secret } = generateTotpSecret();
    const now = 1_700_000_000;
    const code = totp(secret, now);
    expect(verifyTotp(secret, code, now, 1)).toBe(true);
    // Two periods away falls outside the ±1 window.
    const otherCode = totp(secret, now + 120);
    expect(verifyTotp(secret, otherCode, now, 1)).toBe(false);
  });

  it("verifyTotp rejects malformed candidates", () => {
    const { secret } = generateTotpSecret();
    expect(verifyTotp(secret, "abcdef", Date.now(), 1)).toBe(false);
    expect(verifyTotp(secret, "12345", Date.now(), 1)).toBe(false);
  });

  it("matchTotpCounter reports which slot matched, which verifyTotp throws away", () => {
    const { secret } = generateTotpSecret();
    const now = 1_700_000_000;
    // The counter is the only durable way to make a code single-use, so the
    // verifier has to hand it back rather than answering yes/no.
    expect(matchTotpCounter(secret, totp(secret, now), now, 1)).toBe(totpCounterAt(now));
    expect(matchTotpCounter(secret, totp(secret, now + 30), now, 1)).toBe(totpCounterAt(now) + 1);
    expect(matchTotpCounter(secret, totp(secret, now - 30), now, 1)).toBe(totpCounterAt(now) - 1);
    expect(matchTotpCounter(secret, totp(secret, now + 120), now, 1)).toBeUndefined();
    expect(matchTotpCounter(secret, "abcdef", now, 1)).toBeUndefined();
  });

  it("otpauthUri is an otpauth://totp/ URL with the right shape", () => {
    const uri = otpauthUri({
      issuer: "Lucent",
      accountName: "a@b.co",
      secretBase32: "JBSWY3DPEHPK3PXP",
    });
    expect(uri).toMatch(/^otpauth:\/\/totp\/Lucent:a%40b\.co\?/);
    expect(uri).toContain("secret=JBSWY3DPEHPK3PXP");
    expect(uri).toContain("issuer=Lucent");
  });
});

describe("totp: recovery codes", () => {
  it("generates the requested number of codes", () => {
    expect(generateRecoveryCodes(10)).toHaveLength(10);
    expect(generateRecoveryCodes(3, 8)).toHaveLength(3);
    expect(generateRecoveryCodes(3, 8)[0]).toHaveLength(8);
  });

  it("hash + verify round-trip", async () => {
    const code = "ABCD123456";
    const stored = await hashRecoveryCode(code);
    expect(stored).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);
    expect(await verifyRecoveryCode(code, stored)).toBe(true);
    expect(await verifyRecoveryCode("WRONG", stored)).toBe(false);
  });

  it("the store consumes a code exactly once", async () => {
    // Store-level counterpart to the end-to-end replay test below: the row
    // is what makes a recovery code single-use, so the guard belongs here.
    const store = new InMemoryTotpStore();
    const codes = generateRecoveryCodes(2, 10);
    await store.addRecoveryCodes(
      await Promise.all(
        codes.map(async (code, i) => ({
          id: `rc_${i}`,
          userId: "u1",
          codeHash: await hashRecoveryCode(code),
          createdAt: 1,
          consumedAt: null,
        })),
      ),
    );
    expect(await store.tryConsumeRecoveryCode("u1", codes[0]!, verifyRecoveryCode, 10)).toBe(true);
    expect(await store.tryConsumeRecoveryCode("u1", codes[0]!, verifyRecoveryCode, 11)).toBe(false);
    expect(await store.tryConsumeRecoveryCode("u1", codes[1]!, verifyRecoveryCode, 12)).toBe(true);
    const live = await store.listRecoveryCodes("u1");
    expect(live.filter((c) => c.consumedAt === null)).toHaveLength(0);
  });

  it("verify normalizes spacing and case", async () => {
    const code = "ABCD123456";
    const stored = await hashRecoveryCode(code);
    expect(await verifyRecoveryCode("abcd-1234-56", stored)).toBe(true);
    expect(await verifyRecoveryCode("abcd123456", stored)).toBe(true);
  });
});

/**
 * Deterministic clock for the enrollment/login tests.
 *
 * TOTP is a function of time, and the replay guard banks the counter the
 * enrollment code matched. A login therefore has to happen in a *later* slot
 * than enrollment did — with the real clock that is a coin flip on where in
 * the 30-second period the test happened to start, so the clock is pinned and
 * stepped explicitly instead.
 *
 * BASE_MS is an exact multiple of the 30s period, so it is the first
 * millisecond of some counter C, and BASE_MS + STEP_MS lands inside C + 1.
 * STEP_MS is deliberately under the harness's 60s session maxAgeMs, because
 * the cookie minted at signup still has to authenticate the later requests.
 */
const BASE_MS = 1_700_000_010_000;
const STEP_MS = 45_000;

/** The code a device would display at wall-clock `ms` for `secretBase32`. */
function codeAt(secretBase32: string, ms: number): string {
  return totp(base32Decode(secretBase32), Math.floor(ms / 1000));
}

describe("totp: enrollment + login", () => {
  /** Sign up and return the session cookie that comes back. */
  async function signupCookie(c: AuthContext, email: string): Promise<string> {
    const signup = await handleSignup(c, {
      email,
      password: "password123",
      name: email.split("@")[0],
    });
    return (signup.headers?.["set-cookie"] ?? "").split(";")[0] ?? "";
  }

  /**
   * Sign up + enroll on the pinned clock, then step into the slot after
   * enrollment so the returned context is ready for a login.
   */
  async function enrolled(
    email: string,
    opts: { pending?: PendingTwoFactorStore } = {},
  ): Promise<{ c: AuthContext; cookie: string; secret: string; recoveryCodes: string[] }> {
    const c = ctx({ now: BASE_MS, ...(opts.pending ? { pending: opts.pending } : {}) });
    const cookie = await signupCookie(c, email);
    const begin = await handleBeginTotpEnrollment(c, cookie, null);
    const { secret } = begin.body as { secret: string };
    const confirm = await handleConfirmTotpEnrollment(
      c,
      { secret, code: codeAt(secret, BASE_MS) },
      cookie,
      null,
    );
    expect(confirm.status).toBe(200);
    c.now = BASE_MS + STEP_MS;
    return {
      c,
      cookie,
      secret,
      recoveryCodes: (confirm.body as { recoveryCodes: string[] }).recoveryCodes,
    };
  }

  it("begins enrollment, returns a secret + otpauth URI", async () => {
    const c = ctx({ now: BASE_MS });
    const cookie = await signupCookie(c, "u@example.com");
    const result = await handleBeginTotpEnrollment(c, cookie, null);
    expect(result.status).toBe(200);
    const body = result.body as { secret: string; otpauthUri: string };
    expect(body.secret).toMatch(/^[A-Z2-7]+$/);
    expect(body.otpauthUri).toContain("otpauth://totp/");
    _clearPendingTwoFactorForTests();
  });

  it("confirming enrollment requires a valid TOTP and returns recovery codes", async () => {
    const { recoveryCodes } = await enrolled("u2@example.com");
    expect(recoveryCodes).toHaveLength(10);
    _clearPendingTwoFactorForTests();
  });

  it("confirming with a wrong code refuses", async () => {
    const c = ctx({ now: BASE_MS });
    const cookie = await signupCookie(c, "u3@example.com");
    const begin = await handleBeginTotpEnrollment(c, cookie, null);
    const { secret } = begin.body as { secret: string };
    const confirm = await handleConfirmTotpEnrollment(c, { secret, code: "000000" }, cookie, null);
    expect(confirm.status).toBe(400);
    _clearPendingTwoFactorForTests();
  });

  it("login returns {requires2fa, loginToken} when 2FA is on", async () => {
    const { c } = await enrolled("u4@example.com");
    const login = await handleLogin(c, { email: "u4@example.com", password: "password123" });
    expect(login.status).toBe(200);
    const body = login.body as { requires2fa: boolean; loginToken: string };
    expect(body.requires2fa).toBe(true);
    expect(body.loginToken).toBeTruthy();
    expect(login.headers?.["set-cookie"]).toBeUndefined();
    _clearPendingTwoFactorForTests();
  });

  it("the second step mints a session when given a valid TOTP", async () => {
    const { c, secret } = await enrolled("u5@example.com");
    const login = await handleLogin(c, { email: "u5@example.com", password: "password123" });
    const { loginToken } = login.body as { loginToken: string };
    const verify = await handleVerifyTwoFactorLogin(
      c,
      { loginToken, code: codeAt(secret, c.now!) },
      null,
    );
    expect(verify.status).toBe(200);
    expect(verify.headers?.["set-cookie"]).toContain("lucent_session=");
    _clearPendingTwoFactorForTests();
  });

  it("a recovery code works in place of a TOTP at the second step", async () => {
    const { c, recoveryCodes } = await enrolled("u6@example.com");
    expect(recoveryCodes[0]).toBeDefined();
    const login = await handleLogin(c, { email: "u6@example.com", password: "password123" });
    expect(login.status).toBe(200);
    const { loginToken } = login.body as { loginToken: string };
    const verify = await handleVerifyTwoFactorLogin(
      c,
      { loginToken, code: recoveryCodes[0]! },
      null,
    );
    expect(verify.status).toBe(200);
    _clearPendingTwoFactorForTests();
  });

  it("an expired login token is rejected", async () => {
    const { c } = await enrolled("u7@example.com");
    const user = await c.userStore.findByEmail("u7@example.com");
    // Issued far enough in the past that the 5-minute TTL has run out by the
    // time the second step reads it.
    const token = await recordPendingTwoFactor(c, user!.id, c.now! - 10 * 60 * 1000);
    const verify = await handleVerifyTwoFactorLogin(c, { loginToken: token, code: "000000" }, null);
    expect(verify.status).toBe(401);
    _clearPendingTwoFactorForTests();
  });

  it("disable requires a valid code; a wrong code is refused", async () => {
    const { c, cookie, secret } = await enrolled("u8@example.com");
    const bad = await handleDisableTotp(c, { code: "000000" }, cookie, null);
    expect(bad.status).toBe(400);
    const good = await handleDisableTotp(c, { code: codeAt(secret, c.now!) }, cookie, null);
    expect(good.status).toBe(204);
    _clearPendingTwoFactorForTests();
  });
});

describe("totp: replay protection (RFC 6238 section 5.2)", () => {
  /**
   * The defect this covers: `lastCounter` was written as 0 at enrollment and
   * never updated, so `verifyTotp`'s "is this code live" answer was the only
   * gate. A code seen over the user's shoulder, in a phishing proxy or in a
   * log stayed usable for the rest of its 30-second slot.
   */
  async function enroll(
    email: string,
  ): Promise<{ c: AuthContext; secret: string; codes: string[] }> {
    const c = ctx({ now: BASE_MS });
    const signup = await handleSignup(c, { email, password: "password123", name: "R" });
    const cookie = (signup.headers?.["set-cookie"] ?? "").split(";")[0] ?? "";
    const begin = await handleBeginTotpEnrollment(c, cookie, null);
    const { secret } = begin.body as { secret: string };
    const confirm = await handleConfirmTotpEnrollment(
      c,
      { secret, code: codeAt(secret, BASE_MS) },
      cookie,
      null,
    );
    expect(confirm.status).toBe(200);
    c.now = BASE_MS + STEP_MS;
    return { c, secret, codes: (confirm.body as { recoveryCodes: string[] }).recoveryCodes };
  }

  /** Fresh login token per attempt — `take` spends one whatever the outcome. */
  async function loginToken(c: AuthContext, email: string): Promise<string> {
    const login = await handleLogin(c, { email, password: "password123" });
    expect(login.status).toBe(200);
    return (login.body as { loginToken: string }).loginToken;
  }

  it("refuses the same TOTP code a second time inside its own slot", async () => {
    const { c, secret } = await enroll("replay1@example.com");
    const code = codeAt(secret, c.now!);

    const first = await handleVerifyTwoFactorLogin(
      c,
      { loginToken: await loginToken(c, "replay1@example.com"), code },
      null,
    );
    expect(first.status).toBe(200);

    // Same clock, same still-live code, fresh login token: this is exactly the
    // window an observer had, and it has to be closed now.
    const replay = await handleVerifyTwoFactorLogin(
      c,
      { loginToken: await loginToken(c, "replay1@example.com"), code },
      null,
    );
    expect(replay.status).toBe(401);

    // The guard refuses replays without locking the account out: the next
    // slot's code still authenticates.
    c.now = BASE_MS + STEP_MS + 30_000;
    const next = await handleVerifyTwoFactorLogin(
      c,
      { loginToken: await loginToken(c, "replay1@example.com"), code: codeAt(secret, c.now) },
      null,
    );
    expect(next.status).toBe(200);
    _clearPendingTwoFactorForTests();
  });

  it("refuses the enrollment code as a login code", async () => {
    const { c, secret } = await enroll("replay2@example.com");
    // Still inside its +/-1 window at this clock, but it became the watermark
    // when enrollment consumed it.
    const verify = await handleVerifyTwoFactorLogin(
      c,
      { loginToken: await loginToken(c, "replay2@example.com"), code: codeAt(secret, BASE_MS) },
      null,
    );
    expect(verify.status).toBe(401);
    _clearPendingTwoFactorForTests();
  });

  it("refuses a recovery code that has already been consumed", async () => {
    const { c, codes } = await enroll("replay3@example.com");
    const first = await handleVerifyTwoFactorLogin(
      c,
      { loginToken: await loginToken(c, "replay3@example.com"), code: codes[0]! },
      null,
    );
    expect(first.status).toBe(200);

    const replay = await handleVerifyTwoFactorLogin(
      c,
      { loginToken: await loginToken(c, "replay3@example.com"), code: codes[0]! },
      null,
    );
    expect(replay.status).toBe(401);

    // Only the presented code is spent, not the whole set.
    const other = await handleVerifyTwoFactorLogin(
      c,
      { loginToken: await loginToken(c, "replay3@example.com"), code: codes[1]! },
      null,
    );
    expect(other.status).toBe(200);
    _clearPendingTwoFactorForTests();
  });

  it("banks the matched counter on the stored credential", async () => {
    const store = new InMemoryTotpStore();
    const c = ctx({ now: BASE_MS, totp: store });
    const signup = await handleSignup(c, {
      email: "replay4@example.com",
      password: "password123",
      name: "R",
    });
    const cookie = (signup.headers?.["set-cookie"] ?? "").split(";")[0] ?? "";
    const begin = await handleBeginTotpEnrollment(c, cookie, null);
    const { secret } = begin.body as { secret: string };
    await handleConfirmTotpEnrollment(c, { secret, code: codeAt(secret, BASE_MS) }, cookie, null);

    const enrolledCounter = totpCounterAt(Math.floor(BASE_MS / 1000));
    const user = await c.userStore.findByEmail("replay4@example.com");
    // Enrollment banks the slot it matched rather than 0 — that is what makes
    // the enrollment code unusable as a login code a moment later.
    expect((await store.getCredential(user!.id))!.lastCounter).toBe(enrolledCounter);

    c.now = BASE_MS + STEP_MS;
    const tok = await loginToken(c, "replay4@example.com");
    await handleVerifyTwoFactorLogin(c, { loginToken: tok, code: codeAt(secret, c.now) }, null);
    expect((await store.getCredential(user!.id))!.lastCounter).toBe(enrolledCounter + 1);
    _clearPendingTwoFactorForTests();
  });

  it("never moves the watermark backwards", async () => {
    // Two requests racing with codes from adjacent slots must not hand the
    // replay window back to the older one.
    const store = new InMemoryTotpStore();
    await store.setCredential({
      userId: "u1",
      secret: "JBSWY3DPEHPK3PXP",
      enrolledAt: 1,
      lastCounter: 5,
    });
    await store.setLastCounter("u1", 7);
    expect((await store.getCredential("u1"))!.lastCounter).toBe(7);
    await store.setLastCounter("u1", 6);
    expect((await store.getCredential("u1"))!.lastCounter).toBe(7);
  });
});

describe("pending two-factor state", () => {
  /**
   * The half-authenticated login state used to be a module-level Map, so the
   * second login step only worked when it happened to land on the same process
   * as the first — a silent 401 behind any load balancer with more than one
   * instance. These cover the store seam that replaced it.
   */
  it("routes the login token through an injected store", async () => {
    const pending = new InMemoryPendingTwoFactorStore();
    const c = ctx({ now: BASE_MS, pending });
    const signup = await handleSignup(c, {
      email: "pend1@example.com",
      password: "password123",
      name: "P",
    });
    const cookie = (signup.headers?.["set-cookie"] ?? "").split(";")[0] ?? "";
    const begin = await handleBeginTotpEnrollment(c, cookie, null);
    const { secret } = begin.body as { secret: string };
    await handleConfirmTotpEnrollment(c, { secret, code: codeAt(secret, BASE_MS) }, cookie, null);

    c.now = BASE_MS + STEP_MS;
    const login = await handleLogin(c, { email: "pend1@example.com", password: "password123" });
    const { loginToken: tok } = login.body as { loginToken: string };
    // Resolvable from the injected store, which is the property a scaled-out
    // deployment needs: instance B can finish what instance A started.
    const entry = await pending.take(tok, c.now);
    expect(entry).toBeDefined();
    expect(entry!.userId).toBe((await c.userStore.findByEmail("pend1@example.com"))!.id);
  });

  it("spends a token on the first presentation, right or wrong", async () => {
    const store = new InMemoryPendingTwoFactorStore();
    const tok = await store.issue("u1", 1000, 60_000);
    expect((await store.take(tok, 1500))!.userId).toBe("u1");
    expect(await store.take(tok, 1500)).toBeUndefined();
  });

  it("refuses an expired token and prunes it", async () => {
    const store = new InMemoryPendingTwoFactorStore();
    const stale = await store.issue("u1", 1000, 60_000);
    // expiresAt is exclusive, so the boundary itself is already expired.
    expect(await store.take(stale, 1000 + 60_000)).toBeUndefined();
    const other = await store.issue("u2", 1000, 60_000);
    expect(await store.prune(1000 + 60_001)).toBe(1);
    expect(await store.take(other, 1500)).toBeUndefined();
  });

  it("keys on the token hash, not the raw token", async () => {
    const store = new InMemoryPendingTwoFactorStore();
    const tok = await store.issue("u1", 1000, 60_000);
    // Same discipline as tokens.ts: what the store holds must not itself be a
    // presentable credential.
    expect(await store.take(hashPendingToken(tok), 1500)).toBeUndefined();
    expect(await store.take(tok, 1500)).toBeDefined();
  });
});
