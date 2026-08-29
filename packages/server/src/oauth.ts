import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Config } from "./config.js";
import type { UserStore } from "./accounts.js";
import { normalizeEmail, type StoredUser } from "./identity.js";
import type { OrgStore } from "./orgs.js";

/**
 * Federated sign-in (M1.8): Google and GitHub OAuth 2.0, landing on the same
 * accounts password sign-in produces.
 *
 * The security argument, in the order the code enforces it:
 *
 *  - THE STATE PARAMETER IS CSRF FOR THE REDIRECT. Without it, anyone who can
 *    craft a callback URL can complete a flow they started and land a victim
 *    on an account the attacker controls (login CSRF), or trade a victim's
 *    code for the attacker's session. The state here is an HMAC-signed
 *    payload — provider, nonce, expiry — AND it is mirrored in a short-lived
 *    cookie that only the browser which started the flow holds. The callback
 *    requires the query state and the cookie state to be the same string, so
 *    a callback URL replayed into a different browser fails before any
 *    network call is made.
 *
 *  - LINKING IS BY VERIFIED EMAIL ONLY (db/schema.ts says the same). An
 *    unverified email at a provider is a claim, not a fact: anyone can open
 *    that provider, set any address as unverified, and this endpoint would
 *    otherwise hand them the Lucent account that owns the address. So an
 *    unverified email can only ever create a brand-new account; it can never
 *    merge into an existing one.
 *
 *  - NO PASSWORD, NO PROBLEM. OAuth-created users carry an unusable password
 *    hash (`oauth:` prefix): `verifyPassword` fails on the shape alone, so a
 *    password login is impossible without a reset, which is the same posture
 *    every "sign in with X" account has.
 *
 * The module is transport-free by design: every HTTP call goes through an
 * injected `fetch` so tests (and a future proxy) can substitute the network.
 */

export type OauthProviderName = "google" | "github";

export interface OauthProviderSetup {
  clientId: string;
  clientSecret: string;
}

/** Per-deployment OAuth config. Both halves of a provider or neither. */
export interface OauthConfig {
  google?: OauthProviderSetup;
  github?: OauthProviderSetup;
}

interface ProviderSpec {
  authorizationUrl: string;
  tokenUrl: string;
  /** Scopes that must include everything `fetchProfile` needs. */
  scope: string;
}

const PROVIDERS: Record<OauthProviderName, ProviderSpec> = {
  google: {
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scope: "openid email profile",
  },
  github: {
    authorizationUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    scope: "read:user user:email",
  },
};

export const OAUTH_PROVIDER_NAMES = Object.keys(PROVIDERS) as OauthProviderName[];

export function isOauthProviderName(value: string): value is OauthProviderName {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, value);
}

/** Both halves configured, or nothing: a half-configured provider 503s. */
export function providerConfigured(oauth: OauthConfig, name: OauthProviderName): boolean {
  const setup = oauth[name];
  return Boolean(setup?.clientId && setup?.clientSecret);
}

/* ------------------------------- state ------------------------------------ */

const DEFAULT_STATE_TTL_MS = 10 * 60_000;

interface StatePayload {
  /** The provider the state was minted for. Bound so state can't be reused across providers. */
  p: OauthProviderName;
  /** Random nonce; makes every state unique. */
  n: string;
  /** Expiry, epoch ms. */
  exp: number;
}

const base64url = (buf: Buffer) =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromBase64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

/**
 * Mint one flow's state. Same compact `payload.hmac` shape as the session
 * token (auth.ts), for the same reason: verifiable without a store, so the
 * flow survives a process restart mid-handshake.
 */
export function mintOauthState(secret: string, provider: OauthProviderName, now: number): string {
  const payload: StatePayload = {
    p: provider,
    n: randomBytes(16).toString("hex"),
    exp: now + DEFAULT_STATE_TTL_MS,
  };
  const body = base64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = base64url(createHmac("sha256", secret).update(body).digest());
  return `${body}.${sig}`;
}

export type StateFailure = "malformed" | "bad_signature" | "expired" | "provider_mismatch";

