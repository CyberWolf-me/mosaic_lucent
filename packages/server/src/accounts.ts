import {
  newUserId,
  normalizeEmail,
  toPublicUser,
  validateSignup,
  type Membership,
  type Organization,
  type PublicUser,
  type Role,
  type StoredUser,
} from "./identity.js";
import { hashPassword, issueToken, verifyPassword, verifyToken } from "./auth.js";
import type { OauthIdentity, OauthProviderName } from "./oauth.js";
import {
  getCookie,
  parseCookies,
  serializeCookie,
  clearCookie,
  type CookieOptions,
} from "./cookies.js";
import { type SessionStore, type StoredSession } from "./sessions.js";
import type { TokenStore } from "./tokens.js";
import {
  base32Decode,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  matchTotpCounter,
  otpauthUri,
  verifyRecoveryCode,
} from "./totp.js";
import { verificationEmail, passwordResetEmail } from "./email/index.js";
import {
  InMemoryPendingTwoFactorStore,
  type PendingTwoFactorStore,
  type StoredTotpCredential,
  type TotpStore,
} from "./totpStore.js";

export {
  InMemoryTokenStore,
  PostgresEmailVerificationStore,
  PostgresPasswordResetStore,
} from "./tokens.js";
export {
  InMemoryTotpStore,
  PostgresTotpStore,
  InMemoryPendingTwoFactorStore,
} from "./totpStore.js";
export type { PendingTwoFactorStore } from "./totpStore.js";

export { InMemorySessionStore, PostgresSessionStore } from "./sessions.js";

/**
 * Account handling for signup / login / me (docs/06, docs/08).
 *
 * Storage is an interface so the in-memory implementation here can be swapped
 * for Postgres in Step 2 without touching the handlers. In-memory means accounts
 * don't survive a restart, which is honest about the current stage: this exists
 * to make requests attributable and to close the unauthenticated-endpoint gap,
 * not to be the production account system yet.
 *
 * Sessions (M1): browsers authenticate via an httpOnly cookie whose value is
 * an opaque session id. The id is looked up against a `SessionStore`, and the
 * server-side `revokedAt` makes "Sign out" instant. The bearer token still
 * works for programmatic clients (MCP, API keys); `authenticate` tries the
 * cookie first and falls back to bearer.
 */

export interface UserStore {
  findByEmail(email: string): Promise<StoredUser | undefined>;
  findById(id: string): Promise<StoredUser | undefined>;
  insert(user: StoredUser): Promise<void>;
  /**
   * M2: create + return the user's personal workspace. Idempotent — the same
   * org id is returned on every call so signup, OAuth-link and login paths
   * all converge on the same personal org for one user.
   */
  ensurePersonalOrg(userId: string, displayName: string, now: number): Promise<Organization>;
  /** All orgs the user is a member of. */
  listOrgsForUser(userId: string): Promise<Array<{ org: Organization; role: Role }>>;
  membershipsFor(userId: string): Promise<Membership[]>;
  /**
   * M4: how many membership rows the org holds — the number the `seats`
   * entitlement is compared against.
   *
   * It lives on `UserStore` rather than `OrgStore` on purpose. Both stores can
   * read memberships in Postgres (one table), but the routes that add a member
   * write through `setMembership` here, and in the in-memory pair the two
   * stores keep separate tables. A seat gate that counted through the store the
   * write did not go to would be right in production and wrong in dev, which is
   * the worst possible split for a limit a customer hits.
   */
  countMembers(orgId: string): Promise<number>;
  /** M2: insert or update one membership row (used when a joiner gets org access). */
  setMembership(membership: Membership): Promise<void>;
  /** Bump the user's `tokenVersion` to invalidate every live session. M1. */
  bumpTokenVersion(userId: string, now: number): Promise<number>;
  /** Mark the user's email as verified at the given timestamp. M1.4 */
  setEmailVerified(userId: string, now: number): Promise<void>;
  /** Replace the password hash (M1.4 password reset). */
  updatePasswordHash(userId: string, passwordHash: string): Promise<void>;
  /** M1.7: update the user's display name. */
  updateProfile(userId: string, patch: { name?: string }): Promise<void>;
  /** M1.7: hard-delete the user + cascade everything that depends on them. */
  deleteUser(userId: string): Promise<void>;
  /**
   * M1.8: federated identities. One row per external account linked to a
   * user; linking policy (verified email only) lives in oauth.ts, the stores
   * only keep the rows.
   */
  findOauthIdentity(
    provider: OauthProviderName,
    providerAccountId: string,
  ): Promise<OauthIdentity | undefined>;
  linkOauthIdentity(identity: OauthIdentity & { email: string | null; now: number }): Promise<void>;
}

/** Per-process store. Correct for single-instance dev; replaced by Postgres. */
export class InMemoryUserStore implements UserStore {
  private readonly byId = new Map<string, StoredUser>();
  private readonly byEmail = new Map<string, string>();
  private readonly orgs = new Map<string, Organization>();
  private readonly memberships: Membership[] = [];
  /** Keyed `${provider}:${providerAccountId}` — the pair the provider guarantees. */
  private readonly oauthIdentities = new Map<string, OauthIdentity>();

  async findOauthIdentity(
    provider: OauthProviderName,
    providerAccountId: string,
  ): Promise<OauthIdentity | undefined> {
    return this.oauthIdentities.get(`${provider}:${providerAccountId}`);
  }
  async linkOauthIdentity(
    identity: OauthIdentity & { email: string | null; now: number },
  ): Promise<void> {
    this.oauthIdentities.set(`${identity.provider}:${identity.providerAccountId}`, {
      provider: identity.provider,
      providerAccountId: identity.providerAccountId,
      userId: identity.userId,
    });
  }

