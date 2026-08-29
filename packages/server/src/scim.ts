import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * SCIM 2.0 server (M6 / F1).
 *
 * SCIM is a wire protocol that an enterprise IdP (Okta, Azure AD, …) uses to
 * push user lifecycle events to a SaaS. The minimum viable Lucent
 * implementation supports:
 *
 *   - `POST   /scim/v2/Users`        provision a user (create Lucent user + identity row)
 *   - `GET    /scim/v2/Users`        list
 *   - `GET    /scim/v2/Users/:id`    fetch one
 *   - `PUT    /scim/v2/Users/:id`    replace fields
 *   - `PATCH  /scim/v2/Users/:id`    `active=false` deactivates (bump tokenVersion)
 *   - `DELETE /scim/v2/Users/:id`    deprovisions: removes the user and the identity row
 *
 * Authentication is a single shared bearer token configured via `LUCENT_SCIM_TOKEN`.
 * The token is also accepted hashed (HMAC over the deployment secret) so it
 * survives env redistribution without ever being committed in plain.
 *
 * Deactivation / deprovisioning always invalidates live sessions via
 * `tokenVersion` (users.ts increments) — that is the actual access revocation;
 * the SCIM row is the audit trail, not the security boundary.
 */

// ---------- Config ----------

/**
 * The shared SCIM bearer token. Configurable as raw or as a hex digest; the
 * digest form lets operators distribute a hash (e.g. via a secret manager)
 * rather than the cleartext. Empty in dev so an IdP integration does not
 * silently appear; the routes register only when this is set.
 */
export interface ScimConfig {
  /** IdP label written into every `scim_identities.idp` row. */
  idp: string;
  /** Raw token; matched verbatim against the `Authorization: Bearer …` header. */
  token: string;
  /**
   * Optional hex-encoded HMAC-SHA256(token) under the deployment secret.
   * Matched as a constant-time equality when present, so a stolen hash
   * cannot authenticate unless the deployment secret is also stolen.
   */
  tokenDigest?: string;
  /** Deployment secret used to verify the token digest. */
  secret?: string;
}

/**
 * Pull the SCIM config from `process.env`. Returns `null` when neither
 * `LUCENT_SCIM_TOKEN` nor `LUCENT_SCIM_TOKEN_DIGEST` is set — the routes
 * register nothing in that case, mirroring how `billing` and
 * `teamTemplates` fail open.
 */
export function readScimConfig(
  env: NodeJS.ProcessEnv = process.env,
  secret?: string,
): ScimConfig | null {
  const idp = env.LUCENT_SCIM_IDP?.trim() || "default";
  const token = env.LUCENT_SCIM_TOKEN?.trim() ?? "";
  const digest = env.LUCENT_SCIM_TOKEN_DIGEST?.trim() ?? "";
  if (!token && !digest) return null;
  return {
    idp,
    token,
    ...(digest ? { tokenDigest: digest } : {}),
    ...(secret ? { secret } : {}),
  };
}

/**
 * Verify an `Authorization: Bearer <cred>` value against the configured
 * token/digest. Constant-time on both.
 */
