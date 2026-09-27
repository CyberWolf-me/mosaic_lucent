import type { RegisterRoutes } from "./context.js";
import {
  API_TOKEN_EXPIRY_DAYS,
  MAX_API_TOKENS,
  isApiTokenScope,
  mintApiToken,
  tokenIsLive,
  type ApiTokenScope,
  type StoredApiToken,
} from "../apiTokens.js";
import { effectiveSettings } from "../classification.js";
import { roleAtLeast } from "../identity.js";

/**
 * Personal API tokens (docs/26 A6):
 *
 *   GET    /api/me/tokens                 yours: name, workspace, scope, last used — never the token
 *   POST   /api/me/tokens                 make one; the token is in this answer and nowhere else
 *   DELETE /api/me/tokens/:id             revoke yours
 *   GET    /api/orgs/:id/tokens           every token that reaches the workspace (owner)
 *   DELETE /api/orgs/:id/tokens/:tokenId  revoke one (owner)
 *
 * A token can't reach any of these (apiTokens.ts, `apiTokenRefusal`): only a
 * signed-in person makes, lists or revokes them. Every make and revoke lands
 * in the workspace's audit log.
 */
export const registerApiTokenRoutes: RegisterRoutes = (router, s) => {
  const { send, readBody, requireCsrf, requireUser, requireOrgRole, meter, auditRow } = s;
  const tokens = s.apiTokens;

  const view = (t: StoredApiToken) => ({
    id: t.id,
    name: t.name,
    orgId: t.orgId,
    scopes: t.scopes,
    prefix: t.prefix,
    createdAt: t.createdAt,
    lastUsedAt: t.lastUsedAt,
    expiresAt: t.expiresAt,
  });
  const orgName = async (orgId: string) => (await s.orgStore?.get(orgId))?.name ?? "A workspace";
  const tokensOff = async (orgId: string) =>
    effectiveSettings(await s.orgStore?.get(orgId)).apiTokensDisabled;

  router.get("/api/me/tokens", async (ctx) => {
    const { req, res } = ctx;
    const user = await requireUser(req, res);
    if (!user) return;
    const out = [];
    for (const t of await tokens.listForUser(user.id)) {
      out.push({ ...view(t), orgName: await orgName(t.orgId) });
    }
    send(res, 200, { tokens: out });
  });

  router.post("/api/me/tokens", async (ctx) => {
    const { req, res } = ctx;
    const route = "/api/me/tokens";
    if (!requireCsrf(req, res, route)) return;
    if (!meter(req, res, route)) return;
    const user = await requireUser(req, res);
    if (!user) return;
    let body: { name?: unknown; orgId?: unknown; scopes?: unknown; expiresInDays?: unknown };
    try {
      const raw = await readBody(req);
      body = raw ? (JSON.parse(raw) as typeof body) : {};
    } catch (err) {
      return send(res, 400, { error: "bad request", detail: (err as Error).message });
    }
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (name.length < 1 || name.length > 80) {
      return send(res, 400, { error: "name it (1–80 characters) so you'll know it later" });
    }
    if (typeof body.orgId !== "string") return send(res, 400, { error: "orgId is required" });
    const orgId = body.orgId;
    const requested = Array.isArray(body.scopes) ? body.scopes : ["read"];
    if (requested.length === 0 || !requested.every(isApiTokenScope)) {
      return send(res, 400, { error: "scopes are read, or read and write" });
    }
    // Every token reads; write is on top of it.
    const scopes: ApiTokenScope[] = requested.includes("write") ? ["read", "write"] : ["read"];
    const days = body.expiresInDays === undefined ? 90 : body.expiresInDays;
    if (days !== null && !(API_TOKEN_EXPIRY_DAYS as readonly unknown[]).includes(days)) {
      return send(res, 400, {
        error: `expiresInDays is one of ${API_TOKEN_EXPIRY_DAYS.join(", ")}, or null for never`,
      });
    }

    // The workspace as this person can reach it right now — the access
    // policy applies, so a workspace that requires two-step verification
    // won't mint a token for someone without it.
    const role = await s.orgRoleFor(user.id, orgId);
    if (!role) return send(res, 404, { error: "no workspace you can reach with that id" });
    if (scopes.includes("write") && !roleAtLeast(role, "editor")) {
      return send(res, 400, {
        error: "you can only view this workspace, so a token for it can only read",
      });
    }
    if (await tokensOff(orgId)) {
      return send(res, 403, { error: "API tokens are turned off for this workspace" });
    }
    const now = Date.now();
    const live = (await tokens.listForUser(user.id)).filter((t) => tokenIsLive(t, now));
    if (live.length >= MAX_API_TOKENS) {
      return send(res, 409, {
        error: `you have ${MAX_API_TOKENS} tokens — revoke one you no longer use first`,
      });
    }

    const minted = mintApiToken();
    const stored: StoredApiToken = {
      id: `tok_${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      userId: user.id,
      orgId,
      name,
      tokenHash: minted.tokenHash,
      prefix: minted.prefix,
      scopes,
      createdAt: now,
      lastUsedAt: null,
      expiresAt: typeof days === "number" ? now + days * 86_400_000 : null,
      revokedAt: null,
    };
    await tokens.create(stored);
    void auditRow(req, user.id, orgId, "api_token.created", stored.id, {
      name,
      scopes,
      expiresAt: stored.expiresAt,
    });
    send(res, 201, { token: minted.token, ...view(stored), orgName: await orgName(orgId) });
  });

  router.delete("/api/me/tokens/:id", async (ctx) => {
    const { req, res } = ctx;
    if (!requireCsrf(req, res, "/api/me/tokens/:id")) return;
    const user = await requireUser(req, res);
    if (!user) return;
    const token = await tokens.get(ctx.param("id"));
    if (!token || token.userId !== user.id || token.revokedAt !== null) {
      return send(res, 404, { error: "no token of yours with that id" });
    }
    await tokens.revoke(token.id, Date.now());
    void auditRow(req, user.id, token.orgId, "api_token.revoked", token.id, { name: token.name });
    send(res, 200, { id: token.id, revoked: true });
  });

  router.get("/api/orgs/:id/tokens", async (ctx) => {
    const { req, res } = ctx;
    const orgId = ctx.param("id");
    const guard = await requireOrgRole(req, res, orgId, "owner", "/api/orgs/:id/tokens");
    if (!guard.ok) return;
    const out = [];
    for (const t of await tokens.listForOrg(orgId)) {
      const person = await s.userStore.findById(t.userId);
      out.push({ ...view(t), userId: t.userId, userName: person?.name || person?.email || "" });
    }
    send(res, 200, { tokens: out, disabled: await tokensOff(orgId) });
  });

  router.delete("/api/orgs/:id/tokens/:tokenId", async (ctx) => {
    const { req, res } = ctx;
    const route = "/api/orgs/:id/tokens/:tokenId";
    if (!requireCsrf(req, res, route)) return;
    const orgId = ctx.param("id");
    const guard = await requireOrgRole(req, res, orgId, "owner", route);
    if (!guard.ok) return;
    const token = await tokens.get(ctx.param("tokenId"));
    if (!token || token.orgId !== orgId || token.revokedAt !== null) {
      return send(res, 404, { error: "no token for this workspace with that id" });
    }
    await tokens.revoke(token.id, Date.now());
    void auditRow(req, guard.user.id, orgId, "api_token.revoked", token.id, {
      name: token.name,
      owner: token.userId,
    });
    send(res, 200, { id: token.id, revoked: true });
  });
};