  async findByEmail(email: string): Promise<StoredUser | undefined> {
    const id = this.byEmail.get(normalizeEmail(email));
    return id ? this.byId.get(id) : undefined;
  }
  async findById(id: string): Promise<StoredUser | undefined> {
    return this.byId.get(id);
  }
  async insert(user: StoredUser): Promise<void> {
    this.byId.set(user.id, user);
    this.byEmail.set(normalizeEmail(user.email), user.id);
  }
  async ensurePersonalOrg(userId: string, displayName: string, now: number): Promise<Organization> {
    const orgId = `org_personal_${userId}`;
    const existing = this.orgs.get(orgId);
    if (existing) return existing;
    const org: Organization = {
      id: orgId,
      name: `${displayName.trim() || "User"}'s workspace`,
      createdAt: now,
    };
    this.orgs.set(orgId, org);
    if (!this.memberships.some((m) => m.userId === userId && m.orgId === orgId)) {
      this.memberships.push({ userId, orgId, role: "owner" });
    }
    return org;
  }
  async listOrgsForUser(userId: string): Promise<Array<{ org: Organization; role: Role }>> {
    const out: Array<{ org: Organization; role: Role }> = [];
    for (const m of this.memberships) {
      if (m.userId !== userId) continue;
      const org = this.orgs.get(m.orgId);
      if (!org) continue;
      out.push({ org, role: m.role });
    }
    return out.sort((a, b) => a.org.createdAt - b.org.createdAt);
  }
  async membershipsFor(userId: string): Promise<Membership[]> {
    return this.memberships.filter((m) => m.userId === userId);
  }
  async countMembers(orgId: string): Promise<number> {
    return this.memberships.filter((m) => m.orgId === orgId).length;
  }
  async setMembership(membership: Membership): Promise<void> {
    const i = this.memberships.findIndex(
      (m) => m.userId === membership.userId && m.orgId === membership.orgId,
    );
    if (i === -1) this.memberships.push(membership);
    else this.memberships[i] = membership;
  }
  async bumpTokenVersion(userId: string, _now: number): Promise<number> {
    const user = this.byId.get(userId);
    if (!user) return -1;
    // Token version is a monotonic counter; the timestamp is ignored by the
    // session check but recorded here so the schema/migration story stays
    // consistent with the Postgres path.
    user.tokenVersion += 1;
    return user.tokenVersion;
  }
  async setEmailVerified(userId: string, now: number): Promise<void> {
    const user = this.byId.get(userId);
    if (user) user.emailVerifiedAt = now;
  }
  async updatePasswordHash(userId: string, passwordHash: string): Promise<void> {
    const user = this.byId.get(userId);
    if (user) user.passwordHash = passwordHash;
  }
  async updateProfile(userId: string, patch: { name?: string }): Promise<void> {
    const user = this.byId.get(userId);
    if (!user) return;
    if (typeof patch.name === "string") {
      const trimmed = patch.name.trim();
      if (trimmed.length > 0 && trimmed.length <= 100) user.name = trimmed;
    }
  }
  async deleteUser(userId: string): Promise<void> {
    // Remove memberships, the org rows the user owned (when they were the
    // sole owner), and the user row. Sessions + op_log cascade on the FK
    // so this is enough in tests; in production a dedicated deletion pass
    // is the right place for object-storage cleanup (M3).
    const user = this.byId.get(userId);
    if (!user) return;
    this.byId.delete(userId);
    this.byEmail.delete(normalizeEmail(user.email));
    for (let i = this.memberships.length - 1; i >= 0; i -= 1) {
      if (this.memberships[i]!.userId === userId) this.memberships.splice(i, 1);
    }
    for (const [orgId] of this.orgs.entries()) {
      const remaining = this.memberships.filter((m) => m.orgId === orgId);
      if (remaining.length === 0) this.orgs.delete(orgId);
    }
  }
}

// Backwards-compat shims — kept so existing call sites compile. New code
// should use the OrgStore directly via `listOrgsForUser` / `ensurePersonalOrg`.
function _legacyReExport(_type: "Membership" | "Organization" | "newOrgId"): void {}

export interface AuthContext {
  userStore: UserStore;
  /** Optional: when present, signup/login mint a session and authenticate can resolve cookies. */
  sessionStore?: SessionStore;
  /** Optional: cookie name and options used when minting/clearing the session. */
  sessionCookie?: SessionCookieOptions;
  /** M1.4: email-verification token store. */
  verificationTokens?: TokenStore;
  /** M1.4: password-reset token store. */
  resetTokens?: TokenStore;
  /** M1.6: TOTP + recovery-code store. */
  totpStore?: TotpStore;
  /**
   * M1.6: where the half-authenticated "password ok, second factor pending"
   * state lives. Optional: when omitted the handlers fall back to a
   * per-process store, which is correct for one instance and is what the
   * deployment gets today. A multi-instance deployment must pass a
   * persistent implementation or the second login step 401s whenever the two
   * requests land on different instances.
   */
  pendingTwoFactorStore?: PendingTwoFactorStore;
  /** M1.6: issuer label baked into the otpauth:// URI. Default "Lucent". */
  totpIssuer?: string;
  /** M1.7: pending-account-deletion store. */
  deletionStore?: AccountDeletionStore;
  /** M1.4: mailer for sending transactional email. */
  mailer?: {
    send: (msg: { to: string; subject: string; text: string; html?: string }) => Promise<void>;
  };
  /** Origin used in the verification/reset email links (e.g. https://lucent.app). */
  siteOrigin?: string;
  secret: string;
  /** When true, the response includes a `Set-Cookie` header for the session. */
  now?: number;
}

/**
 * What a session records about the request that created it: the device string
 * and the address behind the account-settings session list, which is the one
 * surface a user has for noticing a login they did not make.
 *
 * Threaded through each call rather than parked on `AuthContext`, which is
 * built once per server and shared by every request -- a field there would be
 * two concurrent logins overwriting each other's device.
 */
export interface SessionMeta {
  userAgent?: string | null;
  ip?: string | null;
}

export interface SessionCookieOptions {
  name: string;
  cookieOptions: CookieOptions;
}

