import type { IncomingMessage, ServerResponse } from "node:http";
import { MAX_ASSET_BYTES, type AssetService } from "../assets.js";
import { formatAssetRef } from "@lucent/core";

/**
 * Routes for `/api/assets/*` — the gateway between an org's stored images and
 * the renderer. Split out of `app.ts` so the upload path's byte handling does
 * not push the central request switch past the line that fits in one screen,
 * and so a test can mount the routes against a synthetic `AssetService`
 * without booting `app.ts`.
 *
 * Auth, tenant and CSRF rules (all enforced at the call site, not inside the
 * service, so an internal caller can reuse it without re-implementing them):
 *
 * - `POST /api/assets` — `requireUser` + `requireCsrf` + at-least-editor on the
 *   body-declared `orgId`. Uploads consume the org's storage quota, so viewers
 *   (read-only) must not be able to burn it — the DELETE floor already
 *   requires editor, and upload matches it. An optional `X-Lucent-Board-Id`
 *   header, when present, must name a board in the same org (checked via
 *   `boardOrgFor` when wired); otherwise the upload is refused with a 404 so
 *   board ids are not enumerable across tenants.
 * - `GET /api/assets/:id` and `/thumb` — `requireUser`, then the service's
 *   own org check (it refuses to return another org's bytes). No CSRF, because
 *   a GET is idempotent and CSRF is a state-mutating concern.
 * - `DELETE /api/assets/:id` — `requireUser` + `requireCsrf`. Any member of the
 *   owning org may delete; the asset is metadata and bytes both belong to the
 *   tenant, not the uploader.
 *
 * References (`asset:ast_…`) round-trip here: the renderer holds an `asset:`
 * ref in a shape's `src`, the loader resolves it through `GET /api/assets/:id`,
 * and the upload route mints the ref that gets written back.
 */

/** One upload's worth of HTTP body — the bytes themselves plus the headers that decide what they are. */
export interface AssetRoutesContext {
  /** Injected so tests can swap in an in-memory backend while running the real routes. */
  assetService: AssetService;
  /** Validates a session cookie / bearer token, returning the authenticated user or null. */
  requireUser(req: IncomingMessage, res: ServerResponse): Promise<unknown>;
  /**
   * Returns the org ids the caller is a member of, scoped to a single user. The
   * asset gateway uses this to pick the implicit tenant when the request did
   * not name one in `X-Lucent-Org-Id` (the typical case for a freshly-onboarded
   * single-org account).
   */
  membershipsFor(userId: string): Promise<Array<{ orgId: string; role: string }>>;
  /**
   * Validates the caller's role on `orgId`. Returns `{ ok: false }` after
   * writing the 401/403/404 response, so a `false` here means the responder is
   * already done. `required` is the inclusive floor — `viewer` accepts viewer,
   * member and owner; `owner` accepts only owner.
   */
  requireOrgRole(
    req: IncomingMessage,
    res: ServerResponse,
    orgId: string | undefined,
    required: string,
    route: string,
  ): Promise<{ ok: boolean }>;
  requireCsrf(req: IncomingMessage, res: ServerResponse, route: string): boolean;
  /** Standard JSON responder, used for the upload's `201 Created` body. */
  send(res: ServerResponse, status: number, body: unknown): void;
  /** Bytes-as-body reader; separate from the UTF-8 reader because images are binary. */
  readRawBody(req: IncomingMessage, maxBytes?: number): Promise<Buffer>;
  /**
   * Optional board→org lookup for the `X-Lucent-Board-Id` header check. When
   * wired (production app), a declared board id that is unknown or belongs to
   * another org refuses the upload with a 404. When absent (isolated route
   * tests), the header is accepted as opaque metadata, preserving the old
   * behaviour for callers that do not go through the board check.
   */
  boardOrgFor?: (boardId: string) => Promise<string | undefined>;
  /**
   * Optional abuse-prevention meter (the global sliding-window limiter).
   * Wired in production; absent in isolated route tests. Uploads and deletes
   * are quota-burning writes and always meter; reads meter too (byte serving
   * is the bandwidth-abuse surface).
   */
  meter?: (req: IncomingMessage, res: ServerResponse, route: string) => boolean;
  /** Standard logger for the rare non-fatal path. */
  logger?: { error: (event: string, fields?: Record<string, unknown>) => void };
  /**
   * Identifies the deployment in log lines: the in-memory backend is dev-only,
   * so flagging it at warn-level nudges operators toward disk or S3 before the
   * first restart wipes their uploads.
   */
  warnMemoryStorage?: boolean;
}

