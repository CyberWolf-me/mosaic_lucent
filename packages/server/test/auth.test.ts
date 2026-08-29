import { describe, it, expect } from "vitest";
import {
  normalizeEmail,
  roleAtLeast,
  toPublicUser,
  validateSignup,
  type StoredUser,
} from "../src/identity.js";
import { bearerToken, hashPassword, issueToken, verifyPassword, verifyToken } from "../src/auth.js";
import { sessionSecret } from "../src/config.js";
import {
  InMemoryUserStore,
  handleLogin,
  handleMe,
  handleSignup,
  type AuthContext,
} from "../src/accounts.js";
import { parseMentions } from "@lucent/core";

/**
 * Identity, credentials, and sessions (docs/06). These are the primitives every
 * guarded route depends on, so each property is pinned: hashing is salted and
 * verifiable, tokens are signed and expiring, login failures are uniform so the
 * endpoint isn't an account oracle.
 */

describe("signup validation", () => {
  it("accepts a well-formed signup", () => {
    expect(validateSignup({ email: "a@b.co", password: "longenough", name: "Ana" })).toEqual([]);
  });

  it("rejects a bad email, short password, and empty name", () => {
    const errors = validateSignup({ email: "nope", password: "short", name: "  " });
    expect(errors.map((e) => e.field).sort()).toEqual(["email", "name", "password"]);
  });

  it("rejects an over-long password", () => {
    expect(
      validateSignup({ email: "a@b.co", password: "x".repeat(201), name: "A" }).map((e) => e.field),
    ).toContain("password");
  });

  it("normalizes email case for storage", () => {
    expect(normalizeEmail("  Ana@Example.COM ")).toBe("ana@example.com");
  });
});

describe("password hashing", () => {
  it("produces a salted hash that verifies", async () => {
    const stored = await hashPassword("correct horse");
    expect(stored).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);
    expect(await verifyPassword("correct horse", stored)).toBe(true);
  });

  it("rejects the wrong password", async () => {
    const stored = await hashPassword("correct horse");
    expect(await verifyPassword("wrong horse", stored)).toBe(false);
  });

  it("salts, so the same password hashes differently twice", async () => {
    expect(await hashPassword("same")).not.toBe(await hashPassword("same"));
  });

  it("fails safely on a malformed stored hash", async () => {
    expect(await verifyPassword("x", "not-a-hash")).toBe(false);
  });
});

describe("session tokens", () => {
  const SECRET = "test-secret-at-least-16-chars";

  it("issues and verifies a token round trip", () => {
    const token = issueToken("usr_1", SECRET);
    expect(verifyToken(token, SECRET)?.userId).toBe("usr_1");
  });

  it("rejects a token signed with a different secret", () => {
    const token = issueToken("usr_1", SECRET);
    expect(verifyToken(token, "another-secret-also-long")).toBeNull();
  });

  it("rejects an expired token", () => {
    const now = Date.now();
    const token = issueToken("usr_1", SECRET, -10); // expired 10s ago
    expect(verifyToken(token, SECRET, now)).toBeNull();
  });

  it("rejects tampered payloads", () => {
    const token = issueToken("usr_1", SECRET);
    const [body, sig] = token.split(".");
    const forged = `${body}x.${sig}`;
    expect(verifyToken(forged, SECRET)).toBeNull();
  });

  it("reads a bearer header", () => {
    expect(bearerToken("Bearer abc.def")).toBe("abc.def");
    expect(bearerToken("bearer abc")).toBe("abc");
    expect(bearerToken(undefined)).toBeNull();
    expect(bearerToken("Basic abc")).toBeNull();
  });

  it("generates a dev secret when none is configured", () => {
    const secret = sessionSecret({});
    expect(secret.length).toBeGreaterThanOrEqual(16);
    // Two calls in the same process may differ; both must still work as secrets.
    expect(issueToken("u", secret)).not.toBe(issueToken("u", sessionSecret({})));
  });

  it("refuses to generate a secret in production", () => {
    expect(() => sessionSecret({ NODE_ENV: "production" })).toThrow(/LUCENT_SESSION_SECRET/);
  });

  it("uses the configured secret when long enough", () => {
    expect(sessionSecret({ LUCENT_SESSION_SECRET: "x".repeat(32) })).toBe("x".repeat(32));
  });
});