/** Public response shape that bundles both the bearer token and the user payload. */
export interface AuthSuccess {
  token: string;
  user: PublicUser;
  memberships: Membership[];
  /** New session id when one was minted; undefined if cookie auth was used. */
  sessionId?: string;
}

export interface HandleResult {
  status: number;
  body: unknown;
  /** Headers added to the response (e.g. Set-Cookie). Multiple cookies allowed. */
  headers?: Record<string, string>;
}

/** Header the handler returns to install/refresh the session cookie. */
export const SESSION_COOKIE_HEADER = "set-cookie";

/**
 * Create an account. Every new user gets a personal organization and an owner
 * membership, so ownership and permissions have something to hang on from the
 * first request rather than being retrofitted later.
 */
export async function handleSignup(
  ctx: AuthContext,
  rawBody: unknown,
  /**
   * Optional OrgStore. When present, the personal org created by
   * `userStore.ensurePersonalOrg` is also inserted into the OrgStore so the
   * org row is visible to routes that consult `OrgStore.get` (e.g. the admin
   * console's `GET /api/orgs/:id`). The Postgres-backed UserStore writes
   * directly to the shared `organizations` table; the in-memory UserStore
   * holds its own orgs map and would otherwise hide the row from OrgStore.
   * M2.1 fix.
   */
  orgStore?: import("./orgs.js").OrgStore,
  meta?: SessionMeta,
): Promise<HandleResult> {
  const body = rawBody as { email?: unknown; password?: unknown; name?: unknown };
  if (
    typeof body.email !== "string" ||
    typeof body.password !== "string" ||
    typeof body.name !== "string"
  ) {
    return {
      status: 400,
      body: { error: "invalid request", detail: "email, password, and name are required" },
    };
  }

  const errors = validateSignup({ email: body.email, password: body.password, name: body.name });
  if (errors.length > 0) return { status: 400, body: { error: "invalid credentials", errors } };

  if (await ctx.userStore.findByEmail(body.email)) {
    // Same status as a bad login would give, so this isn't an account oracle.
    return { status: 409, body: { error: "email already registered" } };
  }

  const now = ctx.now ?? Date.now();
  const user: StoredUser = {
    id: newUserId(),
    email: normalizeEmail(body.email),
    name: body.name.trim(),
    createdAt: now,
    passwordHash: await hashPassword(body.password),
    tokenVersion: 0,
    emailVerifiedAt: null,
  };
  await ctx.userStore.insert(user);
  // M2.1: every user gets a personal org on signup. The id is deterministic
  // from the user id so retries converge on the same row.
  const org = await ctx.userStore.ensurePersonalOrg(user.id, user.name, now);
  // Mirror the row + the membership into the OrgStore so admin routes
  // (M2.6 GET /api/orgs/:id) can find the org AND list its members. The
  // Postgres UserStore writes to the shared tables directly, so this is a
  // no-op there; the in-memory UserStore keeps private maps and would
  // otherwise hide both rows from OrgStore.
  if (orgStore) {
    await orgStore.insert({
      id: org.id,
      name: org.name,
      createdAt: org.createdAt,
    });
    await orgStore.setMembership({ userId: user.id, orgId: org.id, role: "owner" });
  }

  // M1.4: send the verification mail here, not only from
  // POST /api/auth/verify/request. `emailVerifiedAt` starts null and the
  // share gate (app.ts, POST /api/boards/:id/share) refuses to mint a link
  // until it is set — so without a mail at signup a brand-new account could
  // never become verified and could never share a board. Nothing else in the
  // product called the resend endpoint, which is exactly how that shipped.
  //
  // Guarded on the deps being present so a fixture (or a deployment with no
  // mail configured) still signs users up; a send failure is swallowed for
  // the same reason — the account exists and the user can resend.
  await sendVerificationEmail(ctx, user, now).catch((err: unknown) => {
    logMailFailure("signup verification", user.id, err);
  });

  const session = await mintSession(ctx, user, { ...meta, now });
  const headers =
    session && ctx.sessionCookie
      ? { [SESSION_COOKIE_HEADER]: serializeSessionCookie(ctx, session.id) }
      : undefined;

  return {
    status: 201,
    body: await authSuccess(ctx, user, session?.id),
    headers,
  };
}

/** Log in with email + password. Uniform failure so it isn't an account oracle. */
export async function handleLogin(
  ctx: AuthContext,
  rawBody: unknown,
  meta?: SessionMeta,
): Promise<HandleResult> {
  const body = rawBody as { email?: unknown; password?: unknown };
  if (typeof body.email !== "string" || typeof body.password !== "string") {
    return { status: 400, body: { error: "invalid request" } };
  }

  const user = await ctx.userStore.findByEmail(body.email);
  // Verify even when the user is missing so timing doesn't reveal existence.
  const ok = user
    ? await verifyPassword(body.password, user.passwordHash)
    : await verifyPassword(body.password, "0:0");
  if (!user || !ok) {
    return { status: 401, body: { error: "invalid email or password" } };
  }

  const now = ctx.now ?? Date.now();
  // M1.6: when 2FA is enabled the password check alone isn't enough. Return
  // a one-shot login token that the client exchanges for a session by
  // posting a TOTP / recovery code to /api/auth/2fa/verify.
  if (ctx.totpStore) {
    const cred = await ctx.totpStore.getCredential(user.id);
    if (cred) {
      const loginToken = await recordPendingTwoFactor(ctx, user.id, now);
      return { status: 200, body: { requires2fa: true, loginToken } };
    }
  }

  const session = await mintSession(ctx, user, { ...meta, now });
  const headers =
    session && ctx.sessionCookie
      ? { [SESSION_COOKIE_HEADER]: serializeSessionCookie(ctx, session.id) }
      : undefined;

  return {
    status: 200,
    body: await authSuccess(ctx, user, session?.id),
    headers,
  };
}

