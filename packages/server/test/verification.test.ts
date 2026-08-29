import { describe, it, expect, vi } from "vitest";
import {
  InMemorySessionStore,
  InMemoryTokenStore,
  InMemoryUserStore,
  handleLogin,
  handleRequestPasswordReset,
  handleRequestVerification,
  handleResetPassword,
  handleSignup,
  handleVerifyEmail,
  type AuthContext,
} from "../src/accounts.js";
import { hashToken } from "../src/tokens.js";

/**
 * Email verification + password reset (M1.4).
 *
 * Properties under test:
 *   - Both flows are single-use: a second call with the same token fails.
 *   - Request endpoints always 204 regardless of whether the email exists,
 *     so they aren't an account oracle.
 *   - Reset bumps tokenVersion + revokes every session so a stolen reset
 *     link doesn't leave the attacker's hijack live.
 *   - Token storage uses SHA-256 hashes, never the raw token.
 */

const SECRET = "test-secret-at-least-16-chars";

interface CapturedMail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

interface Mailer {
  messages: CapturedMail[];
  send: (m: CapturedMail) => Promise<void>;
}

function buildCtx(opts: {
  userStore: InMemoryUserStore;
  verificationTokens: InMemoryTokenStore;
  resetTokens: InMemoryTokenStore;
  sessionStore: InMemorySessionStore;
  mailer: Mailer;
}): AuthContext {
  return {
    userStore: opts.userStore,
    secret: SECRET,
    verificationTokens: opts.verificationTokens,
    resetTokens: opts.resetTokens,
    sessionStore: opts.sessionStore,
    // M1.1: the cookie option makes signup/login mint a session. The
    // handlers check ctx.sessionCookie to so the response writer, but it
    // isn't required for the verification / reset flows under test here.
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
    mailer: { send: opts.mailer.send },
    siteOrigin: "http://localhost:5173",
  };
}

function recordingMailer(): Mailer {
  const messages: CapturedMail[] = [];
  return {
    messages,
    send: vi.fn(async (m: CapturedMail) => {
      messages.push(m);
    }),
  };
}

function harness() {
  const userStore = new InMemoryUserStore();
  const verificationTokens = new InMemoryTokenStore();
  const resetTokens = new InMemoryTokenStore();
  const sessionStore = new InMemorySessionStore();
  const mailer = recordingMailer();
  const ctx = buildCtx({ userStore, verificationTokens, resetTokens, sessionStore, mailer });
  return { ctx, userStore, verificationTokens, resetTokens, sessionStore, mailer };
}

async function signupAndSend(h: ReturnType<typeof harness>, email: string): Promise<void> {
  await handleSignup(h.ctx, { email, password: "password123", name: email.split("@")[0] });
}

function extractTokenFromMail(mailer: Mailer, subjectPrefix: string): string {
  const last = [...mailer.messages].reverse().find((m) => m.subject.startsWith(subjectPrefix));
  if (!last) throw new Error(`no mail with subject prefix "${subjectPrefix}"`);
  const match = /token=([A-Za-z0-9_-]+)/.exec(last.text);
  if (!match) throw new Error(`no token in mail body: ${last.text}`);
  return match[1]!;
}

describe("email verification", () => {
  it("issues a token and sends a templated email on request", async () => {
    const h = harness();
    await signupAndSend(h, "verify@example.com");
    h.mailer.messages.length = 0;

    const result = await handleRequestVerification(h.ctx, { email: "verify@example.com" });
    expect(result.status).toBe(204);
    expect(h.mailer.messages).toHaveLength(1);
    expect(h.mailer.messages[0]!.subject).toMatch(/verify your/i);
    expect(h.mailer.messages[0]!.html).toContain("/verify?token=");
  });

  it("returns 204 even when the email doesn't exist (no account oracle)", async () => {
    const h = harness();
    const result = await handleRequestVerification(h.ctx, { email: "ghost@example.com" });
    expect(result.status).toBe(204);
    expect(h.mailer.messages).toHaveLength(0);
  });

  it("redeeming the token marks the email verified and consumes it", async () => {
    const h = harness();
    await signupAndSend(h, "verify2@example.com");
    h.mailer.messages.length = 0;

    await handleRequestVerification(h.ctx, { email: "verify2@example.com" });
    const token = extractTokenFromMail(h.mailer, "Verify your");
    const result = await handleVerifyEmail(h.ctx, token);
    expect(result.status).toBe(200);
    expect(
      (result.body as { user: { emailVerifiedAt: number | null } }).user.emailVerifiedAt,
    ).toBeGreaterThan(0);

    // The token is now spent.
    const replay = await handleVerifyEmail(h.ctx, token);
    expect(replay.status).toBe(400);
  });

  it("rejects a token that was never issued", async () => {
    const h = harness();
    await signupAndSend(h, "verify3@example.com");

    const result = await handleVerifyEmail(h.ctx, "totally-not-real-token");
    expect(result.status).toBe(400);
  });

  it("stores SHA-256 hashes, not the raw token, in the in-memory token store", async () => {
    const tokens = new InMemoryTokenStore();
    const { raw } = await tokens.issue({ userId: "u1", ttlMs: 60_000, now: 1000 });
    const expected = hashToken(raw);
    expect(raw).not.toBe(expected);
    const found = await tokens.findByRawToken(raw, 1050);
    expect(found).toBeDefined();
    expect(found!.tokenHash).toBe(expected);
  });
});

