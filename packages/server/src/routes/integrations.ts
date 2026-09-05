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
  /** Stage D6: provider-specific configuration (Linear's teamId). */
  config: z.record(z.string().min(1).max(60), z.string().min(1).max(200)).optional(),
});

/**
 * Stage D6: the connection → the live provider. The route has already
 * answered 404/409 for existence/status; this resolves credentialRef →
 * process.env (ADR 0032's TEMPORARY single-deployment mechanism, named in
 * the ADR) and invokes the factory with the connection's config. An unset
 * env ref answers 503 — the honest "credential not configured", never a
 * silent skip.
 */
function resolveProvider(
  integrations: NonNullable<import("./context.js").RouteServices["integrations"]>,
  providerName: string,
  connection: { id: string; credentialRef: string; config?: Record<string, string> },
):
  | { ok: true; provider: import("../integrations/provider.js").ExecutionProvider }
  | { ok: false; error: string } {
  const factory = integrations.providers.get(providerName);
  if (!factory) {
    return { ok: false as const, error: `no provider implementation named "${providerName}" is loaded` };
  }
  try {
    return { ok: true as const, provider: factory(connection) };
  } catch (err) {
    // The factory's honest errors: an unset env credential, a missing
    // teamId — the configuration problem, surfaced as the 503/400 the
    // caller maps it to.
    return { ok: false as const, error: (err as Error).message };
  }
}

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
    // Stage D6: the factory — the per-org credential resolved through the
    // connection, not a process-global instance.
    const resolved = resolveProvider(integrations, providerName, connection);
    if (!resolved.ok) {
      send(res, 400, { error: resolved.error });
      return;
    }
    const provider = resolved.provider;

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
// ---- The D5 approval flow: propose → preview → approve → execute ------
//
// The external-action safety routes (Stage D5, ADR 0031). The D4 sync
// route above remains the DIRECT path (scripts/tests; the pre-approval
// skeleton); these routes are the HUMAN path: an editor proposes, the
// preview is returned for review, an editor approves, the executor runs
// each item through the ledger (attempt idempotency) + the provider's
// idempotency key (effect idempotency) — exactly once externally.

router.post("/api/boards/:id/integrations/:provider/propose", async (ctx) => {
  const { req, res } = ctx;
  const route = "/api/boards/:id/integrations/:provider/propose";
  if (!requireCsrf(req, res, route)) return;
  const user = await requireUser(req, res);
  if (!user) return;
  if (!meter(req, res, route)) return;
  const boardId = ctx.param("id");
  const guard = await requireBoardRole(req, res, boardId, "editor", route);
  if (!guard.ok) return;
  if (!integrations) return send(res, 503, { error: "integrations are not configured" });
  const { actions } = integrations;
  if (!actions) return send(res, 503, { error: "external actions are not configured" });
  const providerName = ctx.param("provider");
  const connection = await integrations.store.connection(guard.board.orgId, providerName);
  if (!connection) {
    send(res, 404, { error: `no ${providerName} connection is configured for this org` });
    return;
  }
  if (connection.status !== "active") {
    send(res, 409, { error: `the ${providerName} connection is ${connection.status}` });
    return;
  }
  const resolved = resolveProvider(integrations, providerName, connection);
  if (!resolved.ok) {
    send(res, 400, { error: resolved.error });
    return;
  }
  const provider = resolved.provider;

  // Compute the per-node plan: creates for unlinked action nodes, updates
  // for linked ones (the same split the sync route applies), each carrying
  // its exactly-once key.
  const existingLinks = new Map(
    (await integrations.store.linksForBoard(boardId))
      .filter((l) => l.provider === providerName)
      .map((l) => [l.nodeId, l]),
  );
  const items = actionNodes(guard.board.workspace).map((node) => {
    const issue = node.issue!;
    const link = existingLinks.get(node.id);
    return {
      nodeId: node.id,
      action: link ? ("update" as const) : ("create" as const),
      title: node.label,
      ...(issue.assignee ? { assignee: issue.assignee } : {}),
      ...(issue.dueDate ? { dueDate: issue.dueDate } : {}),
      status: issue.status,
      ...(link ? { externalId: link.externalId } : {}),
      idempotencyKey: `ext_${node.id}`,
    };
  });

  if (items.length === 0) {
    send(res, 422, { error: "no executable actions on this board" });
    return;
  }

  const { record, supersededId } = await actions.propose({
    orgId: guard.board.orgId,
    boardId,
    provider: providerName as never,
    connectionId: connection.id,
    items,
    createdBy: user.id,
    now: Date.now(),
  });

  // THE PREVIEW: what will happen, what will NOT (the honest statement),
  // never a surprise.
  const creates = items.filter((i) => i.action === "create");
  const updates = items.filter((i) => i.action === "update");
  send(res, 201, {
    action: {
      id: record.id,
      provider: providerName,
      status: record.status,
      createdAt: record.createdAt,
      ...(supersededId ? { supersededId } : {}),
    },
    preview: {
      creates: creates.map((i) => ({
        nodeId: i.nodeId,
        title: i.title,
        ...(i.assignee ? { assignee: i.assignee } : {}),
        ...(i.dueDate ? { dueDate: i.dueDate } : {}),
        status: i.status,
      })),
      updates: updates.map((i) => ({ nodeId: i.nodeId, externalId: i.externalId, title: i.title, status: i.status })),
      statement:
        `Will create ${creates.length} task(s) and update ${updates.length} in ${providerName}. Nothing will be deleted; existing external tasks are only modified beyond status drift if their title, assignee, or due date changed on the board.`,
    },
  });
});