/** Resolve the current user from a cookie or bearer token. */
export async function handleMe(
  ctx: AuthContext,
  cookieHeader: string | undefined | null,
  bearer: string | null,
): Promise<HandleResult> {
  const user = await authenticate(ctx, cookieHeader, bearer);
  if (!user) return { status: 401, body: { error: "not authenticated" } };
  return {
    status: 200,
    body: { user: toPublicUser(user), memberships: await ctx.userStore.membershipsFor(user.id) },
  };
}

/** Sign out the current session. The cookie is cleared; the row is revoked. */
export async function handleLogout(
  ctx: AuthContext,
  cookieHeader: string | undefined | null,
): Promise<HandleResult> {
  const now = ctx.now ?? Date.now();
  // Revoke the bearer credential alongside the cookie. The cookie was the
  // visible half of the session, but the login response also minted a 7-day
  // bearer token into localStorage (and into API clients), and clearing only
  // the cookie left that token fully valid — "signed out" in one tab, still
  // authenticated from any copy of the token. `bumpTokenVersion` kills it
  // because the bearer path in `authenticate` compares `ver`; a fresh login
  // mints at the new version, so the normal flow pays nothing.
  //
  // The user id has to be read BEFORE the revoke: `find` on a revoked row
  // answers undefined, and the order was originally revoke-then-find, which
  // made this whole block a silent no-op (caught by the regression suite).
  if (ctx.sessionStore && ctx.sessionCookie) {
    const id = getCookie(parseCookies(cookieHeader), ctx.sessionCookie.name);
    if (id) {
      const session = await ctx.sessionStore.find(id, now);
      if (session) {
        await ctx.userStore.bumpTokenVersion(session.userId, now);
      }
      await ctx.sessionStore.revoke(id, now);
    }
  }
  const headers = ctx.sessionCookie
    ? { [SESSION_COOKIE_HEADER]: clearCookie(ctx.sessionCookie.name) }
    : undefined;
  return { status: 204, body: {}, headers };
}

/** Sign out everywhere: revoke every session for the current user. */
export async function handleSignoutAll(
  ctx: AuthContext,
  cookieHeader: string | undefined | null,
  bearer: string | null,
): Promise<HandleResult> {
  const user = await authenticate(ctx, cookieHeader, bearer);
  if (!user) return { status: 401, body: { error: "not authenticated" } };
  const now = ctx.now ?? Date.now();
  let revoked = 0;
  if (ctx.sessionStore) {
    revoked = await ctx.sessionStore.revokeAllForUser(user.id, now);
  }
  await ctx.userStore.bumpTokenVersion(user.id, now);
  const headers = ctx.sessionCookie
    ? { [SESSION_COOKIE_HEADER]: clearCookie(ctx.sessionCookie.name) }
    : undefined;
  return { status: 200, body: { revoked }, headers };
}

/** Device list for the settings UI: live sessions for the current user. */
export async function handleListSessions(
  ctx: AuthContext,
  cookieHeader: string | undefined | null,
  bearer: string | null,
): Promise<HandleResult> {
  const user = await authenticate(ctx, cookieHeader, bearer);
  if (!user) return { status: 401, body: { error: "not authenticated" } };
  if (!ctx.sessionStore) {
    return { status: 200, body: { sessions: [] } };
  }
  const sessions = await ctx.sessionStore.listForUser(user.id);
  return {
    status: 200,
    body: {
      sessions: sessions.map((s) => ({
        id: s.id,
        createdAt: s.createdAt,
        lastSeenAt: s.lastSeenAt,
        expiresAt: s.expiresAt,
        userAgent: s.userAgent,
        ip: s.ip,
        current: getCookie(parseCookies(cookieHeader), ctx.sessionCookie?.name ?? "") === s.id,
      })),
    },
  };
}

/** Revoke a single session by id. Owner-only (must be one of the user's sessions). */
export async function handleRevokeSession(
  ctx: AuthContext,
  sessionId: string,
  cookieHeader: string | undefined | null,
  bearer: string | null,
): Promise<HandleResult> {
  const user = await authenticate(ctx, cookieHeader, bearer);
  if (!user) return { status: 401, body: { error: "not authenticated" } };
  if (!ctx.sessionStore) return { status: 501, body: { error: "sessions disabled" } };

  const sessions = await ctx.sessionStore.listForUser(user.id);
  const target = sessions.find((s) => s.id === sessionId);
  if (!target) return { status: 404, body: { error: "session not found" } };

  const now = ctx.now ?? Date.now();
  await ctx.sessionStore.revoke(sessionId, now);
  // If the user revoked their own current cookie session, clear it too so the
  // browser doesn't keep sending a now-dead id.
  const currentId = getCookie(parseCookies(cookieHeader), ctx.sessionCookie?.name ?? "");
  const headers =
    currentId === sessionId && ctx.sessionCookie
      ? { [SESSION_COOKIE_HEADER]: clearCookie(ctx.sessionCookie.name) }
      : undefined;
  return { status: 204, body: {}, headers };
}

/**
 * Resolve a request to a user via cookie first, then bearer. Cookie auth
 * wins because the bearer token is a fallback for non-browser clients; the
 * two should never both succeed on the same request in practice.
 *
 * Returns the StoredUser, or undefined when neither credential is valid.
 * Side effect: when a session was used, `lastSeenAt` is bumped so an active
 * user keeps their sliding-window expiry fresh.
 */