describe("password reset", () => {
  it("issues a reset token and emails the templated link", async () => {
    const h = harness();
    await signupAndSend(h, "reset@example.com");
    h.mailer.messages.length = 0;

    const result = await handleRequestPasswordReset(h.ctx, { email: "reset@example.com" });
    expect(result.status).toBe(204);
    expect(h.mailer.messages[0]!.subject).toMatch(/reset your .*password/i);
    expect(h.mailer.messages[0]!.text).toContain("/reset?token=");
  });

  it("returns 204 even when the email doesn't exist", async () => {
    const h = harness();
    const result = await handleRequestPasswordReset(h.ctx, { email: "ghost@example.com" });
    expect(result.status).toBe(204);
    expect(h.mailer.messages).toHaveLength(0);
  });

  it("redeeming replaces the password, bumps tokenVersion, and revokes every session", async () => {
    const h = harness();
    const signup = await handleSignup(h.ctx, {
      email: "reset2@example.com",
      password: "oldpassword",
      name: "R",
    });
    const cookie = (signup.headers?.["set-cookie"] ?? "").split(";")[0]?.split("=")[1] ?? "";
    expect(cookie).toBeTruthy();

    const user = await h.userStore.findByEmail("reset2@example.com");
    expect(user).toBeDefined();
    const versionBefore = user!.tokenVersion;

    h.mailer.messages.length = 0;
    await handleRequestPasswordReset(h.ctx, { email: "reset2@example.com" });
    const token = extractTokenFromMail(h.mailer, "Reset your");

    const result = await handleResetPassword(h.ctx, token, "newpassword");
    expect(result.status).toBe(200);

    const oldLogin = await handleLogin(h.ctx, {
      email: "reset2@example.com",
      password: "oldpassword",
    });
    expect(oldLogin.status).toBe(401);
    const newLogin = await handleLogin(h.ctx, {
      email: "reset2@example.com",
      password: "newpassword",
    });
    expect(newLogin.status).toBe(200);

    const after = await h.userStore.findByEmail("reset2@example.com");
    expect(after!.tokenVersion).toBeGreaterThan(versionBefore);
    expect(await h.sessionStore.find(cookie, Date.now())).toBeUndefined();
    const replay = await handleResetPassword(h.ctx, token, "thirdpassword");
    expect(replay.status).toBe(400);
  });

  it("rejects a missing or too-short new password", async () => {
    const h = harness();
    await signupAndSend(h, "reset3@example.com");
    h.mailer.messages.length = 0;
    await handleRequestPasswordReset(h.ctx, { email: "reset3@example.com" });
    const token = extractTokenFromMail(h.mailer, "Reset your");

    expect((await handleResetPassword(h.ctx, token, undefined)).status).toBe(400);
    expect((await handleResetPassword(h.ctx, token, "short")).status).toBe(400);
  });
});

describe("signup issues the verification mail", () => {
  /**
   * The defect: `handleSignup` created the user and stopped. `emailVerifiedAt`
   * starts null, the share gate (app.ts, POST /api/boards/:id/share) refuses
   * to mint a public link until it is set, and nothing in the product ever
   * called POST /api/auth/verify/request — so a brand-new account could never
   * become verified and could never share a board.
   */
  it("sends a verification mail whose token verifies the account", async () => {
    const h = harness();
    const signup = await handleSignup(h.ctx, {
      email: "fresh@example.com",
      password: "password123",
      name: "F",
    });
    expect(signup.status).toBe(201);
    expect(h.mailer.messages).toHaveLength(1);
    expect(h.mailer.messages[0]!.to).toBe("fresh@example.com");
    expect(h.mailer.messages[0]!.subject).toMatch(/verify your/i);

    const token = extractTokenFromMail(h.mailer, "Verify your");
    const verified = await handleVerifyEmail(h.ctx, token);
    expect(verified.status).toBe(200);
    expect(
      (verified.body as { user: { emailVerifiedAt: number | null } }).user.emailVerifiedAt,
    ).toBeGreaterThan(0);
  });

  it("still creates the account when the transport fails", async () => {
    const h = harness();
    h.ctx.mailer = {
      send: async () => {
        throw new Error("http mail: 500 Internal Server Error from https://api.example.com/emails");
      },
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const result = await handleSignup(h.ctx, {
        email: "broken@example.com",
        password: "password123",
        name: "B",
      });
      // A failed transactional send is an operational problem, not a request
      // failure: the account exists and the user can resend.
      expect(result.status).toBe(201);
      expect(await h.userStore.findByEmail("broken@example.com")).toBeDefined();

      const line = String(warn.mock.calls[0]?.[0]);
      expect(line).toContain("signup verification");
      // The user id is logged, the address is not — a log aggregator must not
      // become a second copy of the user table.
      expect(line).not.toContain("broken@example.com");
    } finally {
      warn.mockRestore();
    }
  });

  it("signs the user up even with no mail configured at all", async () => {
    // A fixture (or a deployment with no provider) must still be able to
    // create accounts.
    const bare = {
      userStore: new InMemoryUserStore(),
      secret: SECRET,
    };
    const result = await handleSignup(bare, {
      email: "nomail@example.com",
      password: "password123",
      name: "N",
    });
    expect(result.status).toBe(201);
  });
});