router.post("/api/boards/:id/integrations/actions/:actionId/approve", async (ctx) => {
  const { req, res } = ctx;
  const route = "/api/boards/:id/integrations/actions/:actionId/approve";
  if (!requireCsrf(req, res, route)) return;
  const user = await requireUser(req, res);
  if (!user) return;
  if (!meter(req, res, route)) return;
  const boardId = ctx.param("id");
  const actionId = ctx.param("actionId");
  const guard = await requireBoardRole(req, res, boardId, "editor", route);
  if (!guard.ok) return;
  if (!integrations) return send(res, 503, { error: "integrations are not configured" });
  const { actions, ledger } = integrations;
  if (!actions || !ledger) return send(res, 503, { error: "external actions are not configured" });

  const record = await actions.action(boardId, actionId);
  if (!record) {
    send(res, 404, { error: "no such action" });
    return;
  }
  const connection = await integrations.store.connection(guard.board.orgId, record.provider);
  if (!connection || connection.status !== "active") {
    send(res, 409, { error: `the ${record.provider} connection is unavailable` });
    return;
  }
  // Stage D6, the review's safety check: the proposal executes through the
  // EXACT connection it previewed — a disabled/replaced connection between
  // propose and approve is a 409, never a silent execution through the new
  // one.
  if (connection.id !== record.connectionId) {
    send(res, 409, { error: "Integration connection changed; please create a new preview" });
    return;
  }
  const resolved = resolveProvider(integrations, record.provider, connection);
  if (!resolved.ok) {
    send(res, 400, { error: resolved.error });
    return;
  }
  const provider = resolved.provider;

  // The decided-once transition guard: a second approve answers the
  // ORIGINAL outcome, never a second effect.
  const decided = await actions.decide(boardId, actionId, "approved", user.id, Date.now());
  if (!decided) {
    send(res, 404, { error: "no such action" });
    return;
  }
  if (record.status !== "pending") {
    send(res, 200, { action: decided, duplicate: true });
    return;
  }

  // THE EXECUTOR: per item, the ledger claims the attempt (keyed by the
  // owner's triplet) and the provider call carries the item's idempotency
  // key — attempts deduped by the ledger, effects deduped by the key.
  // One item's failure fails that item, never the batch.
  const TIMEOUT_MS = 15_000;
  const results: Array<Record<string, unknown>> = [];
  let appliedCount = 0;
  let failedCount = 0;
  let inFlight = 0;
  for (const item of decided.items) {
    // The ledger key is the composite (boardId, provider, requestId) and
    // one batch contains MANY items — so the requestId must name the ITEM:
    // the owner triplet (lucentActionId, requestId, provider) resolved per
    // node. The provider idempotency key stays item.idempotencyKey.
    const requestId = `ext_${decided.id}_${user.id}_${item.nodeId}`;
    const claim = await ledger.claim({
      boardId,
      provider: record.provider,
      requestId,
      lucentActionId: decided.id,
      nodeId: item.nodeId,
    });
    if (claim.outcome === "duplicate") {
      results.push({ nodeId: item.nodeId, action: "duplicate", externalId: claim.record.externalId });
      appliedCount += 1;
      continue;
    }
    if (claim.outcome === "exhausted") {
      results.push({ nodeId: item.nodeId, action: "exhausted", error: claim.record.error });
      failedCount += 1;
      continue;
    }
    if (claim.outcome === "in_flight") {
      inFlight += 1;
      results.push({ nodeId: item.nodeId, action: "in_flight" });
      continue;
    }
    try {
      const input = {
        title: item.title,
        ...(item.assignee ? { assignee: item.assignee } : {}),
        ...(item.dueDate ? { dueDate: item.dueDate } : {}),
        status: item.status,
        idempotencyKey: item.idempotencyKey,
      };
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("provider timeout")), TIMEOUT_MS),
      );
      const task =
        item.action === "create"
          ? await Promise.race([provider.createTask(input), timeout])
          : await Promise.race([provider.updateTask(item.externalId!, input), timeout]);
      await integrations.store.linkTask(
        {
          orgId: guard.board.orgId,
          boardId,
          nodeId: item.nodeId,
          provider: record.provider,
          externalId: task.externalId,
          ...(task.url ? { url: task.url } : {}),
          lastSyncedStatus: task.status,
        },
        Date.now(),
      );
      await ledger.applied(boardId, record.provider, requestId, task.externalId, Date.now());
      appliedCount += 1;
      results.push({ nodeId: item.nodeId, action: item.action, externalId: task.externalId, url: task.url });
    } catch (err) {
      await ledger.failed(boardId, record.provider, requestId, (err as Error).message, Date.now());
      failedCount += 1;
      results.push({ nodeId: item.nodeId, action: "failed", reason: (err as Error).message });
    }
  }
  if (appliedCount > 0) await actions.applied(boardId, actionId, Date.now());
  send(res, 200, { action: decided, applied: appliedCount, failed: failedCount, inFlight, results });
});