export function scimAuthenticated(
  config: ScimConfig,
  authorizationHeader: string | undefined,
): boolean {
  if (!authorizationHeader) return false;
  const m = /^Bearer\s+(.+)$/.exec(authorizationHeader);
  if (!m) return false;
  const presented = m[1]!.trim();
  if (presented.length === 0) return false;
  if (config.token && constantTimeEqual(presented, config.token)) return true;
  if (config.tokenDigest && config.secret) {
    const computed = createHmac("sha256", config.secret).update(presented).digest("hex");
    if (constantTimeEqual(computed, config.tokenDigest)) return true;
  }
  return false;
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// ---------- Store ----------

/**
 * A SCIM-backed user identity. `userId` resolves to the Lucent user; `active`
 * is a hint the IdP sends and the gateway applies by bumping `tokenVersion`.
 *
 * The Lucent `User` object is read-only from SCIM's perspective: SCIM creates
 * users and toggles activation, but it does not own the credential. That's
 * why the route handlers go through `userStore.insert(...)` /
 * `userStore.bumpTokenVersion(...)` rather than carrying a password here.
 */
export interface ScimIdentity {
  idp: string;
  externalId: string;
  userId: string;
  createdAt: number;
}

export interface ScimIdentityStore {
  byExternalId(idp: string, externalId: string): Promise<ScimIdentity | undefined>;
  byUserId(idp: string, userId: string): Promise<ScimIdentity | undefined>;
  insert(row: ScimIdentity): Promise<void>;
  remove(idp: string, externalId: string): Promise<boolean>;
  /**
   * All rows for one IdP. SCIM's `GET /Users` paginates by `startIndex +
   * count`; this list is already the unfiltered set.
   */
  listForIdp(idp: string): Promise<ScimIdentity[]>;
}

export class InMemoryScimIdentityStore implements ScimIdentityStore {
  private readonly rows = new Map<string, ScimIdentity>();
  /** Idempotency: prevents a double POST from racing two distinct Lucent users onto one external id. */
  private readonly byExternalKey = new Map<string, string>();

  async byExternalId(idp: string, externalId: string): Promise<ScimIdentity | undefined> {
    const key = externalKey(idp, externalId);
    const userId = this.byExternalKey.get(key);
    if (!userId) return undefined;
    return this.rows.get(userIdKey(idp, userId)) ?? undefined;
  }

  async byUserId(idp: string, userId: string): Promise<ScimIdentity | undefined> {
    return this.rows.get(userIdKey(idp, userId)) ?? undefined;
  }

  async insert(row: ScimIdentity): Promise<void> {
    const key = externalKey(row.idp, row.externalId);
    if (this.byExternalKey.has(key)) {
      // Upsert-by-external-id: a re-provision on the same external id returns
      // the existing pairing, which the SCIM client interprets as a 200/201
      // depending on whether the row changed. The handler decides.
      return;
    }
    this.byExternalKey.set(key, row.userId);
    this.rows.set(userIdKey(row.idp, row.userId), row);
  }

  async remove(idp: string, externalId: string): Promise<boolean> {
    const row = await this.byExternalId(idp, externalId);
    if (!row) return false;
    this.byExternalKey.delete(externalKey(idp, externalId));
    this.rows.delete(userIdKey(idp, row.userId));
    return true;
  }

  async listForIdp(idp: string): Promise<ScimIdentity[]> {
    const out: ScimIdentity[] = [];
    for (const row of this.rows.values()) {
      if (row.idp === idp) out.push({ ...row });
    }
    return out;
  }
}

function externalKey(idp: string, externalId: string): string {
  return `${idp}::${externalId}`;
}
function userIdKey(idp: string, userId: string): string {
  return `${idp}::${userId}`;
}

/**
 * Bump the user's `tokenVersion` through whatever user store the deployment
 * runs. Returns true on success.
 *
 * SCIM does not own the credential so much as it owns the *lifecycle*: a
 * deactivated user must lose access at the next session touch. The cheapest
 * way to invalidate every live session in one write is the bump on the user
 * row, which is what `authenticate` already compares against.
 */
export interface ScimUserAccess {
  /** Find a user by id; return undefined when missing. */
  findById(userId: string): Promise<unknown>;
  /** Find a user by email; used by `POST /Users` when an IdP re-provisions someone who already has a Lucent account. */
  findByEmail?(email: string): Promise<unknown>;
  /** Create the user. The handler fills `emailVerifiedAt = now` so the share gate does not block JIT-provisioned users. */
  insert(input: {
    id: string;
    email: string;
    name: string;
    createdAt: number;
    tokenVersion: number;
    emailVerifiedAt: number;
    passwordHash: string;
  }): Promise<void>;
  /** Bump tokenVersion — invalidates every session in one write. */
  bumpTokenVersion(userId: string, now: number): Promise<unknown>;
}

/**
 * Password for JIT-provisioned users. SCIM does not own credentials, so we
 * mint an unguessable random one and immediately mark email-verified: the user
 * cannot log in by password (we never tell them), but they are real Lucent
 * users that SSO+SCIM can audit, deactivate, and re-home. The hash is
 * `crypto.scrypt` over the secret; `passwordHash` is `salt:hash`.
 *
 * Real deployments set `LUCENT_SCIM_PROVISIONED_PASSWORD` to a deployment-
 * specific long random secret. The default below is a placeholder string and
 * would be caught by the SCIM integration tests on first run if a tenant tried
 * to log in by password.
 */
export const DEFAULT_SCIM_PROVISIONED_PASSWORD_SECRET = "lucent-scim-default-do-not-use-in-prod";

export function generateRandomPassword(): string {
  return randomBytes(32).toString("hex");
}

// ---------- SCIM request/response payloads ----------

/**
 * The shape we accept from the IdP on `POST /Users`. We honour the SCIM 2.0
 * core user schema but ignore everything not in this list; the IdP is the
 * source of truth on attributes, and re-sending them on every push just makes
 * churn we'd otherwise reject.
 */
export interface ScimUserRequest {
  /** Required on `PUT`; the IdP-local id we echo back into `externalId`. */
  externalId?: string;
  userName: string;
  /** SCIM splits first/given; we map both to the single Lucent `name`. */
  name?: { givenName?: string; familyName?: string; formatted?: string };
  emails?: Array<{ value: string; primary?: boolean }>;
  active?: boolean;
  /**
   * SCIM lets the IdP forward a domain claim here. v1 of the gateway ignores
   * it — domain claiming is M6/F1 phase 2.
   */
  [k: string]: unknown;
}

/** The wire shape we return to the IdP. */
export interface ScimUserResponse {
  schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"];
  id: string;
  externalId: string;
  userName: string;
  name: { formatted: string };
  emails: Array<{ value: string; primary: true }>;
  active: boolean;
  meta: { resourceType: "User"; created: string; lastModified: string; location: string };
}

/**
 * SCIM list envelope. `totalResults` is what the IdP reads to know if there
 * is a next page.
 */
export interface ScimListResponse<T> {
  schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"];
  totalResults: number;
  Resources: T[];
  startIndex: number;
  itemsPerPage: number;
}

/**
 * SCIM error envelope. Status is the HTTP status — every SCIM implementation
 * uses both the HTTP code and the same value in the body so a client
 * inspecting only one is no worse off.
 */
export interface ScimError {
  schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"];
  status: string;
  detail?: string;
}

// ---------- PATCH operations ----------

/**
 * The SCIM PATCH op shape. `op` can be `add`, `remove`, or `replace`;
 * `value` is what it carries. `path` is ignored for v1 (the only meaningful
 * path the gateway supports today is `active`, and the IdP can omit the path
 * to mean "any path").
 */
export interface ScimPatchRequest {
  schemas?: string[];
  Operations: Array<{
    op: "add" | "remove" | "replace";
    path?: string;
    value?: unknown;
  }>;
}

// ---------- Helpers ----------

/**
 * Map a Lucent user (from `userStore.findById`) plus the matching
 * `scim_identities` row into the SCIM `User` payload.
 *
 * `created` / `lastModified` are ISO-8601 timestamps per RFC 7643 §3.1; we
 * re-derive `lastModified` from `user.createdAt` for now, since SCIM does not
 * have its own `updated_at` column on the Lucent `users` table.
 */
export function userToScim(
  user: {
    id: string;
    email: string;
    name: string;
    createdAt: number;
    emailVerifiedAt?: number | null;
  },
  identity: ScimIdentity,
  baseUrl: string,
): ScimUserResponse {
  return {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
    id: identity.externalId,
    externalId: identity.externalId,
    userName: user.email,
    name: { formatted: user.name },
    emails: [{ value: user.email, primary: true }],
    /**
     * `active` reads from email verification: an unverified SCIM-provisioned
     * user cannot share a board anyway, which is the closest thing SCIM's
     * `active` flag means in Lucent.
     */
    active: user.emailVerifiedAt !== null && user.emailVerifiedAt !== undefined,
    meta: {
      resourceType: "User",
      created: new Date(user.createdAt).toISOString(),
      lastModified: new Date(user.createdAt).toISOString(),
      location: `${baseUrl}/scim/v2/Users/${encodeURIComponent(identity.externalId)}`,
    },
  };
}

/**
 * Mint a Lucent user id; v1 callers do not depend on the shape but the
 * centralisation lets `main.ts` swap the schema later without touching
 * handlers.
 */
export function newUserIdLike(): string {
  // Deliberately avoid importing `newUserId` from accounts so that this module
  // does not pull in `InMemoryUserStore` and friends transitively; tests
  // mount a stub userStore.
  return "usr_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/**
 * Read and JSON-parse a SCIM body, returning a structured error on failure.
 * A request that is unparseable JSON is a `scimProtocol` error per RFC 7644.
 */
export async function readScimBody(
  req: IncomingMessage,
): Promise<{ ok: true; body: unknown } | { ok: false; status: number; scimError: ScimError }> {
  let raw: string;
  try {
    raw = await readJsonBody(req);
  } catch (err) {
    return {
      ok: false,
      status: 400,
      scimError: {
        schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
        status: "400",
        detail: (err as Error).message,
      },
    };
  }
  try {
    return { ok: true, body: JSON.parse(raw) };
  } catch {
    return {
      ok: false,
      status: 400,
      scimError: {
        schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
        status: "400",
        detail: "invalid JSON body",
      },
    };
  }
}

function readJsonBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(new Error("scim body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Apply a SCIM PATCH request to the underlying user. Currently only `replace`
 * (or `add`) on `active` has an effect; anything else is a no-op so an IdP
 * pushing richer profiles still gets a clean 204.
 *
 * Returns `applied: true` when the request caused a state change.
 */
export function applyScimPatch(
  patch: ScimPatchRequest,
  user: { id: string; emailVerifiedAt: number | null },
  now: number,
): { applied: boolean; active?: boolean } {
  let active: boolean | undefined;
  for (const op of patch.Operations ?? []) {
    if (op.op !== "add" && op.op !== "replace") continue;
    const path = (op.path ?? "active").toLowerCase();
    if (path === "active" || path.endsWith(":active")) {
      active = op.value === true || op.value === "true";
    }
  }
  if (active === undefined) return { applied: false };
  // `active=false` triggers deactivation: clear emailVerifiedAt so the share
  // gate refuses. The actual auth invalidation is the caller's
  // `bumpTokenVersion` step (separated so the SCIM handler does not own
  // session lifecycle).
  void now; // Reserved for future lastModified bookkeeping.
  return { applied: true, active };
}

/**
 * Helper to render a SCIM error with the right content type and the SCIM
 * status string repeated in the body so a misbehaving client reading only
 * one of the two still learns the right code.
 */
export function writeScimError(res: ServerResponse, status: number, detail?: string): void {
  const body: ScimError = {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
    status: String(status),
    ...(detail ? { detail } : {}),
  };
  res.writeHead(status, {
    "content-type": "application/scim+json",
    "content-length": String(Buffer.byteLength(JSON.stringify(body), "utf8")),
  });
  res.end(JSON.stringify(body));
}

/** The SCIM content-type. SCIM clients do `Accept: application/scim+json`. */
export const SCIM_CONTENT_TYPE = "application/scim+json";

/**
 * Helper to write a SCIM response with the right content type and a Location
 * header pointing at the canonical URL of the resource.
 */
export function writeScimJson(
  res: ServerResponse,
  status: number,
  location: string | null,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  const headers: Record<string, string> = {
    "content-type": SCIM_CONTENT_TYPE,
    "content-length": String(Buffer.byteLength(payload, "utf8")),
  };
  if (location !== null) headers.location = location;
  res.writeHead(status, headers);
  res.end(payload);
}
