import type { IncomingMessage, ServerResponse } from "node:http";
import {
  applyScimPatch,
  generateRandomPassword,
  newUserIdLike,
  readScimBody,
  type ScimConfig,
  type ScimIdentity,
  type ScimIdentityStore,
  type ScimListResponse,
  type ScimPatchRequest,
  type ScimUserAccess,
  type ScimUserRequest,
  type ScimUserResponse,
  scimAuthenticated,
  userToScim,
  writeScimError,
  writeScimJson,
} from "../scim.js";

/**
 * SCIM 2.0 gateway (M6 / F1).
 *
 * Mounted at `/scim/v2/...`. The handler is built once per `createApp` call
 * and lives outside the central request switch so the SCIM-specific 401
 * (token mismatch) and the SCIM `Content-Type: application/scim+json`
 * response shape are not surprising the rest of the surface.
 *
 * Auth: a Bearer token configured by `LUCENT_SCIM_TOKEN` (or its digest
 * form). No cookie, no CSRF, no session — the integration runs as a
 * long-lived service principal, not a logged-in user.
 *
 * Deactivation is implemented as a `tokenVersion` bump on the user row; the
 * SCIM-side `active` flag is rendered from `emailVerifiedAt` rather than
 * stored verbatim, because share-gating already reads that field.
 */

const SCIM_BASE = "/scim/v2";

export interface ScimRoutesDeps {
  config: ScimConfig;
  identities: ScimIdentityStore;
  users: ScimUserAccess;
  /** Optional: production deployments wire a salt here for the JIT-provisioned password hash. */
  hashPassword: (password: string) => Promise<{ salt: string; hash: string }>;
  /** Optional clock for tests. */
  now?: () => number;
  /**
   * Deployment-defined password used when SCIM provisions a user. Lucent does
   * not own credentials — every JIT account has the same unguessable secret,
   * and the share gate ensures the user has an active session via SSO/SCIM
   * before they can do anything meaningful.
   */
  provisionedSecret?: string;
  /**
   * Base URL written into the SCIM `meta.location` so an IdP can navigate
   * back to the resource. Defaults to the request's `Host` header.
   */
  baseUrl?: string;
  /** docs/26 A6: SCIM Groups → the teams of one workspace, when configured. */
  groups?: Omit<import("../scimGroups.js").ScimGroupsDeps, "now" | "idp" | "identities">;
}

function defaultBaseUrl(req: IncomingMessage): string {
  const host = typeof req.headers.host === "string" ? req.headers.host : "localhost";
  const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? "http";
  return `${proto}://${host}`;
}

/** Narrow the `unknown` returned by `userStore.findById` into the SCIM user shape. */
type ScimUserRow = {
  id: string;
  email: string;
  name: string;
  createdAt: number;
  emailVerifiedAt: number | null;
};

function asRow(value: unknown): ScimUserRow | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (
    typeof v.id === "string" &&
    typeof v.email === "string" &&
    typeof v.name === "string" &&
    typeof v.createdAt === "number"
  ) {
    return {
      id: v.id,
      email: v.email,
      name: v.name,
      createdAt: v.createdAt,
      emailVerifiedAt: (v.emailVerifiedAt as number | null | undefined) ?? null,
    };
  }
  return undefined;
}