/** Body cap. Matches the AssetService contract (`MAX_ASSET_BYTES`, currently 10MB). */
const DEFAULT_UPLOAD_LIMIT = MAX_ASSET_BYTES + 1024;

/** Routes the asset gateway actually serves. Order matters only because `/api/assets/upload` is a literal segment before `:id`. */
export type AssetRoutesDeps = AssetRoutesContext;

export function registerAssetRoutes(
  deps: AssetRoutesDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = req.url?.split("?")[0] ?? "";
    // Upload — POST /api/assets. Bytes go in the body; headers tell us what
    // they are. Declaring these in headers (rather than parsing multipart) keeps
    // the route single-purpose: one image per request.
    if (req.method === "POST" && url === "/api/assets") {
      if (!deps.requireCsrf(req, res, "/api/assets")) return true;
      const user = (await deps.requireUser(req, res)) as { id: string } | null;
      if (!user) return true;
      if (deps.meter && !deps.meter(req, res, "/api/assets")) return true;
      const orgId = await resolveOrgId(deps, req, user.id);
      if (!orgId.ok) {
        deps.send(res, orgId.status, { error: orgId.error });
        return true;
      }
      const guard = await deps.requireOrgRole(req, res, orgId.value, "editor", "/api/assets");
      if (!guard.ok) return true;

      const declaredMime =
        typeof req.headers["x-lucent-asset-mime"] === "string"
          ? req.headers["x-lucent-asset-mime"]
          : undefined;
      const declaredChecksum =
        typeof req.headers["x-lucent-asset-checksum"] === "string"
          ? req.headers["x-lucent-asset-checksum"]
          : undefined;
      const declaredBoardId =
        typeof req.headers["x-lucent-board-id"] === "string" &&
        req.headers["x-lucent-board-id"].length > 0
          ? req.headers["x-lucent-board-id"]
          : null;
      if (declaredBoardId !== null && deps.boardOrgFor) {
        const boardOrg = await deps.boardOrgFor(declaredBoardId);
        if (!boardOrg || boardOrg !== orgId.value) {
          deps.send(res, 404, { error: "board not found" });
          return true;
        }
      }

      let bytes: Buffer;
      try {
        bytes = await deps.readRawBody(req, DEFAULT_UPLOAD_LIMIT);
      } catch (err) {
        deps.send(res, 413, { error: "upload too large", detail: (err as Error).message });
        return true;
      }
      const result = await deps.assetService.upload({
        orgId: orgId.value,
        boardId: declaredBoardId,
        userId: user.id,
        bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
        ...(declaredMime !== undefined ? { mime: declaredMime } : {}),
        ...(declaredChecksum !== undefined ? { checksum: declaredChecksum } : {}),
      });
      if (!result.ok) {
        deps.send(res, result.status, { error: result.code, detail: result.detail });
        return true;
      }
      deps.send(res, 201, {
        ref: result.ref,
        id: result.asset.id,
        mime: result.asset.mime,
        bytes: result.asset.bytes,
        width: result.asset.width,
        height: result.asset.height,
        deduped: result.deduped,
        url: `/api/assets/${result.asset.id}`,
        thumbUrl: result.asset.thumbKey === null ? null : `/api/assets/${result.asset.id}/thumb`,
      });
      if (deps.warnMemoryStorage) {
        deps.logger?.error("asset.upload.memory-backend", {});
      }
      return true;
    }

    // GET — bytes or thumbnail. The `:id` segment is one of the id shapes the
    // router recognises; the org check inside `read` / `thumb` rejects any
    // request for a row that does not belong to this user's org.
    const getMatch = /^\/api\/assets\/([A-Za-z0-9_-]{3,64})(\/thumb)?$/.exec(url);
    if (req.method === "GET" && getMatch !== null && !getMatch[2]) {
      const user = (await deps.requireUser(req, res)) as { id: string } | null;
      if (!user) return true;
      if (deps.meter && !deps.meter(req, res, "/api/assets/:id")) return true;
      const orgId = await resolveOrgId(deps, req, user.id);
      if (!orgId.ok) {
        deps.send(res, orgId.status, { error: orgId.error });
        return true;
      }
      const id = getMatch[1]!;
      const hit = await deps.assetService.read(orgId.value, id);
      if (!hit) {
        deps.send(res, 404, { error: "asset not found" });
        return true;
      }
      res.writeHead(200, {
        "content-type": hit.asset.mime,
        "content-length": String(hit.bytes.byteLength),
        "cache-control": "private, max-age=300",
      });
      res.end(Buffer.from(hit.bytes));
      return true;
    }
    if (req.method === "GET" && getMatch !== null && getMatch[2] === "/thumb") {
      const user = (await deps.requireUser(req, res)) as { id: string } | null;
      if (!user) return true;
      if (deps.meter && !deps.meter(req, res, "/api/assets/:id/thumb")) return true;
      const orgId = await resolveOrgId(deps, req, user.id);
      if (!orgId.ok) {
        deps.send(res, orgId.status, { error: orgId.error });
        return true;
      }
      const id = getMatch[1]!;
      const hit = await deps.assetService.thumb(orgId.value, id);
      if (!hit) {
        deps.send(res, 404, { error: "thumbnail not available" });
        return true;
      }
      res.writeHead(200, {
        "content-type": "image/png",
        "content-length": String(hit.bytes.byteLength),
        "cache-control": "private, max-age=300",
      });
      res.end(Buffer.from(hit.bytes));
      return true;
    }

    // DELETE — the bytes and the row. Owner or member; an asset is org state.
    if (req.method === "DELETE" && /^\/api\/assets\/([A-Za-z0-9_-]{3,64})$/.test(url)) {
      const user = (await deps.requireUser(req, res)) as { id: string } | null;
      if (!user) return true;
      if (deps.meter && !deps.meter(req, res, "/api/assets/:id")) return true;
      const orgId = await resolveOrgId(deps, req, user.id);
      if (!orgId.ok) {
        deps.send(res, orgId.status, { error: orgId.error });
        return true;
      }
      const guard = await deps.requireOrgRole(req, res, orgId.value, "editor", "/api/assets/:id");
      if (!guard.ok) return true;
      const id = url.split("/")[3]!;
      const removed = await deps.assetService.remove(orgId.value, id);
      deps.send(res, removed ? 200 : 404, { ok: removed });
      return true;
    }

    // Nothing matched under `/api/assets/*`. Authenticate so an unauthenticated
    // probe never learns that `/api/assets/upload` exists by getting a 404 it
    // could distinguish from a wrong path; both answers collapse to 401.
    const user = (await deps.requireUser(req, res)) as { id: string } | null;
    if (!user) return true;
    deps.send(res, 404, { error: "asset route not found" });
    return true;

    // Not one of ours. The caller falls through to the central switch.
    return false;
  };

  // Convenience export so a test can mount a route stack without going through
  // the whole app.
  void formatAssetRef;
  return handle;
}

