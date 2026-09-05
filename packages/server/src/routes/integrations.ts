import * as z from "zod/v4";
import type { RegisterRoutes } from "./context.js";
import { connectionView, MAX_CREDENTIAL_REF_CHARS } from "../integrations/integrations.js";
import type { IntegrationProviderName } from "../integrations/integrations.js";

/**
 * The integration routes (Stage D4, ADR 0030):
 *
 *   GET    /api/orgs/:id/integrations            — the admin list (owner floor)
 *   PUT    /api/orgs/:id/integrations/:provider  — the idempotent upsert (owner)
 *   DELETE /api/orgs/:id/integrations/:provider  — disable (owner, never delete)
 *   GET    /api/boards/:id/integrations/links    — the board's links (viewer)
 *
 * Guard order follows the house rule: the ROLE guard runs before the store
 * check (a 503 for an unconfigured store must not become an oracle over
 * which orgs exist), and the connection surface echoes the credential
 * REFERENCE only as a fingerprint — never in full, the SSO cert precedent.
 *
 * The POST sync route (the acceptance path) is Stage D4 Batch 3 — this
 * batch ships the connection + link surfaces only.
 */

const putConnectionSchema = z.object({
  credentialRef: z.string().min(1).max(MAX_CREDENTIAL_REF_CHARS),
  scopes: z.array(z.string().min(1).max(60)).max(10).optional(),
});

export const registerIntegrationRoutes: RegisterRoutes = (router, s) => {
  const { integrations, send, readBody, requireUser, requireOrgRole, requireBoardRole, requireCsrf, meter } = s;

  // ---- The org admin surface (owner floor — credentials live here) --------
  router.get("/api/orgs/:id/integrations", async (ctx) => {
    const { req, res } = ctx;
    const orgId = ctx.param("id");
    const user = await requireUser(req, res);
    if (!user) return;
    const guard = await requireOrgRole(req, res, orgId, "owner", "/api/orgs/:id/integrations");
    if (!guard.ok) return;
    if (!integrations) return send(res, 503, { error: "integrations are not configured" });
    const connections = await integrations.store.connectionsForOrg(orgId);
    send(res, 200, { integrations: connections.map(connectionView) });
  });

  router.put("/api/orgs/:id/integrations/:provider", async (ctx) => {
    const { req, res } = ctx;
    const route = "/api/orgs/:id/integrations/:provider";
    if (!requireCsrf(req, res, route)) return;
    const user = await requireUser(req, res);
    if (!user) return;
    if (!meter(req, res, route)) return;
    const orgId = ctx.param("id");
    const guard = await requireOrgRole(req, res, orgId, "owner", route);
    if (!guard.ok) return;
    if (!integrations) return send(res, 503, { error: "integrations are not configured" });
    const provider = ctx.param("provider");
    // The provider must be a store-known name AND a mapped implementation —
    // configuring a provider nothing implements is a dead connection.
    if (!integrations.providers.has(provider)) {
      send(res, 400, { error: `no provider implementation named "${provider}" is loaded` });
      return;
    }

    let body: z.infer<typeof putConnectionSchema>;
    try {
      const raw = await readBody(req);
      body = putConnectionSchema.parse(raw ? JSON.parse(raw) : {});
    } catch (err) {
      send(res, 400, { error: "bad request", detail: (err as Error).message });
      return;
    }

    try {
      const connection = await integrations.store.putConnection(
        {
          orgId,
          provider: provider as IntegrationProviderName,
          credentialRef: body.credentialRef,
          scopes: body.scopes,
          createdBy: user.id,
        },
        Date.now(),
      );
      send(res, 201, { integration: connectionView(connection) });
    } catch (err) {
      send(res, 400, { error: "invalid connection", detail: (err as Error).message });
    }
  });

  router.delete("/api/orgs/:id/integrations/:provider", async (ctx) => {
    const { req, res } = ctx;
    const route = "/api/orgs/:id/integrations/:provider";
    if (!requireCsrf(req, res, route)) return;
    const user = await requireUser(req, res);
    if (!user) return;
    if (!meter(req, res, route)) return;
    const orgId = ctx.param("id");
    const guard = await requireOrgRole(req, res, orgId, "owner", route);
    if (!guard.ok) return;
    if (!integrations) return send(res, 503, { error: "integrations are not configured" });
    const provider = ctx.param("provider");
    const ok = await integrations.store.setConnectionStatus(orgId, provider, "disabled", Date.now());
    if (!ok) {
      send(res, 404, { error: "no such integration connection" });
      return;
    }
    send(res, 200, { provider, status: "disabled" });
  });

  // ---- The board link surface (viewer floor — links are read state) -------
  router.get("/api/boards/:id/integrations/links", async (ctx) => {
    const { req, res } = ctx;
    const boardId = ctx.param("id");
    const guard = await requireBoardRole(req, res, boardId, "viewer", "/api/boards/:id/integrations/links");
    if (!guard.ok) return;
    if (!integrations) return send(res, 503, { error: "integrations are not configured" });
    const links = await integrations.store.linksForBoard(boardId);
    send(res, 200, {
      links: links.map((l) => ({
        nodeId: l.nodeId,
        provider: l.provider,
        externalId: l.externalId,
        ...(l.url ? { url: l.url } : {}),
        status: l.lastSyncedStatus,
        syncedAt: l.syncedAt,
      })),
    });
  });

};