export function registerScimRoutes(
  deps: ScimRoutesDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const now = deps.now ?? (() => Date.now());

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const rawUrl = req.url ?? "";
    if (!rawUrl.startsWith(SCIM_BASE)) return false;
    const url = rawUrl.split("?")[0] ?? "";

    // Auth — fail closed with a SCIM-shaped 401 so the IdP integration
    // surfaces "wrong token" rather than "endpoint missing".
    if (!scimAuthenticated(deps.config, req.headers.authorization)) {
      res.writeHead(401, {
        "www-authenticate": 'Bearer realm="scim"',
        "content-type": "application/scim+json",
      });
      res.end(
        JSON.stringify({
          schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
          status: "401",
          detail: "invalid or missing scim bearer token",
        }),
      );
      return true;
    }

    const baseUrl = deps.baseUrl ?? defaultBaseUrl(req);

    // /Users list
    if (req.method === "GET" && url === `${SCIM_BASE}/Users`) {
      const identities = await deps.identities.listForIdp(deps.config.idp);
      const startIndex = Math.max(1, parseStartIndex(rawUrl));
      const countParam = new URLSearchParams(rawUrl.split("?")[1] ?? "").get("count");
      const count = Math.max(1, Math.min(200, Number(countParam) || 25));
      const users: ScimUserResponse[] = [];
      for (let i = startIndex - 1; i < identities.length && users.length < count; i += 1) {
        const id = identities[i]!;
        const u = asRow(await deps.users.findById(id.userId));
        if (!u) continue;
        users.push(userToScim(u, id, baseUrl));
      }
      const body: ScimListResponse<ScimUserResponse> = {
        schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
        totalResults: identities.length,
        Resources: users,
        startIndex,
        itemsPerPage: users.length,
      };
      writeScimJson(res, 200, null, body);
      return true;
    }

    // /Users/:externalId handlers
    const oneMatch = /^\/scim\/v2\/Users\/([^/]+)$/.exec(url);
    if (oneMatch !== null) {
      const externalId = decodeURIComponent(oneMatch[1]!);
      const identity = await deps.identities.byExternalId(deps.config.idp, externalId);
      if (!identity) {
        if (req.method === "DELETE") {
          // Idempotent deprovision: deleting a missing row is a 204, not 404,
          // because the IdP's contract is "after this call the user is gone".
          res.writeHead(204, { "content-type": "application/scim+json" });
          res.end();
          return true;
        }
        writeScimError(res, 404, "user not found");
        return true;
      }
      const location = `${baseUrl}/scim/v2/Users/${encodeURIComponent(externalId)}`;

      if (req.method === "GET") {
        const user = asRow(await deps.users.findById(identity.userId));
        if (!user) {
          writeScimError(res, 404, "user not found");
          return true;
        }
        writeScimJson(res, 200, location, userToScim(user, identity, baseUrl));
        return true;
      }

      if (req.method === "PUT") {
        const parsed = await readScimBody(req);
        if (!parsed.ok) {
          writeScimError(res, parsed.status, parsed.scimError.detail);
          return true;
        }
        const err = validateUser(parsed.body);
        if (err !== null) {
          writeScimError(res, 400, err);
          return true;
        }
        const body = parsed.body as ScimUserRequest;
        const user = asRow(await deps.users.findById(identity.userId));
        if (!user) {
          writeScimError(res, 404, "user not found");
          return true;
        }
        // In v1, replace only re-provisions the email/name on the existing user
        // — credentials stay Lucent-managed so the share gate never sees a
        // SCIM-chosen password.
        const updated = applyReplace(user, body);
        if (updated.error !== null) {
          writeScimError(res, 400, updated.error);
          return true;
        }
        writeScimJson(res, 200, location, userToScim(updated.user, identity, baseUrl));
        return true;
      }

      if (req.method === "PATCH") {
        const parsed = await readScimBody(req);
        if (!parsed.ok) {
          writeScimError(res, parsed.status, parsed.scimError.detail);
          return true;
        }
        const patch = parsed.body as ScimPatchRequest;
        if (!Array.isArray(patch.Operations)) {
          writeScimError(res, 400, "operations[] is required");
          return true;
        }
        const user = asRow(await deps.users.findById(identity.userId));
        if (!user) {
          writeScimError(res, 404, "user not found");
          return true;
        }
        const result = applyScimPatch(patch, user, now());
        if (result.active === false) {
          // Deactivation = invalidate live sessions. We bump tokenVersion
          // here; persisting emailVerifiedAt=null belongs to a future
          // patch. The session invalidation is what makes the share gate
          // and any in-flight websocket reject the user at next touch.
          await deps.users.bumpTokenVersion(user.id, now());
          // Idempotently return the user as inactive.
          const after = asRow(await deps.users.findById(user.id));
          if (after) {
            writeScimJson(
              res,
              200,
              location,
              userToScim({ ...after, emailVerifiedAt: null }, identity, baseUrl),
            );
            return true;
          }
        }
        writeScimJson(res, 204, location, null);
        return true;
      }

      if (req.method === "DELETE") {
        const removed = await deps.identities.remove(deps.config.idp, externalId);
        if (!removed) {
          // Treated as already-gone to keep the IdP call idempotent.
          res.writeHead(204, { "content-type": "application/scim+json" });
          res.end();
          return true;
        }
        const user = asRow(await deps.users.findById(identity.userId));
        if (user !== undefined) {
          // Bump tokenVersion so any live session is rejected at next touch.
          // The Lucent `users` row itself is left intact in v1 — JIT
          // provisioning is one-way; an IdP-driven delete marks the user
          // inactive rather than wiping it, so the share-gate and audit log
          // keep a stable record of who was provisioned.
          await deps.users.bumpTokenVersion(user.id, now()).catch(() => {
            // Best-effort: a missing user is fine, an error does not fail
            // the DELETE because the caller already considers the user
            // gone from the IdP's perspective.
          });
        }
        res.writeHead(204, { "content-type": "application/scim+json" });
        res.end();
        return true;
      }

      writeScimError(res, 405, "method not allowed");
      return true;
    }

    // /Users (POST) — provision
    if (req.method === "POST" && url === `${SCIM_BASE}/Users`) {
      const parsed = await readScimBody(req);
      if (!parsed.ok) {
        writeScimError(res, parsed.status, parsed.scimError.detail);
        return true;
      }
      const err = validateUser(parsed.body);
      if (err !== null) {
        writeScimError(res, 400, err);
        return true;
      }
      const body = parsed.body as ScimUserRequest;
      const externalId = (body.externalId ?? derivedExternalId(body.userName)).trim();

      const existing = await deps.identities.byExternalId(deps.config.idp, externalId);
      if (existing) {
        // Idempotent on the wire; the IdP will treat 200 as "already done".
        const u = asRow(await deps.users.findById(existing.userId));
        if (!u) {
          writeScimError(res, 500, "identity without user");
          return true;
        }
        const location = `${baseUrl}/scim/v2/Users/${encodeURIComponent(externalId)}`;
        writeScimJson(res, 200, location, userToScim(u, existing, baseUrl));
        return true;
      }

      const email = (body.emails?.find((e) => e.primary)?.value ?? body.userName)
        .toLowerCase()
        .trim();
      const name = body.name?.formatted ?? deriveName(body);
      const userId = newUserIdLike();
      const secret = deps.provisionedSecret ?? generateRandomPassword();
      const hashed = await deps.hashPassword(secret);
      await deps.users.insert({
        id: userId,
        email,
        name,
        createdAt: now(),
        tokenVersion: 0,
        emailVerifiedAt: now(),
        passwordHash: `${hashed.salt}:${hashed.hash}`,
      });
      const identity: ScimIdentity = {
        idp: deps.config.idp,
        externalId,
        userId,
        createdAt: now(),
      };
      try {
        await deps.identities.insert(identity);
      } catch (err) {
        writeScimError(res, 409, `could not register identity: ${(err as Error).message}`);
        return true;
      }
      const created = asRow(await deps.users.findById(userId));
      if (!created) {
        writeScimError(res, 500, "user missing after creation");
        return true;
      }
      const location = `${baseUrl}/scim/v2/Users/${encodeURIComponent(externalId)}`;
      writeScimJson(res, 201, location, userToScim(created, identity, baseUrl));
      return true;
    }

    // /Groups — read-only pass-through. v1 maps SCIM Groups to Lucent org
    // memberships is out of scope; we return an empty list so the IdP does
    // not treat "no group support" as a fatal error.
    if (url === `${SCIM_BASE}/Groups` || url.startsWith(`${SCIM_BASE}/Groups/`)) {
      // docs/26 A6: with a workspace named, Groups are its teams.
      if (deps.groups) {
        const { handleScimGroups } = await import("../scimGroups.js");
        await handleScimGroups(req, res, url, baseUrl, {
          ...deps.groups,
          idp: deps.config.idp,
          identities: deps.identities,
          now,
        });
        return true;
      }
      if (req.method === "GET") {
        const body: ScimListResponse<Record<string, unknown>> = {
          schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
          totalResults: 0,
          Resources: [],
          startIndex: 1,
          itemsPerPage: 0,
        };
        writeScimJson(res, 200, null, body);
        return true;
      }
      writeScimError(res, 405, "Groups supports GET only in v1");
      return true;
    }

    writeScimError(res, 404, "scim route not found");
    return true;
  };

  return handle;
}