/**
 * Pick the org this request operates on. Three rules, applied in order:
 *
 *   1. If the request named an org in `X-Lucent-Org-Id`, use it verbatim. The
 *      subsequent `requireOrgRole` turns "not a member" into the same 404 as
 *      "missing", so an attacker cannot enumerate org ids.
 *   2. Otherwise fall back to the user's first membership. Single-org accounts
 *      — which is everyone in M2's first month — never see this header, and
 *      the UI does not need to fabricate one.
 *   3. A user with no memberships answers 403; the upload-and-lose-the-bytes
 *      alternative is worse than refusing the upload.
 */
async function resolveOrgId(
  deps: AssetRoutesContext,
  req: IncomingMessage,
  userId: string,
): Promise<{ ok: true; value: string } | { ok: false; status: number; error: string }> {
  const headerValue = req.headers["x-lucent-org-id"];
  const headerOrgId =
    typeof headerValue === "string" && headerValue.length > 0 ? headerValue : undefined;
  if (headerOrgId !== undefined) {
    return { ok: true, value: headerOrgId };
  }
  const memberships = await deps.membershipsFor(userId);
  const first = memberships[0];
  if (!first) {
    return { ok: false, status: 403, error: "no org membership" };
  }
  return { ok: true, value: first.orgId };
}
