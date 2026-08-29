import { describe, it, expect } from "vitest";
import { mintCsrf, verifyCsrf } from "../src/csrf.js";

/**
 * Pin the CSRF middleware (M1.2). The same-origin policy alone (SameSite=Lax
 * on the session cookie) blocks the most common cases, but the second
 * barrier — a signed cookie + matching header + Origin check — closes the
 * navigation/redirect cases where SameSite doesn't apply.
 *
 * Scoping: CSRF only fires for cookie-authenticated requests. Programmatic
 * clients (MCP, API keys) authenticate via bearer and bypass the check.
 */

const SECRET = "test-csrf-secret-at-least-16-chars";
const ALLOWED = ["http://localhost:5173", "http://localhost:4387"];

function _withSession(cookieHeader: string | undefined): string {
  return `lucent_session=abc; ${cookieHeader ?? ""}`.replace(/; $/, "");
}

describe("verifyCsrf", () => {
  it("skips safe methods", () => {
    expect(
      verifyCsrf(
        { secret: SECRET, allowedOrigins: ALLOWED },
        "GET",
        "http://localhost:5173",
        undefined,
        undefined,
        true,
      ).ok,
    ).toBe(true);
    expect(
      verifyCsrf(
        { secret: SECRET, allowedOrigins: ALLOWED },
        "HEAD",
        "http://localhost:5173",
        undefined,
        undefined,
        true,
      ).ok,
    ).toBe(true);
    expect(
      verifyCsrf(
        { secret: SECRET, allowedOrigins: ALLOWED },
        "OPTIONS",
        "http://localhost:5173",
        undefined,
        undefined,
        true,
      ).ok,
    ).toBe(true);
  });

  it("rejects a session-authenticated POST with an off-origin Origin", () => {
    const m = mintCsrf({ secret: SECRET, allowedOrigins: ALLOWED });
    const cookie = `lucent_session=abc; lucent_csrf=${m.cookie.split(";")[0]?.split("=")[1]}`;
    const result = verifyCsrf(
      { secret: SECRET, allowedOrigins: ALLOWED },
      "POST",
      "http://evil.example",
      cookie,
      m.token,
      true,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("origin");
  });

  it("rejects a session-authenticated POST missing the CSRF cookie", () => {
    const m = mintCsrf({ secret: SECRET, allowedOrigins: ALLOWED });
    const result = verifyCsrf(
      { secret: SECRET, allowedOrigins: ALLOWED },
      "POST",
      "http://localhost:5173",
      "lucent_session=abc",
      m.token,
      true,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("missing-cookie");
  });

  it("rejects a session-authenticated POST missing the X-CSRF-Token header", () => {
    const m = mintCsrf({ secret: SECRET, allowedOrigins: ALLOWED });
    const cookie = `lucent_session=abc; lucent_csrf=${m.cookie.split(";")[0]?.split("=")[1]}`;
    const result = verifyCsrf(
      { secret: SECRET, allowedOrigins: ALLOWED },
      "POST",
      "http://localhost:5173",
      cookie,
      "",
      true,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("missing-header");
  });

  it("rejects a session-authenticated POST when the cookie and header don't match", () => {
    const m = mintCsrf({ secret: SECRET, allowedOrigins: ALLOWED });
    const cookie = `lucent_session=abc; lucent_csrf=${m.cookie.split(";")[0]?.split("=")[1]}`;
    const result = verifyCsrf(
      { secret: SECRET, allowedOrigins: ALLOWED },
      "POST",
      "http://localhost:5173",
      cookie,
      "wrong-token",
      true,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("mismatch");
  });

  it("accepts a valid pair on the right origin", () => {
    const m = mintCsrf({ secret: SECRET, allowedOrigins: ALLOWED });
    const cookie = `lucent_session=abc; lucent_csrf=${m.cookie.split(";")[0]?.split("=")[1]}`;
    const result = verifyCsrf(
      { secret: SECRET, allowedOrigins: ALLOWED },
      "POST",
      "http://localhost:5173",
      cookie,
      m.token,
      true,
    );
    expect(result.ok).toBe(true);
  });

  it("bypasses the check when no session cookie is present (programmatic clients)", () => {
    // No session cookie → hasSessionCookie=false → bypass regardless of
    // missing CSRF cookie/header. This is how MCP keeps working.
    const result = verifyCsrf(
      { secret: SECRET, allowedOrigins: ALLOWED },
      "POST",
      "http://evil.example",
      "",
      "",
      false,
    );
    expect(result.ok).toBe(true);
  });

  it("a forged signed cookie value is rejected", () => {
    const forged = signTokenForTest("attacker-controlled-token", "wrong-secret");
    const cookie = `lucent_session=abc; lucent_csrf=${forged}`;
    const result = verifyCsrf(
      { secret: SECRET, allowedOrigins: ALLOWED },
      "POST",
      "http://localhost:5173",
      cookie,
      "attacker-controlled-token",
      true,
    );
    expect(result.ok).toBe(false);
  });
});

async function signTokenForTest(token: string, secret: string): Promise<string> {
  const { createHmac } = await import("node:crypto");
  return createHmac("sha256", secret).update(token).digest("hex");
}