export async function authenticate(
  ctx: AuthContext,
  cookieHeader: string | undefined | null,
  bearer: string | null,
): Promise<StoredUser | undefined> {
  // Cookie path: look up the session, load the user, compare tokenVersion.
  if (ctx.sessionStore && ctx.sessionCookie) {
    const id = getCookie(parseCookies(cookieHeader), ctx.sessionCookie.name);
    if (id) {
      const now = ctx.now ?? Date.now();
      const session = await ctx.sessionStore.find(id, now);
      if (session) {
        const user = await ctx.userStore.findById(session.userId);
        if (user) {
          if (session.tokenVersion === user.tokenVersion) {
            // Best-effort touch; a failure here doesn't invalidate the auth.
            void ctx.sessionStore.touch(id, now);
            return user;
          }
          // Stale session: tokenVersion bumped after this session was minted
          // (e.g. "Sign out everywhere"). Revoke silently.
          await ctx.sessionStore.revoke(id, now);
        }
      }
    }
  }

  // Bearer path: programmatic clients only. Verifies the HMAC, loads the
  // user, and compares the token's `ver` to the live `tokenVersion` — the
  // stateless twin of the cookie path's rule. Without this comparison,
  // `bumpTokenVersion` (logout, sign-out-everywhere, password reset) could
  // never reach a bearer token: HMAC-valid until `exp`, seven days out.
  //
  // A token issued before `ver` existed carries none. Treating a missing
  // `ver` as "matches everything" would leave every pre-existing token
  // unrevocable for its remaining lifetime, so it is treated as `0` —
  // which matches users who never bumped (every normal account) and
  // revokes the token on the first bump for everyone else. The gap is one
  // deployment's token lifetime at most, and the alternative is a hole
  // that never closes.
  if (bearer) {
    const payload = verifyToken(bearer, ctx.secret);
    if (payload) {
      const user = await ctx.userStore.findById(payload.userId);
      if (!user) return undefined;
      if ((payload.ver ?? 0) !== user.tokenVersion) return undefined;
      return user;
    }
  }
  return undefined;
}

export async function authSuccess(
  ctx: AuthContext,
  user: StoredUser,
  sessionId?: string,
): Promise<AuthSuccess> {
  return {
    // ver-carrying bearer token: "sign out everywhere" and logout both bump
    // `tokenVersion`, and the bearer path (authenticate) compares it, so a
    // stateless token can now be revoked the moment the user row says so.
    token: issueToken(user.id, ctx.secret, 7 * 24 * 3600, user.tokenVersion),
    user: toPublicUser(user),
    memberships: await ctx.userStore.membershipsFor(user.id),
    sessionId,
  };
}

/** Build a Set-Cookie header that installs the given session id. */
function serializeSessionCookie(ctx: AuthContext, sessionId: string): string {
  if (!ctx.sessionCookie) throw new Error("sessionCookie is required");
  return serializeCookie(ctx.sessionCookie.name, sessionId, ctx.sessionCookie.cookieOptions);
}

export type { Role };

/* ─────────────────────────── M1.6: TOTP & Recovery Codes ──────────────────── */

/**
 * Step 1 of TOTP enrollment: mint a secret, return the otpauth:// URI for
 * the client to render as a QR code. The secret isn't persisted yet — until
 * the user types a valid code from their authenticator, enrollment isn't
 * complete. The plain secret is the only thing the QR carries; storing it
 * only after the user proves possession keeps a leaked DB from being a
 * 2FA bypass.
 */
export async function handleBeginTotpEnrollment(
  ctx: AuthContext,
  cookieHeader: string | undefined | null,
  bearer: string | null,
): Promise<HandleResult> {
  const user = await authenticate(ctx, cookieHeader, bearer);
  if (!user) return { status: 401, body: { error: "not authenticated" } };
  if (!ctx.totpStore) return { status: 503, body: { error: "2FA not configured" } };
  const existing = await ctx.totpStore.getCredential(user.id);
  if (existing) {
    return {
      status: 409,
      body: { error: "2FA already enabled", action: "disable-then-re-enroll" },
    };
  }
  const { base32 } = generateTotpSecret();
  const uri = otpauthUri({
    issuer: ctx.totpIssuer ?? "Lucent",
    accountName: user.email,
    secretBase32: base32,
  });
  return { status: 200, body: { secret: base32, otpauthUri: uri } };
}

/**
 * Step 2: confirm the user can produce a valid TOTP from the secret we just
 * handed them. Persists the credential and returns the recovery codes the
 * client must show *once* — they cannot be retrieved later.
 */
export async function handleConfirmTotpEnrollment(
  ctx: AuthContext,
  body: unknown,
  cookieHeader: string | undefined | null,
  bearer: string | null,
): Promise<HandleResult> {
  const user = await authenticate(ctx, cookieHeader, bearer);
  if (!user) return { status: 401, body: { error: "not authenticated" } };
  if (!ctx.totpStore) return { status: 503, body: { error: "2FA not configured" } };
  const b = body as { secret?: unknown; code?: unknown };
  if (typeof b.secret !== "string" || typeof b.code !== "string") {
    return { status: 400, body: { error: "invalid request" } };
  }
  let secret: Buffer;
  try {
    secret = base32Decode(b.secret);
  } catch {
    return { status: 400, body: { error: "invalid secret" } };
  }
  const now = ctx.now ?? Date.now();
  // Keep the counter the enrollment code matched, not 0. The code the user
  // just typed is a live TOTP; banking its slot means it cannot be turned
  // around and replayed as a login code moments later.
  const matched = matchTotpCounter(secret, b.code, Math.floor(now / 1000));
  if (matched === undefined) {
    return { status: 400, body: { error: "code did not match" } };
  }
  await ctx.totpStore.setCredential({
    userId: user.id,
    secret: b.secret,
    enrolledAt: now,
    lastCounter: matched,
  });
  const codes = generateRecoveryCodes();
  await ctx.totpStore.removeAllRecoveryCodes(user.id);
  await ctx.totpStore.addRecoveryCodes(
    await Promise.all(
      codes.map(async (c, i) => ({
        id: `rc_${now.toString(36)}_${i.toString(36)}`,
        userId: user.id,
        codeHash: await hashRecoveryCode(c),
        createdAt: now,
        consumedAt: null,
      })),
    ),
  );
  return { status: 200, body: { recoveryCodes: codes } };
}

/**
 * Disable 2FA for the current user. Requires a current TOTP code (or a
 * recovery code) so a stolen session can't silently disable 2FA.
 */