export function verifyOauthState(
  secret: string,
  provider: OauthProviderName,
  state: string,
  now: number,
): { ok: true } | { ok: false; reason: StateFailure } {
  const [body, sig] = state.split(".");
  if (!body || !sig) return { ok: false, reason: "malformed" };
  const expected = createHmac("sha256", secret).update(body).digest();
  const actual = fromBase64url(sig);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { ok: false, reason: "bad_signature" };
  }
  let payload: StatePayload;
  try {
    payload = JSON.parse(fromBase64url(body).toString("utf8")) as StatePayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (payload.p !== provider) return { ok: false, reason: "provider_mismatch" };
  if (typeof payload.exp !== "number" || payload.exp <= now) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true };
}

/* ---------------------------- provider calls ------------------------------ */

/** Where the provider sends the browser back, and what the code is traded for. */
export function oauthRedirectUri(base: Config["webOrigin"], provider: OauthProviderName): string {
  return `${base.replace(/\/+$/, "")}/api/auth/oauth/${provider}/callback`;
}

export function authorizationUrl(
  oauth: OauthConfig,
  provider: OauthProviderName,
  redirectUri: string,
  state: string,
): string {
  const spec = PROVIDERS[provider];
  const setup = oauth[provider]!;
  const url = new URL(spec.authorizationUrl);
  url.searchParams.set("client_id", setup.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", spec.scope);
  url.searchParams.set("state", state);
  if (provider === "google") {
    // Force the account chooser: without it Google silently reuses whatever
    // account the browser is signed into, which is how the wrong person ends
    // up owning a workspace.
    url.searchParams.set("prompt", "select_account");
  }
  return url.toString();
}

export interface OauthProfile {
  /** The provider's stable id (`sub` for OIDC, numeric id for GitHub). */
  providerAccountId: string;
  email: string | null;
  /** Did the PROVIDER vouch for the email? Only a yes may link accounts. */
  emailVerified: boolean;
  name: string | null;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Trade the authorization code for an access token, then read the profile.
 * Two calls, one per fact: the token proves the user approved, the profile
 * says who. Errors throw with a short reason string that the route turns
 * into a redirect — the user is standing on a provider page, not an API
 * console, and a JSON error body would be a dead end.
 */
export async function exchangeCodeForProfile(
  oauth: OauthConfig,
  provider: OauthProviderName,
  redirectUri: string,
  code: string,
  fetchImpl: FetchLike = fetch,
): Promise<OauthProfile> {
  const spec = PROVIDERS[provider];
  const setup = oauth[provider]!;
  const tokenRes = await fetchImpl(spec.tokenUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams({
      client_id: setup.clientId,
      client_secret: setup.clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });
  if (!tokenRes.ok) {
    throw new Error(`token exchange failed (${tokenRes.status})`);
  }
  const tokenBody = (await tokenRes.json()) as { access_token?: unknown };
  if (typeof tokenBody.access_token !== "string" || tokenBody.access_token === "") {
    throw new Error("token exchange returned no access token");
  }
  const accessToken = tokenBody.access_token;

  return provider === "google"
    ? googleProfile(accessToken, fetchImpl)
    : githubProfile(accessToken, fetchImpl);
}

async function googleProfile(accessToken: string, fetchImpl: FetchLike): Promise<OauthProfile> {
  const res = await fetchImpl("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`profile fetch failed (${res.status})`);
  const body = (await res.json()) as {
    sub?: unknown;
    email?: unknown;
    email_verified?: unknown;
    name?: unknown;
  };
  if (typeof body.sub !== "string" || body.sub === "") {
    throw new Error("profile has no subject id");
  }
  return {
    providerAccountId: body.sub,
    email: typeof body.email === "string" ? normalizeEmail(body.email) : null,
    // `email_verified` absent reads as unverified: linking requires a
    // provider-vouched boolean, never an inference from a missing field.
    emailVerified: body.email_verified === true,
    name: typeof body.name === "string" && body.name.trim() !== "" ? body.name.trim() : null,
  };
}

async function githubProfile(accessToken: string, fetchImpl: FetchLike): Promise<OauthProfile> {
  const headers = {
    authorization: `Bearer ${accessToken}`,
    accept: "application/vnd.github+json",
    // GitHub API requires a UA; without one the request is refused outright.
    "user-agent": "lucent",
  };
  const userRes = await fetchImpl("https://api.github.com/user", { headers });
  if (!userRes.ok) throw new Error(`profile fetch failed (${userRes.status})`);
  const user = (await userRes.json()) as { id?: unknown; login?: unknown; name?: unknown };
  if (typeof user.id !== "number") throw new Error("profile has no user id");

  // `user.email` is null whenever the user set their address private; the
  // emails endpoint is the only place a verified address is visible to a
  // token with `user:email`.
  const emailsRes = await fetchImpl("https://api.github.com/user/emails", { headers });
  const emails = emailsRes.ok
    ? ((await emailsRes.json()) as Array<{
        email?: unknown;
        verified?: unknown;
        primary?: unknown;
      }>)
    : [];
  const pick =
    emails.find((e) => e.primary === true && e.verified === true) ??
    emails.find((e) => e.verified === true) ??
    null;

  return {
    providerAccountId: String(user.id),
    email: pick && typeof pick.email === "string" ? normalizeEmail(pick.email) : null,
    emailVerified: pick !== null,
    name: typeof user.name === "string" && user.name.trim() !== "" ? user.name.trim() : null,
  };
}

/* --------------------------- identity resolution -------------------------- */

export interface OauthIdentity {
  provider: OauthProviderName;
  providerAccountId: string;
  userId: string;
}

/**
 * The two identity methods the flow needs, declared here rather than imported
 * so the resolver's surface stays exactly what it reads (accounts.ts does the
 * same with `EntitlementSource`). Implementations live on the stores.
 */
export interface OauthIdentityStore {
  findOauthIdentity(
    provider: OauthProviderName,
    providerAccountId: string,
  ): Promise<OauthIdentity | undefined>;
  linkOauthIdentity(identity: OauthIdentity & { email: string | null; now: number }): Promise<void>;
}

export type OauthResolution =
  | { kind: "user"; user: StoredUser; linked: "existing" | "new" | "fresh-identity" }
  | { kind: "error"; reason: string };

/**
 * Turn a provider profile into the user who is about to be signed in.
 *
 * Identity first, verified email second, creation last — the order matters
 * because the first two are lookups on facts already on file, and only the
 * third grows the account list. An unverified email stops at "error": there
 * is nothing it may safely match.
 */
export async function resolveOauthUser(
  deps: { userStore: UserStore & OauthIdentityStore; orgStore?: OrgStore },
  provider: OauthProviderName,
  profile: OauthProfile,
  now: number,
): Promise<OauthResolution> {
  const { userStore } = deps;

  // 1. This exact provider identity has signed in before.
  const known = await userStore.findOauthIdentity(provider, profile.providerAccountId);
  if (known) {
    const user = await userStore.findById(known.userId);
    if (!user) return { kind: "error", reason: "linked account no longer exists" };
    return { kind: "user", user, linked: "existing" };
  }

  // 2. A verified email matching an existing account: link, don't duplicate.
  if (profile.email && profile.emailVerified) {
    const existing = await userStore.findByEmail(profile.email);
    if (existing) {
      await userStore.linkOauthIdentity({
        provider,
        providerAccountId: profile.providerAccountId,
        userId: existing.id,
        email: profile.email,
        now,
      });
      return { kind: "user", user: existing, linked: "fresh-identity" };
    }
  } else if (profile.email && !profile.emailVerified) {
    return {
      kind: "error",
      reason: "provider did not verify your email; set a password instead",
    };
  }

  // 3. Brand-new account. The email (if any) was provider-verified, so mark
  // it verified: re-challenging a fact the provider just vouched for teaches
  // users to click links out of habit.
  const name = profile.name ?? profile.email?.split("@")[0] ?? "New user";
  const user: StoredUser = {
    id: `usr_oauth_${randomBytes(12).toString("hex")}`,
    email: profile.email
      ? normalizeEmail(profile.email)
      : `oauth-${provider}-${profile.providerAccountId}@invalid.lucent`,
    name,
    createdAt: now,
    // Unusable by construction: verifyPassword rejects the shape before it
    // ever runs scrypt, so these accounts have no password until a reset.
    passwordHash: "oauth:no-password",
    tokenVersion: 0,
    emailVerifiedAt: profile.emailVerified ? now : null,
  };
  await userStore.insert(user);
  const org = await userStore.ensurePersonalOrg(user.id, user.name, now);
  // Mirror handleSignup: keep the OrgStore (the admin console's read side)
  // from missing a row the in-memory UserStore holds privately.
  if (deps.orgStore && (await deps.orgStore.get(org.id)) === undefined) {
    await deps.orgStore.insert(org);
  }
  await userStore.linkOauthIdentity({
    provider,
    providerAccountId: profile.providerAccountId,
    userId: user.id,
    email: profile.email,
    now,
  });
  return { kind: "user", user, linked: "new" };
}