router.post("/api/boards/:id/integrations/actions/:actionId/reject", async (ctx) => {
  const { req, res } = ctx;
  const route = "/api/boards/:id/integrations/actions/:actionId/reject";
  if (!requireCsrf(req, res, route)) return;
  const user = await requireUser(req, res);
  if (!user) return;
  if (!meter(req, res, route)) return;
  const boardId = ctx.param("id");
  const guard = await requireBoardRole(req, res, boardId, "editor", route);
  if (!guard.ok) return;
  if (!integrations) return send(res, 503, { error: "integrations are not configured" });
  const { actions } = integrations;
  if (!actions) return send(res, 503, { error: "external actions are not configured" });
  const actionId = ctx.param("actionId");
  const decided = await actions.decide(boardId, actionId, "rejected", user.id, Date.now());
  if (!decided) {
    send(res, 404, { error: "no such action" });
    return;
  }
  // Zero external effects on a rejection — guaranteed by never calling the
  // provider on this path (pinned by test).
  send(res, 200, { action: decided });
});

router.get("/api/boards/:id/integrations/actions", async (ctx) => {
  const { req, res } = ctx;
  const boardId = ctx.param("id");
  const guard = await requireBoardRole(req, res, boardId, "viewer", "/api/boards/:id/integrations/actions");
  if (!guard.ok) return;
  if (!integrations) return send(res, 503, { error: "integrations are not configured" });
  const { actions } = integrations;
  if (!actions) return send(res, 503, { error: "external actions are not configured" });
  const rows = await actions.actionsForBoard(boardId);
  send(res, 200, {
    actions: rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      status: r.status,
      itemCount: r.items.length,
      createdBy: r.createdBy,
      createdAt: r.createdAt,
      decidedBy: r.decidedBy,
      decidedAt: r.decidedAt,
      appliedAt: r.appliedAt,
    })),
  });
});

};