export async function handleDisableTotp(
  ctx: AuthContext,
  body: unknown,
  cookieHeader: string | undefined | null,
  bearer: string | null,
): Promise<HandleResult> {
  const user = await authenticate(ctx, cookieHeader, bearer);
  if (!user) return { status: 401, body: { error: "not authenticated" } };
  if (!ctx.totpStore) return { status: 503, body: { error: "2FA not configured" } };
  const b = body as { code?: unknown };
  if (typeof b.code !== "string") {
    return { status: 400, body: { error: "invalid request" } };
  }
  const cred = await ctx.totpStore.getCredential(user.id);
  if (!cred) return { status: 404, body: { error: "2FA not enabled" } };
  const ok = await verifyTwoFactor(ctx, user.id, cred, b.code, ctx.now ?? Date.now());
  if (!ok) return { status: 400, body: { error: "code did not match" } };
  await ctx.totpStore.removeCredential(user.id);
  await ctx.totpStore.removeAllRecoveryCodes(user.id);
  return { status: 204, body: {} };
}

/**
 * Two-factor challenge used by `handleLogin` when the user has 2FA enabled:
 * `handleLogin` returns `{ requires2fa: true, loginToken }` first, then the
 * client posts `{ loginToken, code }` to `handleVerify2faLogin` to complete.
 *
 * The loginToken is a short-lived opaque string held in a
 * `PendingTwoFactorStore` so the password isn't replayed. It used to be a
 * module-level `Map`, which quietly made 2FA login single-instance-only; the
 * store seam means a Postgres table can take over without touching these
 * handlers. See `totpStore.ts` for the interface and the table the persistent
 * implementation needs.
 */
const LOGIN_TOKEN_TTL_MS = 5 * 60 * 1000;

/**
 * Fallback used when no store was wired. Keeping the process-local store as
 * the default preserves today's behaviour exactly — a single instance keeps
 * working with no configuration — while `ctx.pendingTwoFactorStore` is the
 * seam a scaled-out deployment fills in.
 */
const processPendingTwoFactor = new InMemoryPendingTwoFactorStore();

function pendingStore(ctx: AuthContext): PendingTwoFactorStore {
  return ctx.pendingTwoFactorStore ?? processPendingTwoFactor;
}

/** Used by `handleLogin` when the user has 2FA enabled. */
export async function recordPendingTwoFactor(
  ctx: AuthContext,
  userId: string,
  now: number = Date.now(),
): Promise<string> {
  const store = pendingStore(ctx);
  // Opportunistic prune keeps the in-memory map bounded on a long-running
  // process without a dedicated timer; the Postgres impl will make this a
  // cheap DELETE and can also be driven from the boot-time prune pass.
  void store.prune(now);
  return store.issue(userId, now, LOGIN_TOKEN_TTL_MS);
}

/** Test helper. Clears only the process-local fallback store. */
export function _clearPendingTwoFactorForTests(): void {
  processPendingTwoFactor.clear();
}

/**
 * Consume a TOTP / recovery code and authenticate the caller. Returns the
 * authenticated user, or undefined. Side effect: mints a session (when one
 * was configured at login time) so the client lands on an authenticated
 * board.
 */
export async function handleVerifyTwoFactorLogin(
  ctx: AuthContext,
  body: unknown,
  cookieHeader: string | undefined | null,
  meta?: SessionMeta,
): Promise<HandleResult> {
  if (!ctx.totpStore) return { status: 503, body: { error: "2FA not configured" } };
  const b = body as { loginToken?: unknown; code?: unknown };
  if (typeof b.loginToken !== "string" || typeof b.code !== "string") {
    return { status: 400, body: { error: "invalid request" } };
  }
  const now = ctx.now ?? Date.now();
  // `take` deletes on every hit, so a loginToken is good for one attempt
  // whether or not the code that came with it was right.
  const pending = await pendingStore(ctx).take(b.loginToken, now);
  if (!pending) {
    return { status: 401, body: { error: "login session expired" } };
  }
  const user = await ctx.userStore.findById(pending.userId);
  if (!user) return { status: 401, body: { error: "invalid login" } };
  const cred = await ctx.totpStore.getCredential(user.id);
  if (!cred) return { status: 401, body: { error: "2FA not enabled" } };
  const ok = await verifyTwoFactor(ctx, user.id, cred, b.code, now);
  if (!ok) return { status: 401, body: { error: "code did not match" } };
  const session = await mintSession(ctx, user, { ...meta, now });
  const headers =
    session && ctx.sessionCookie
      ? { "set-cookie": serializeSessionCookie(ctx, session.id) }
      : undefined;
  return {
    status: 200,
    body: {
      user: toPublicUser(user),
      // ver-carrying, same as authSuccess (see there for why).
      token: issueToken(user.id, ctx.secret, 7 * 24 * 3600, user.tokenVersion),
      sessionId: session?.id,
      memberships: await ctx.userStore.membershipsFor(user.id),
    },
    headers,
  };
}

/**
 * Try the candidate against the TOTP, then any live recovery code.
 *
 * The TOTP branch is where replay is stopped. `verifyTotp` on its own only
 * answers "is this code live in the ±1 window", which means a code observed
 * over the user's shoulder, in a phishing proxy, or in a log is good for the
 * rest of its 30-second slot — and `lastCounter` was written as 0 at
 * enrollment and never updated, so nothing closed that window. Here the
 * matched counter is compared against the stored watermark and then banked,
 * making each code usable exactly once (RFC 6238 §5.2).
 */
async function verifyTwoFactor(
  ctx: AuthContext,
  userId: string,
  cred: StoredTotpCredential,
  candidate: string,
  now: number,
): Promise<boolean> {
  if (!ctx.totpStore) return false;
  const secondsNow = Math.floor(now / 1000);
  // TOTP path: decode the stored secret and verify the candidate with a
  // single-period window (the strict window here is correct: the user is
  // proving they have the device right now, not absorbing drift).
  try {
    const secret = base32Decode(cred.secret);
    const matched = matchTotpCounter(secret, candidate, secondsNow, 1);
    if (matched !== undefined) {
      // A counter at or below the watermark is a replay — including the code
      // the user typed to finish enrollment, which is banked there.
      if (matched <= cred.lastCounter) return false;
      await ctx.totpStore.setLastCounter(userId, matched);
      return true;
    }
  } catch {
    // Unparseable stored secret. Fall through to the recovery-code path so a
    // corrupted credential doesn't lock the user out of their own account.
  }
  // The store holds `salt:hash`; `verifyRecoveryCode` extracts the salt and
  // runs scrypt on the candidate so a single stored hash can verify an
  // arbitrary typed input. The store consumes the row it matched, which is
  // what makes a recovery code single-use.
  return ctx.totpStore.tryConsumeRecoveryCode(userId, candidate, verifyRecoveryCode, now);
}

