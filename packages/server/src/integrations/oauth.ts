import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IntegrationCredentialStore } from "./credentials.js";
import type { TokenBox } from "./tokenBox.js";

/**
 * OAuth connect for Linear and Jira (docs/26 A5). An owner clicks "Connect
 * with Linear", approves in Linear, and comes back connected — no API key
 * copied into a server variable.
 *
 * - The `state` is signed (HMAC with the app secret) and carries the org, the
 *   person who started it, the provider and what they entered, with a
 *   ten-minute expiry. The callback only completes for that same person, still
 *   an owner, so a link can't connect someone else's workspace.
 * - Linear gets PKCE, its verifier derived from the state's nonce under the
 *   secret — nothing to store between the two requests.
 * - Tokens are sealed at rest (tokenBox) and refreshed a minute before they
 *   expire. A refresh the provider refuses is the connection's `needs-reauth`.
 */

export const OAUTH_REF = "oauth";
export const OAUTH_PROVIDERS = ["linear", "jira"] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

/** How people know them. */
export const OAUTH_NAMES: Record<OAuthProvider, string> = { linear: "Linear", jira: "Jira" };

export function isOAuthProvider(value: string): value is OAuthProvider {
  return (OAUTH_PROVIDERS as readonly string[]).includes(value);
}

export interface OAuthSpec {
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  scopeSeparator: string;
  pkce: boolean;
  /** How the token endpoint wants its body. */
  tokenBody: "form" | "json";
  authorizeParams?: Record<string, string>;
  /** Jira: where a token learns which sites it may reach. */
  resourcesUrl?: string;
}

export const OAUTH_SPECS: Record<OAuthProvider, OAuthSpec> = {
  linear: {
    authorizeUrl: "https://linear.app/oauth/authorize",
    tokenUrl: "https://api.linear.app/oauth/token",
    scopes: ["read", "write"],
    scopeSeparator: ",",
    pkce: true,
    tokenBody: "form",
    authorizeParams: { prompt: "consent" },
  },
  jira: {
    authorizeUrl: "https://auth.atlassian.com/authorize",
    tokenUrl: "https://auth.atlassian.com/oauth/token",
    scopes: ["read:jira-work", "write:jira-work", "read:jira-user", "offline_access"],
    scopeSeparator: " ",
    pkce: false,
    tokenBody: "json",
    authorizeParams: { audience: "api.atlassian.com", prompt: "consent" },
    resourcesUrl: "https://api.atlassian.com/oauth/token/accessible-resources",
  },
};

export interface OAuthApp {
  clientId: string;
  clientSecret: string;
}

export interface OAuthDeps {
  apps: Partial<Record<OAuthProvider, OAuthApp>>;
  box: TokenBox;
  credentials: IntegrationCredentialStore;
  fetchImpl?: typeof fetch;
  /** Tests point the endpoints at a stub; production never sets this. */
  specs?: Partial<Record<OAuthProvider, Partial<OAuthSpec>>>;
  now?: () => number;
}

/** The OAuth settings the server was started with, or null (no key or no app). */
export function oauthFromEnv(
  env: NodeJS.ProcessEnv,
  box: TokenBox | null,
  credentials: IntegrationCredentialStore,
): OAuthDeps | null {
  if (!box) return null;
  const apps: Partial<Record<OAuthProvider, OAuthApp>> = {};
  for (const provider of OAUTH_PROVIDERS) {
    const upper = provider.toUpperCase();
    const clientId = env[`LUCENT_${upper}_CLIENT_ID`];
    const clientSecret = env[`LUCENT_${upper}_CLIENT_SECRET`];
    if (clientId && clientSecret) apps[provider] = { clientId, clientSecret };
  }
  return Object.keys(apps).length > 0 ? { apps, box, credentials } : null;
}

export class OAuthError extends Error {
  constructor(
    message: string,
    /** 401 = the credential is gone or refused: the connection needs re-auth. */
    readonly status: number,
  ) {
    super(message);
    this.name = "OAuthError";
  }
}