function _makeUser(store: InMemoryUserStore, email: string): Promise<StoredUser> {
  const ctx: AuthContext = { userStore: store, secret: "test-secret-at-least-16-chars" };
  return handleSignup(ctx, {
    email,
    password: "password123",
    name: "Test User",
  }).then((result) => {
    const id = (result.body as { user: { id: string } }).user.id;
    return id ? store.findById(id).then((u) => u!) : store.findByEmail(email).then((u) => u!);
  });
}

describe("account handling", () => {
  const SECRET = "test-secret-at-least-16-chars";
  function ctx(store: InMemoryUserStore): AuthContext {
    return { userStore: store, secret: SECRET };
  }

  it("signs up, creates a personal org with owner membership, and returns a usable token", async () => {
    const store = new InMemoryUserStore();
    const result = await handleSignup(ctx(store), {
      email: "Ana@Example.com",
      password: "password123",
      name: "Ana",
    });
    expect(result.status).toBe(201);
    const body = result.body as {
      token: string;
      user: { id: string; email: string };
      memberships: unknown[];
    };
    expect(body.user.email).toBe("ana@example.com");
    // No credential ever crosses to the client.
    expect(JSON.stringify(body)).not.toContain("passwordHash");
    expect(body.memberships).toHaveLength(1);
    // The token resolves back to this user.
    expect((await handleMe(ctx(store), null, body.token)).status).toBe(200);
  });

  it("refuses a duplicate email without revealing more than necessary", async () => {
    const store = new InMemoryUserStore();
    await handleSignup(ctx(store), { email: "a@b.co", password: "password123", name: "A" });
    const second = await handleSignup(ctx(store), {
      email: "a@b.co",
      password: "password456",
      name: "B",
    });
    expect(second.status).toBe(409);
  });

  it("returns validation errors with 400 on bad signup input", async () => {
    const store = new InMemoryUserStore();
    const result = await handleSignup(ctx(store), { email: "bad", password: "x", name: "" });
    expect(result.status).toBe(400);
    expect((result.body as { errors: unknown[] }).errors.length).toBeGreaterThan(0);
  });

  it("logs in with correct credentials and rejects wrong ones uniformly", async () => {
    const store = new InMemoryUserStore();
    await handleSignup(ctx(store), { email: "a@b.co", password: "password123", name: "A" });

    const ok = await handleLogin(ctx(store), { email: "a@b.co", password: "password123" });
    expect(ok.status).toBe(200);

    // Wrong password and unknown email give the same status and message shape.
    const wrongPw = await handleLogin(ctx(store), { email: "a@b.co", password: "wrong!" });
    const noUser = await handleLogin(ctx(store), { email: "ghost@b.co", password: "whatever" });
    expect(wrongPw.status).toBe(401);
    expect(noUser.status).toBe(401);
    expect((wrongPw.body as { error: string }).error).toBe(
      (noUser.body as { error: string }).error,
    );
  });

  it("login works case-insensitively on email", async () => {
    const store = new InMemoryUserStore();
    await handleSignup(ctx(store), {
      email: "ana@example.com",
      password: "password123",
      name: "A",
    });
    expect(
      (await handleLogin(ctx(store), { email: "ANA@EXAMPLE.COM", password: "password123" })).status,
    ).toBe(200);
  });

  it("requires a valid token for /me and rejects garbage", async () => {
    const store = new InMemoryUserStore();
    expect((await handleMe(ctx(store), null, null)).status).toBe(401);
    expect((await handleMe(ctx(store), null, "garbage")).status).toBe(401);
  });
});

describe("roles and public users", () => {
  it("compares roles by rank", () => {
    expect(roleAtLeast("owner", "editor")).toBe(true);
    expect(roleAtLeast("editor", "owner")).toBe(false);
    expect(roleAtLeast("viewer", "viewer")).toBe(true);
  });

  it("strips the credential from a public user", () => {
    const stored: StoredUser = {
      id: "usr_1",
      email: "a@b.co",
      name: "A",
      createdAt: 0,
      passwordHash: "salt:hash",
      tokenVersion: 0,
      emailVerifiedAt: null,
    };
    const pub = toPublicUser(stored);
    expect(pub).toEqual({
      id: "usr_1",
      email: "a@b.co",
      name: "A",
      createdAt: 0,
      emailVerifiedAt: null,
    });
    expect(JSON.stringify(pub)).not.toContain("salt");
  });

  it("extracts mentions (shared helper used by comment bodies)", () => {
    expect(parseMentions("cc @bo now")).toEqual(["bo"]);
  });
});