/** Helper for the call sites that mint the actual session after auth success. */
export async function mintSession(
  ctx: AuthContext,
  user: StoredUser,
  meta: { userAgent?: string | null; ip?: string | null; now?: number },
): Promise<StoredSession | undefined> {
  if (!ctx.sessionStore) return undefined;
  const now = meta.now ?? ctx.now ?? Date.now();
  return ctx.sessionStore.create({
    userId: user.id,
    tokenVersion: user.tokenVersion,
    now,
    userAgent: meta.userAgent ?? null,
    ip: meta.ip ?? null,
  });
}

/* ─────────────────────────── M1.7: Account Lifecycle ─────────────────────── */

import type { AccountDeletionStore } from "./accountDeletion.js";
export { InMemoryAccountDeletionStore, PostgresAccountDeletionStore } from "./accountDeletion.js";

/** Default grace window for scheduled deletion. */
export const DELETE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/** M1.7: profile update — currently only `name`. Email change is out of scope here. */
export async function handleUpdateProfile(
  ctx: AuthContext,
  body: unknown,
  cookieHeader: string | undefined | null,
  bearer: string | null,
): Promise<HandleResult> {
  const user = await authenticate(ctx, cookieHeader, bearer);
  if (!user) return { status: 401, body: { error: "not authenticated" } };
  const b = body as { name?: unknown };
  if (typeof b.name !== "string") return { status: 400, body: { error: "invalid request" } };
  if (b.name.trim().length === 0 || b.name.length > 100) {
    return { status: 400, body: { error: "name must be 1–100 characters" } };
  }
  await ctx.userStore.updateProfile(user.id, { name: b.name });
  const after = await ctx.userStore.findById(user.id);
  return { status: 200, body: { user: toPublicUser(after!) } };
}

/**
 * M1.7: data export (GDPR). Returns every byte of user-attributed data the
 * server holds, in a stable JSON shape the client can save or pipe to a
 * request-bucket. Includes memberships, owned boards (with their workspaces
 * inline), and the public profile.
 */
export async function handleAccountExport(
  ctx: AuthContext,
  boardListForUser: (
    userId: string,
  ) => Promise<
    Array<{ id: string; name: string; workspace: unknown; createdAt: number; updatedAt: number }>
  >,
  cookieHeader: string | undefined | null,
  bearer: string | null,
): Promise<HandleResult> {
  const user = await authenticate(ctx, cookieHeader, bearer);
  if (!user) return { status: 401, body: { error: "not authenticated" } };
  const memberships = await ctx.userStore.membershipsFor(user.id);
  const boards = await boardListForUser(user.id);
  return {
    status: 200,
    body: {
      exportedAt: Date.now(),
      user: toPublicUser(user),
      memberships,
      boards,
    },
  };
}

/**
 * M1.7: schedule deletion. The grace window is 7 days; the user can sign
 * back in during that window to cancel. After `executesAt`, an attempt to
 * authenticate will trigger the wipe (see `runScheduledDeletions`).
 */
export async function handleScheduleDeletion(
  ctx: AuthContext,
  cookieHeader: string | undefined | null,
  bearer: string | null,
): Promise<HandleResult> {
  const user = await authenticate(ctx, cookieHeader, bearer);
  if (!user) return { status: 401, body: { error: "not authenticated" } };
  if (!ctx.deletionStore) return { status: 503, body: { error: "deletion not configured" } };
  const now = ctx.now ?? Date.now();
  await ctx.deletionStore.schedule(user.id, now, now + DELETE_GRACE_MS);
  // Revoke every session now so a hijacker can't sit on the account during
  // the grace window.
  await ctx.userStore.bumpTokenVersion(user.id, now);
  if (ctx.sessionStore) await ctx.sessionStore.revokeAllForUser(user.id, now);
  return { status: 200, body: { executesAt: now + DELETE_GRACE_MS, graceMs: DELETE_GRACE_MS } };
}

/** M1.7: cancel a scheduled deletion. */
export async function handleCancelDeletion(
  ctx: AuthContext,
  cookieHeader: string | undefined | null,
  bearer: string | null,
): Promise<HandleResult> {
  const user = await authenticate(ctx, cookieHeader, bearer);
  if (!user) return { status: 401, body: { error: "not authenticated" } };
  if (!ctx.deletionStore) return { status: 503, body: { error: "deletion not configured" } };
  const now = ctx.now ?? Date.now();
  await ctx.deletionStore.cancel(user.id, now);
  return { status: 200, body: { cancelledAt: now } };
}

/**
 * M1.7: run any matured deletions. Called at boot and (optionally) on a
 * timer. Returns the user ids that were wiped, so the caller can log it.
 */
export async function runScheduledDeletions(
  ctx: AuthContext,
  now: number = Date.now(),
): Promise<string[]> {
  if (!ctx.deletionStore) return [];
  const matured = await ctx.deletionStore.matured(now);
  const wiped: string[] = [];
  for (const d of matured) {
    await ctx.userStore.deleteUser(d.userId);
    await ctx.deletionStore.remove(d.userId);
    wiped.push(d.userId);
  }
  return wiped;
}

/* ─────────────────────────── M1.4: Verification & Reset ───────────────────── */

/** Verification email TTL. 24 hours gives users plenty of time to click. */
const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
/** Reset email TTL. 1 hour — a faster window since the user is actively trying. */
const RESET_TTL_MS = 60 * 60 * 1000;