function spec(deps: OAuthDeps, provider: OAuthProvider): OAuthSpec {
  return { ...OAUTH_SPECS[provider], ...deps.specs?.[provider] };
}

/* ------------------------------------------------------------------ state */

export interface OAuthState {
  /** org */
  o: string;
  /** the person who started it */
  u: string;
  p: OAuthProvider;
  /** what they entered (teamId, projectKey, site) — not secret */
  c: Record<string, string>;
  /** nonce */
  n: string;
  /** expiry, epoch ms */
  e: number;
}

const STATE_TTL_MS = 10 * 60_000;

function mac(secret: string, text: string): string {
  return createHmac("sha256", secret).update(text).digest("base64url");
}

export function signState(
  secret: string,
  fields: Omit<OAuthState, "n" | "e">,
  now: number,
): { token: string; state: OAuthState } {
  const state: OAuthState = {
    ...fields,
    n: randomBytes(16).toString("base64url"),
    e: now + STATE_TTL_MS,
  };
  const body = Buffer.from(JSON.stringify(state)).toString("base64url");
  return { token: `${body}.${mac(secret, `oauth-state:${body}`)}`, state };
}

export function verifyState(secret: string, token: string, now: number): OAuthState | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = Buffer.from(mac(secret, `oauth-state:${body}`));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const state = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as OAuthState;
    if (typeof state.e !== "number" || state.e < now || !isOAuthProvider(state.p)) return null;
    return state;
  } catch {
    return null;
  }
}

