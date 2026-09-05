import * as z from "zod/v4";
import { actionNodes } from "@lucent/core";
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


  // ---- The sync route (the D4 acceptance path) -----------------------------
  //
  // Stage D5's PRE-APPROVAL SKELETON, labeled honestly: this batch ships the
  // direct editor action — an authenticated human calls sync, the platform
  // creates/updates external tasks through the provider, links land in the
  // registry. D5 replaces the direct call with propose → approve → execute
  // on the SAME store and provider seam (the Stripe-ledger shape, not B3 —
  // an external action is not a canvas op), and this route becomes the
  // executor underneath the approval. The idempotency you see here (the
  // link makes a second sync skip) is the beginning of D5's story.
  router.post("/api/boards/:id/integrations/:provider/sync", async (ctx) => {
    const { req, res } = ctx;
    const route = "/api/boards/:id/integrations/:provider/sync";
    if (!requireCsrf(req, res, route)) return;
    const user = await requireUser(req, res);
    if (!user) return;
    if (!meter(req, res, route)) return;
    const boardId = ctx.param("id");
    const guard = await requireBoardRole(req, res, boardId, "editor", route);
    if (!guard.ok) return;
    if (!integrations) return send(res, 503, { error: "integrations are not configured" });
    const providerName = ctx.param("provider");
    const provider = integrations.providers.get(providerName);
    if (!provider) {
      send(res, 400, { error: `no provider implementation named "${providerName}" is loaded` });
      return;
    }
    // The connection must exist AND be active — syncing through a disabled
    // or never-configured connection is refused, not silently skipped.
    const connection = await integrations.store.connection(guard.board.orgId, providerName);
    if (!connection) {
      send(res, 404, { error: `no ${providerName} connection is configured for this org` });
      return;
    }
    if (connection.status !== "active") {
      send(res, 409, { error: `the ${providerName} connection is ${connection.status}` });
      return;
    }

    // The board's executable actions (ADR 0027's selector — the model the
    // provider targets) and their existing links.
    const actions = actionNodes(guard.board.workspace);
    const existingLinks = new Map(
      (await integrations.store.linksForBoard(boardId))
        .filter((l) => l.provider === providerName)
        .map((l) => [l.nodeId, l]),
    );

    let created = 0;
    let updated = 0;
    let skipped = 0;
    const results: Array<Record<string, unknown>> = [];
    for (const node of actions) {
      const issue = node.issue!;
      const input = {
        title: node.label,
        ...(issue.description ? { description: issue.description } : {}),
        ...(issue.assignee ? { assignee: issue.assignee } : {}),
        ...(issue.dueDate ? { dueDate: issue.dueDate } : {}),
        status: issue.status,
      };
      const link = existingLinks.get(node.id);
      try {
        if (!link) {
          // CREATE: the action has no external task yet.
          const task = await provider.createTask(input);
          const stored = await integrations.store.linkTask(
            {
              orgId: guard.board.orgId,
              boardId,
              nodeId: node.id,
              provider: providerName as never,
              externalId: task.externalId,
              ...(task.url ? { url: task.url } : {}),
              lastSyncedStatus: task.status,
            },
            Date.now(),
          );
          created += 1;
          results.push({ nodeId: node.id, action: "created", externalId: stored.externalId, url: stored.url });
        } else {
          // UPDATE only on drift: the external status moved from what we
          // last synced (mapStatus both ways through the provider), or the
          // board's own fields moved. Same external status + same input =
          // skipped — the link is the idempotency key at the route level.
          const task = await provider.updateTask(link.externalId, input);
          if (task.status !== link.lastSyncedStatus) {
            await integrations.store.linkTask(
              {
                orgId: guard.board.orgId,
                boardId,
                nodeId: node.id,
                provider: providerName as never,
                externalId: link.externalId,
                ...(task.url ? { url: task.url } : {}),
                lastSyncedStatus: task.status,
              },
              Date.now(),
            );
            updated += 1;
            results.push({ nodeId: node.id, action: "updated", externalId: link.externalId, status: task.status });
          } else {
            skipped += 1;
            results.push({ nodeId: node.id, action: "skipped", externalId: link.externalId });
          }
        }
      } catch (err) {
        // One provider failure must not 500 the batch: the honest report is
        // which node failed and why (the partial-application philosophy).
        results.push({ nodeId: node.id, action: "failed", reason: (err as Error).message });
      }
    }

    send(res, 200, { provider: providerName, created, updated, skipped, results });
  });
};