describe("token expiry", () => {
  /**
   * The pre-existing "rejects an unknown or expired token" case passed a bogus
   * literal string, which only ever exercised the unknown-token path. These
   * advance the clock instead, so the *same* token is accepted one millisecond
   * inside the window and refused at the boundary — which is the only way to
   * show the TTL is load-bearing.
   */
  const ISSUED_AT = 1_700_000_000_000;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const HOUR_MS = 60 * 60 * 1000;

  it("refuses a verification token at its 24-hour boundary and accepts it just inside", async () => {
    const h = harness();
    h.ctx.now = ISSUED_AT;
    await handleSignup(h.ctx, { email: "expiry@example.com", password: "password123", name: "E" });
    const token = extractTokenFromMail(h.mailer, "Verify your");

    // Checked first because it does not consume the token.
    h.ctx.now = ISSUED_AT + DAY_MS;
    expect((await handleVerifyEmail(h.ctx, token)).status).toBe(400);
    expect((await h.userStore.findByEmail("expiry@example.com"))!.emailVerifiedAt).toBeNull();

    h.ctx.now = ISSUED_AT + DAY_MS - 1;
    expect((await handleVerifyEmail(h.ctx, token)).status).toBe(200);
    expect((await h.userStore.findByEmail("expiry@example.com"))!.emailVerifiedAt).toBe(
      ISSUED_AT + DAY_MS - 1,
    );
  });

  it("refuses a reset token at its 1-hour boundary without changing the password", async () => {
    const h = harness();
    h.ctx.now = ISSUED_AT;
    await handleSignup(h.ctx, {
      email: "resetexp@example.com",
      password: "password123",
      name: "R",
    });
    h.mailer.messages.length = 0;
    await handleRequestPasswordReset(h.ctx, { email: "resetexp@example.com" });
    const token = extractTokenFromMail(h.mailer, "Reset your");

    h.ctx.now = ISSUED_AT + HOUR_MS;
    expect((await handleResetPassword(h.ctx, token, "brandnewpassword")).status).toBe(400);
    // An expired link must not be a way in: the old password is still the one.
    expect(
      (await handleLogin(h.ctx, { email: "resetexp@example.com", password: "brandnewpassword" }))
        .status,
    ).toBe(401);
    expect(
      (await handleLogin(h.ctx, { email: "resetexp@example.com", password: "password123" })).status,
    ).toBe(200);

    h.ctx.now = ISSUED_AT + HOUR_MS - 1;
    expect((await handleResetPassword(h.ctx, token, "brandnewpassword")).status).toBe(200);
    expect(
      (await handleLogin(h.ctx, { email: "resetexp@example.com", password: "brandnewpassword" }))
        .status,
    ).toBe(200);
  });

  it("treats the expiry instant itself as expired in the store", async () => {
    const tokens = new InMemoryTokenStore();
    const { raw } = await tokens.issue({ userId: "u1", ttlMs: 1000, now: 5000 });
    expect(await tokens.findByRawToken(raw, 5999)).toBeDefined();
    // `expiresAt <= now` — exclusive, so the boundary is already gone. Pinned
    // by a test because both Postgres stores repeat the same comparison.
    expect(await tokens.findByRawToken(raw, 6000)).toBeUndefined();
  });

  it("a resent verification token supersedes nothing — both stay valid until used", async () => {
    const h = harness();
    h.ctx.now = ISSUED_AT;
    await handleSignup(h.ctx, { email: "resend@example.com", password: "password123", name: "R" });
    const first = extractTokenFromMail(h.mailer, "Verify your");
    h.mailer.messages.length = 0;
    await handleRequestVerification(h.ctx, { email: "resend@example.com" });
    const second = extractTokenFromMail(h.mailer, "Verify your");
    expect(second).not.toBe(first);

    // Documents today's behaviour rather than asserting it is ideal: a user who
    // clicks the older mail is not punished for it.
    expect((await handleVerifyEmail(h.ctx, first)).status).toBe(200);
    expect((await handleVerifyEmail(h.ctx, second)).status).toBe(200);
  });
});