/** PKCE, derived: the verifier never leaves the server until the exchange. */
export function pkceVerifier(secret: string, nonce: string): string {
  return mac(secret, `oauth-pkce:${nonce}`);
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function authorizeUrl(
  deps: OAuthDeps,
  provider: OAuthProvider,
  redirectUri: string,
  stateToken: string,
  verifier: string,
): string {
  const s = spec(deps, provider);
  const app = deps.apps[provider]!;
  const url = new URL(s.authorizeUrl);
  url.searchParams.set("client_id", app.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", s.scopes.join(s.scopeSeparator));
  url.searchParams.set("state", stateToken);
  for (const [k, v] of Object.entries(s.authorizeParams ?? {})) url.searchParams.set(k, v);
  if (s.pkce) {
    url.searchParams.set("code_challenge", pkceChallenge(verifier));
    url.searchParams.set("code_challenge_method", "S256");
  }
  return url.toString();
}

/* ------------------------------------------------------------------ tokens */

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
}

async function tokenRequest(
  deps: OAuthDeps,
  provider: OAuthProvider,
  params: Record<string, string>,
): Promise<TokenSet> {
  const s = spec(deps, provider);
  const app = deps.apps[provider]!;
  const fields = { ...params, client_id: app.clientId, client_secret: app.clientSecret };
  const res = await (deps.fetchImpl ?? fetch)(s.tokenUrl, {
    method: "POST",
    headers: {
      "content-type":
        s.tokenBody === "json" ? "application/json" : "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: s.tokenBody === "json" ? JSON.stringify(fields) : new URLSearchParams(fields).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
    scope?: unknown;
    error?: unknown;
  };
  if (!res.ok || typeof body.access_token !== "string") {
    // A code or refresh token the provider won't take can't be retried into
    // working: the owner has to connect again.
    const reason = typeof body.error === "string" ? body.error : `status ${res.status}`;
    throw new OAuthError(
      `${OAUTH_NAMES[provider]} refused the token request (${reason})`,
      res.status >= 500 ? res.status : 401,
    );
  }
  const now = (deps.now ?? Date.now)();
  return {
    accessToken: body.access_token,
    ...(typeof body.refresh_token === "string" ? { refreshToken: body.refresh_token } : {}),
    ...(typeof body.expires_in === "number" ? { expiresAt: now + body.expires_in * 1000 } : {}),
    ...(typeof body.scope === "string" ? { scope: body.scope } : {}),
  };
}

export function exchangeCode(
  deps: OAuthDeps,
  provider: OAuthProvider,
  code: string,
  redirectUri: string,
  verifier: string,
): Promise<TokenSet> {
  return tokenRequest(deps, provider, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    ...(spec(deps, provider).pkce ? { code_verifier: verifier } : {}),
  });
}

/** Jira: the sites this token may reach. */
export async function jiraSites(
  deps: OAuthDeps,
  accessToken: string,
): Promise<Array<{ id: string; url: string; name: string }>> {
  const res = await (deps.fetchImpl ?? fetch)(spec(deps, "jira").resourcesUrl!, {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new OAuthError(`Jira listed no sites (status ${res.status})`, res.status);
  const list = (await res.json().catch(() => [])) as Array<Record<string, unknown>>;
  return list
    .filter((r) => typeof r.id === "string" && typeof r.url === "string")
    .map((r) => ({ id: r.id as string, url: r.url as string, name: String(r.name ?? r.url) }));
}

const bound = (orgId: string, provider: string) => `${orgId}:${provider}`;

export async function saveTokens(
  deps: OAuthDeps,
  orgId: string,
  provider: OAuthProvider,
  tokens: TokenSet,
  obtainedBy: string,
): Promise<void> {
  const aad = bound(orgId, provider);
  await deps.credentials.put({
    orgId,
    provider,
    accessToken: deps.box.seal(tokens.accessToken, aad),
    refreshToken: tokens.refreshToken ? deps.box.seal(tokens.refreshToken, aad) : null,
    expiresAt: tokens.expiresAt ?? null,
    scope: tokens.scope ?? null,
    obtainedBy,
    updatedAt: (deps.now ?? Date.now)(),
  });
}

/** Refresh this long before the provider's expiry. */
const REFRESH_EARLY_MS = 60_000;

/**
 * The connection's access token, refreshed when it's about to expire (and
 * the refreshed pair saved — Atlassian rotates refresh tokens on every use).
 */
export async function accessTokenFor(
  deps: OAuthDeps,
  orgId: string,
  provider: OAuthProvider,
): Promise<string> {
  const row = await deps.credentials.get(orgId, provider);
  if (!row) throw new OAuthError(`${OAUTH_NAMES[provider]} isn't connected through OAuth`, 401);
  const aad = bound(orgId, provider);
  const now = (deps.now ?? Date.now)();
  if (row.expiresAt === null || row.expiresAt - REFRESH_EARLY_MS > now) {
    return deps.box.open(row.accessToken, aad);
  }
  if (!row.refreshToken) {
    throw new OAuthError(`the ${OAUTH_NAMES[provider]} token expired and can't be refreshed`, 401);
  }
  const refreshed = await tokenRequest(deps, provider, {
    grant_type: "refresh_token",
    refresh_token: deps.box.open(row.refreshToken, aad),
  });
  await saveTokens(
    deps,
    orgId,
    provider,
    // A provider that doesn't rotate keeps the old refresh token.
    { ...refreshed, refreshToken: refreshed.refreshToken ?? deps.box.open(row.refreshToken, aad) },
    row.obtainedBy,
  );
  return refreshed.accessToken;
}

/**
 * A connection with what its factory needs to reach the provider: an OAuth
 * connection gets its (fresh) access token; any other is returned as it is
 * and resolves its environment variable in the factory, as before.
 */
export async function withCredential<
  C extends { orgId: string; provider: string; credentialRef: string },
>(oauth: OAuthDeps | undefined, connection: C): Promise<C & { oauth?: { accessToken: string } }> {
  if (connection.credentialRef !== OAUTH_REF) return connection;
  if (!oauth || !isOAuthProvider(connection.provider)) {
    throw new OAuthError("OAuth isn't configured on this server", 401);
  }
  return {
    ...connection,
    oauth: { accessToken: await accessTokenFor(oauth, connection.orgId, connection.provider) },
  };
}