/**
 * Issue a verification token and mail the link.
 *
 * Returns false when the operator hasn't configured mail (no token store, no
 * mailer, or no site origin to build a link against) — the caller decides
 * whether that's a 503 or a silent skip, because the two call sites differ:
 * `handleRequestVerification` was asked for a mail and should say it can't,
 * while `handleSignup` must still create the account.
 *
 * Rejects with whatever the mailer or token store threw; every caller has to
 * decide what a send failure means for its own response.
 */
async function sendVerificationEmail(
  ctx: AuthContext,
  user: StoredUser,
  now: number,
): Promise<boolean> {
  if (!ctx.verificationTokens || !ctx.mailer || !ctx.siteOrigin) return false;
  const { raw } = await ctx.verificationTokens.issue({
    userId: user.id,
    ttlMs: VERIFICATION_TTL_MS,
    now,
  });
  const tpl = verificationEmail({ siteOrigin: ctx.siteOrigin }, raw, user.email);
  await ctx.mailer.send({
    to: user.email,
    subject: tpl.subject,
    text: tpl.text,
    html: tpl.html,
  });
  return true;
}

/**
 * A failed transactional send is an operational problem, not a request
 * failure, so it is logged rather than propagated. The user id is logged, the
 * email address is not — a log aggregator shouldn't become a second copy of
 * the user table.
 */
function logMailFailure(what: string, userId: string, err: unknown): void {
  console.warn(
    `[mail] ${what} failed for user=${userId}: ${(err as Error)?.message ?? String(err)}`,
  );
}

/**
 * Issue a verification token and (if a mailer is configured) send the email.
 * Always returns 204 so the endpoint isn't an account oracle: a request for a
 * non-existent email produces the same response shape as a request for a real
 * one. The downside is that typos don't surface as errors, which is the
 * standard trade for the same shape on both paths.
 */
export async function handleRequestVerification(
  ctx: AuthContext,
  rawBody: unknown,
): Promise<HandleResult> {
  const body = rawBody as { email?: unknown };
  if (typeof body.email !== "string") {
    return { status: 400, body: { error: "invalid request" } };
  }
  const user = await ctx.userStore.findByEmail(body.email);
  if (!user) {
    return { status: 204, body: {} };
  }
  if (!ctx.verificationTokens || !ctx.mailer || !ctx.siteOrigin) {
    // The route is wired but the operator hasn't configured mail — surface
    // a real error rather than silently no-op.
    return { status: 503, body: { error: "verification not configured" } };
  }
  const now = ctx.now ?? Date.now();
  await sendVerificationEmail(ctx, user, now);
  return { status: 204, body: {} };
}

/**
 * Redeem a verification token. Marks the user's email verified, consumes the
 * token, and returns the user payload so the client can log them in.
 */
export async function handleVerifyEmail(
  ctx: AuthContext,
  rawToken: string | undefined,
): Promise<HandleResult> {
  if (!rawToken || !ctx.verificationTokens) {
    return { status: 400, body: { error: "missing or invalid token" } };
  }
  const now = ctx.now ?? Date.now();
  const token = await ctx.verificationTokens.findByRawToken(rawToken, now);
  if (!token) return { status: 400, body: { error: "invalid or expired token" } };
  await ctx.userStore.setEmailVerified(token.userId, now);
  await ctx.verificationTokens.consume(token.id, now);
  const user = await ctx.userStore.findById(token.userId);
  if (!user) return { status: 400, body: { error: "invalid token" } };
  return { status: 200, body: { user: toPublicUser(user) } };
}

/**
 * Issue a password-reset token. Same shape as verification: always 204 to
 * avoid the account-oracle leak, with the email sent only when a mailer is
 * configured and the user actually exists.
 */
export async function handleRequestPasswordReset(
  ctx: AuthContext,
  rawBody: unknown,
): Promise<HandleResult> {
  const body = rawBody as { email?: unknown };
  if (typeof body.email !== "string") {
    return { status: 400, body: { error: "invalid request" } };
  }
  const user = await ctx.userStore.findByEmail(body.email);
  if (!user) return { status: 204, body: {} };
  if (!ctx.resetTokens || !ctx.mailer || !ctx.siteOrigin) {
    return { status: 503, body: { error: "password reset not configured" } };
  }
  const now = ctx.now ?? Date.now();
  const { raw } = await ctx.resetTokens.issue({ userId: user.id, ttlMs: RESET_TTL_MS, now });
  const tpl = passwordResetEmail({ siteOrigin: ctx.siteOrigin }, raw);
  await ctx.mailer.send({ to: user.email, subject: tpl.subject, text: tpl.text, html: tpl.html });
  return { status: 204, body: {} };
}

/**
 * Redeem a reset token + new password. Replaces the password hash, consumes
 * the token, and bumps tokenVersion so any session that's still alive gets
 * dropped at the next request — a stolen reset email is the textbook case
 * where this matters.
 */
export async function handleResetPassword(
  ctx: AuthContext,
  rawToken: string | undefined,
  newPassword: string | undefined,
): Promise<HandleResult> {
  if (!rawToken || typeof newPassword !== "string") {
    return { status: 400, body: { error: "invalid request" } };
  }
  if (newPassword.length < 8) {
    return { status: 400, body: { error: "password too short" } };
  }
  if (!ctx.resetTokens) return { status: 400, body: { error: "invalid token" } };
  const now = ctx.now ?? Date.now();
  const token = await ctx.resetTokens.findByRawToken(rawToken, now);
  if (!token) return { status: 400, body: { error: "invalid or expired token" } };
  await ctx.userStore.updatePasswordHash(token.userId, await hashPassword(newPassword));
  await ctx.userStore.bumpTokenVersion(token.userId, now);
  await ctx.resetTokens.consume(token.id, now);
  if (ctx.sessionStore) {
    await ctx.sessionStore.revokeAllForUser(token.userId, now);
  }
  return { status: 200, body: { ok: true } };
}
