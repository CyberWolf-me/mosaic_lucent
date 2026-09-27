import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";

/**
 * Personal API tokens (docs/26 A6): a credential for a script or an agent —
 * the MCP server's `LUCENT_MCP_TOKEN` — that acts as the person who made it,
 * in one workspace, at a scope, until it expires or is revoked.
 *
 *   - `lct_` + 32 random bytes. Only a SHA-256 of it is stored (the token is
 *     high-entropy, so a slow hash buys nothing); the token itself is shown
 *     once, at creation.
 *   - A scope caps the role: `read` acts as a viewer and only reads (GET);
 *     `write` also changes things, as an editor at most. A token never acts
 *     as an owner: sharing, settings, members and the workspace's own
 *     administration stay with a signed-in person.
 *   - It reaches one workspace. Everything else answers as if it weren't
 *     there — the access policy (accessPolicy.ts) reads the caller from the
 *     request's context, which `runAsApiToken` sets for the whole request.
 *   - It can't manage the account it acts for, or mint more of itself: see
 *     `apiTokenRefusal`.
 */

export const API_TOKEN_PREFIX = "lct_";
export const API_TOKEN_SCOPES = ["read", "write"] as const;
export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number];
/** How many live tokens one person may hold. */
export const MAX_API_TOKENS = 25;
export const API_TOKEN_EXPIRY_DAYS = [7, 30, 90, 365] as const;

export interface StoredApiToken {
  id: string;
  userId: string;
  orgId: string;
  name: string;
  tokenHash: string;
  /** The first characters, to recognize a token without revealing it. */
  prefix: string;
  scopes: ApiTokenScope[];
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
  revokedAt: number | null;
}

export interface ApiTokenStore {
  create(token: StoredApiToken): Promise<void>;
  findByHash(tokenHash: string): Promise<StoredApiToken | undefined>;
  get(id: string): Promise<StoredApiToken | undefined>;
  /** Live and expired tokens alike (not revoked), newest first. */
  listForUser(userId: string): Promise<StoredApiToken[]>;
  listForOrg(orgId: string): Promise<StoredApiToken[]>;
  revoke(id: string, at: number): Promise<boolean>;
  touch(id: string, at: number): Promise<void>;
}

export function hashApiToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function isApiToken(bearer: string | null | undefined): bearer is string {
  return typeof bearer === "string" && bearer.startsWith(API_TOKEN_PREFIX);
}

/** A new token: the raw value (shown once) and what's stored of it. */
export function mintApiToken(): { token: string; tokenHash: string; prefix: string } {
  const token = `${API_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { token, tokenHash: hashApiToken(token), prefix: token.slice(0, 12) };
}

export function isApiTokenScope(value: unknown): value is ApiTokenScope {
  return (API_TOKEN_SCOPES as readonly unknown[]).includes(value);
}

export function tokenIsLive(token: StoredApiToken, now: number): boolean {
  return token.revokedAt === null && (token.expiresAt === null || token.expiresAt > now);
}

/* ------------------------------------------------------------------------ */
/* The caller, for the length of one request                                */
/* ------------------------------------------------------------------------ */

export interface ApiTokenCaller {
  tokenId: string;
  tokenHash: string;
  userId: string;
  orgId: string;
  scopes: readonly ApiTokenScope[];
}

const caller = new AsyncLocalStorage<ApiTokenCaller>();

/** The API token this request is made with, if it is made with one. */
export function currentApiToken(): ApiTokenCaller | undefined {
  return caller.getStore();
}

export function runAsApiToken<T>(who: ApiTokenCaller, fn: () => T): T {
  return caller.run(who, fn);
}

/**
 * What a token may never do, whatever its scope: manage the account it acts
 * for (sign-in, password, 2FA, sessions, deletion, export), mint or list
 * tokens, pay, join something new (an invite, a share link, a new
 * workspace), or open a realtime socket (a ticket outlives the request, so
 * the workspace limit couldn't follow it). A `read` token only reads.
 */
export function apiTokenRefusal(
  method: string,
  path: string,
  scopes: readonly ApiTokenScope[],
): string | null {
  const reading = method === "GET" || method === "HEAD";
  if (path === "/api/auth/me" && reading) return null;
  if (
    path.startsWith("/api/auth/") ||
    path.startsWith("/api/account/") ||
    path.startsWith("/api/billing/") ||
    path.startsWith("/api/realtime/") ||
    path.startsWith("/api/invites/") ||
    path === "/api/me/tokens" ||
    path.startsWith("/api/me/tokens/") ||
    /^\/api\/orgs\/[^/]+\/tokens(\/|$)/.test(path) ||
    /^\/api\/boards\/[^/]+\/join$/.test(path) ||
    (path === "/api/orgs" && !reading)
  ) {
    return "an API token can't do this — sign in to Lucent instead";
  }
  if (!reading && !scopes.includes("write")) {
    return "this API token can only read";
  }
  return null;
}

/* ------------------------------------------------------------------------ */
/* In memory                                                                */
/* ------------------------------------------------------------------------ */

export class InMemoryApiTokenStore implements ApiTokenStore {
  private readonly byId = new Map<string, StoredApiToken>();

  async create(token: StoredApiToken): Promise<void> {
    this.byId.set(token.id, { ...token, scopes: [...token.scopes] });
  }
  async findByHash(tokenHash: string): Promise<StoredApiToken | undefined> {
    for (const t of this.byId.values()) if (t.tokenHash === tokenHash) return { ...t };
    return undefined;
  }
  async get(id: string): Promise<StoredApiToken | undefined> {
    const t = this.byId.get(id);
    return t ? { ...t } : undefined;
  }
  async listForUser(userId: string): Promise<StoredApiToken[]> {
    return this.list((t) => t.userId === userId);
  }
  async listForOrg(orgId: string): Promise<StoredApiToken[]> {
    return this.list((t) => t.orgId === orgId);
  }
  async revoke(id: string, at: number): Promise<boolean> {
    const t = this.byId.get(id);
    if (!t || t.revokedAt !== null) return false;
    t.revokedAt = at;
    return true;
  }
  async touch(id: string, at: number): Promise<void> {
    const t = this.byId.get(id);
    if (t) t.lastUsedAt = at;
  }
  private list(keep: (t: StoredApiToken) => boolean): StoredApiToken[] {
    return [...this.byId.values()]
      .filter((t) => t.revokedAt === null && keep(t))
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((t) => ({ ...t }));
  }
}