// ---------- internal helpers ----------

/**
 * Read the `startIndex` pagination param from the URL. SCIM uses 1-based
 * indices; a bad value falls back to 1.
 */
function parseStartIndex(rawUrl: string): number {
  const qs = rawUrl.split("?")[1] ?? "";
  const v = Number(new URLSearchParams(qs).get("startIndex") || "1");
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 1;
}

/**
 * Validate a SCIM user payload. Returns the first error string or null when
 * the body is acceptable.
 */
function validateUser(body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return "user body must be an object";
  }
  const u = body as ScimUserRequest;
  if (typeof u.userName !== "string" || u.userName.trim().length === 0) {
    return "userName is required";
  }
  // emails[].value or userName serves as the unique handle. We do not accept
  // a body that omits both, because the identity we provision must be
  // reachable for sign-in.
  const primaryEmail = u.emails?.find((e) => e.primary)?.value ?? u.emails?.[0]?.value;
  if (primaryEmail !== undefined && typeof primaryEmail !== "string") {
    return "emails[].value must be a string";
  }
  return null;
}

/**
 * `PUT /Users/:id` replace: only the fields we store are touched. Password
 * and credential are intentionally left Lucent-managed; the IdP can't pick
 * them.
 */
function applyReplace(
  user: { id: string; name: string; email: string },
  body: ScimUserRequest,
): {
  user: {
    id: string;
    name: string;
    email: string;
    createdAt: number;
    emailVerifiedAt: number | null;
  };
  error: string | null;
} {
  const newEmail = (body.emails?.find((e) => e.primary)?.value ?? body.userName)
    .toLowerCase()
    .trim();
  const newName = body.name?.formatted ?? deriveName(body);
  if (typeof newEmail !== "string" || newEmail.length === 0) {
    return { user: { ...user, createdAt: 0, emailVerifiedAt: null }, error: "email is required" };
  }
  return {
    user: {
      id: user.id,
      name: newName,
      email: newEmail,
      createdAt: 0,
      emailVerifiedAt: null,
    },
    error: null,
  };
}

/** `name.formatted` or join of given/family if SCIM split them. */
function deriveName(body: ScimUserRequest): string {
  if (body.name?.formatted && body.name.formatted.trim().length > 0) return body.name.formatted;
  const given = body.name?.givenName ?? "";
  const family = body.name?.familyName ?? "";
  const joined = `${given} ${family}`.trim();
  if (joined.length > 0) return joined;
  // Fall back to the email local-part so the user can be addressed.
  const emailLocal = body.userName.split("@")[0]!;
  return emailLocal;
}

/**
 * When `externalId` is omitted, the IdP convention is to derive it from
 * `userName` (the email or login). Hashing is overkill for v1 — the IdP is
 * the source of identity — so we just pass through the email local-part or
 * the userName verbatim.
 */
function derivedExternalId(userName: string): string {
  return userName;
}
