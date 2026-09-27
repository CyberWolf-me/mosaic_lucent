import { stampAuthorship, validateOperations, type Operation, type Workspace } from "@lucent/core";
import type { StoredBoard } from "../boards.js";
import { commitBatch } from "../commitBatch.js";
import { AI_SURFACES, type AiSurface } from "../aiRuns.js";
import type { RegisterRoutes } from "./context.js";

/**
 * The Review center and AI run records (docs/26 J5/J6, ADR 0047):
 *
 *   GET  /api/orgs/:id/review         everything waiting on a person, across the
 *                                     boards the caller can read
 *   POST /api/boards/:id/review       decide statements: approve · edit · reject ·
 *                                     assign (board editor, CSRF, audited)
 *   GET  /api/orgs/:id/ai-runs        the org's AI runs (owner)
 *   GET  /api/boards/:id/ai-runs      one board's AI runs (board viewer)
 *
 * The queue is four kinds of waiting: statements the AI suggested (from the
 * index), proposals, external actions, and inbound changes. Proposals,
 * actions and inbound changes keep their own decide routes; statements are
 * decided here, composed into ordinary operations on the server and committed
 * through the same path as the ops route, as the person who decided.
 */

const MAX_REVIEW_NODES = 100;
const MAX_LABEL = 500;

type ReviewAction = "approve" | "reject" | "edit" | "assign";

/** The operations one decision becomes, or why it can't. */
export function reviewOps(
  workspace: Workspace,
  nodeIds: readonly string[],
  action: ReviewAction,
  fields: { label?: string; assignee?: string | null; dueDate?: string | null } = {},
): { ok: true; ops: Operation[] } | { ok: false; error: string } {
  const ops: Operation[] = [];
  for (const id of nodeIds) {
    const node = workspace.nodes[id];
    if (!node?.statement) return { ok: false, error: `"${id}" isn't a statement on this board` };
    switch (action) {
      case "approve":
        ops.push({ op: "UPDATE_STATEMENT", id, trust: "human-approved" });
        break;
      case "reject":
        // A suggestion that shouldn't be there goes; the op log keeps it and
        // undo brings it back.
        ops.push({ op: "DELETE_NODE", id });
        break;
      case "edit": {
        const label = fields.label?.trim();
        if (!label) return { ok: false, error: "an edit needs the new wording" };
        ops.push({ op: "CHANGE_TEXT", id, text: label.slice(0, MAX_LABEL) });
        ops.push({ op: "UPDATE_STATEMENT", id, trust: "human-edited" });
        break;
      }
      case "assign": {
        const assignee = fields.assignee?.trim() || null;
        const dueDate = fields.dueDate ?? null;
        if (!assignee && !dueDate)
          return { ok: false, error: "assign needs an owner or a due date" };
        if (node.issue) {
          ops.push({
            op: "UPDATE_ISSUE",
            id,
            ...(assignee !== null ? { assignee } : {}),
            ...(dueDate !== null ? { dueDate } : {}),
          });
        } else {
          ops.push({
            op: "SET_ISSUE",
            id,
            issue: {
              type: "task",
              status: assignee ? "assigned" : "open",
              ...(assignee ? { assignee } : {}),
              ...(dueDate ? { dueDate } : {}),
            },
          } as Operation);
        }
        // Owning it is accepting it.
        ops.push({ op: "UPDATE_STATEMENT", id, trust: "human-approved" });
        break;
      }
    }
  }
  return { ok: true, ops };
}

export const registerReviewRoutes: RegisterRoutes = (router, s) => {
  const {
    send,
    readBody,
    requireUser,
    requireCsrf,
    requireOrgRole,
    requireBoardRole,
    readableBoards,
    intelligence,
    proposals,
    integrations,
    meetings,
    boardStore,
    userStore,
    orgRoleFor,
    aiRuns,
    auditRow,
  } = s;

  router.get("/api/orgs/:id/review", async (ctx) => {
    const { req, res } = ctx;
    const user = await requireUser(req, res);
    if (!user) return;
    const orgId = ctx.param("id");
    const { boards } = await readableBoards(user.id, orgId);
    const url = new URL(req.url ?? "/", "http://localhost");
    const only = url.searchParams.get("board");
    const scope = only ? boards.filter((b) => b.id === only) : boards;
    const ids = scope.map((b) => b.id);
    const byId = new Map<string, StoredBoard>(scope.map((b) => [b.id, b]));

    // Who may decide what: an editor on the board.
    const decide = new Map<string, boolean>();
    for (const b of scope) {
      const role = await boardStore.memberRole(b.id, user.id, (uid) => orgRoleFor(uid, b.orgId));
      decide.set(b.id, role === "editor" || role === "owner");
    }

    await intelligence.freshen(scope);
    const suggested = (await intelligence.store.query(ids)).filter(
      (r) => r.trust === "ai-suggested",
    );
    const meetingIds = new Set(
      suggested.flatMap((r) => (r.provenance ? [r.provenance.meetingId] : [])),
    );
    const meetingNames = new Map<string, { title: string | null; startedAt: number }>();
    if (meetings && meetingIds.size > 0) {
      for (const m of await meetings.forBoards(ids, 200)) {
        if (meetingIds.has(m.id))
          meetingNames.set(m.id, { title: m.title ?? null, startedAt: m.startedAt });
      }
    }
    const pendingProposals = proposals ? await proposals.pendingForBoards(ids) : [];
    const actions = [];
    const inbound = [];
    for (const id of ids) {
      if (integrations?.actions) {
        for (const a of await integrations.actions.actionsForBoard(id)) {
          if (a.status === "pending") actions.push(a);
        }
      }
      if (integrations?.inbound) {
        for (const c of await integrations.inbound.forBoard(id)) {
          if (c.status === "pending") inbound.push(c);
        }
      }
    }
    const boardName = (id: string) => byId.get(id)?.name ?? "";

    send(res, 200, {
      orgId,
      boards: Object.fromEntries(
        scope.map((b) => [b.id, { name: b.name, canDecide: decide.get(b.id) === true }]),
      ),
      statements: suggested.map((r) => ({
        ...r,
        boardName: boardName(r.boardId),
        ...(r.provenance && meetingNames.has(r.provenance.meetingId)
          ? {
              meeting: { id: r.provenance.meetingId, ...meetingNames.get(r.provenance.meetingId)! },
            }
          : {}),
      })),
      proposals: pendingProposals.map((p) => ({
        id: p.id,
        boardId: p.boardId,
        boardName: boardName(p.boardId),
        request: p.request,
        explanation: p.explanation,
        operations: p.operations.length,
        meetingId: p.meetingId,
        quote: p.provenance?.quote ?? null,
        createdBy: p.createdBy,
        createdAt: p.createdAt,
      })),
      actions: actions.map((a) => ({
        id: a.id,
        boardId: a.boardId,
        boardName: boardName(a.boardId),
        provider: a.provider,
        origin: a.origin ?? "user",
        items: a.items.map((i) => ({ nodeId: i.nodeId, action: i.action, title: i.title })),
        createdAt: a.createdAt,
      })),
      inbound: inbound.map((c) => ({
        id: c.id,
        boardId: c.boardId,
        boardName: boardName(c.boardId),
        provider: c.provider,
        nodeId: c.nodeId,
        label: byId.get(c.boardId)?.workspace.nodes[c.nodeId]?.label ?? c.nodeId,
        field: c.field,
        externalValue: c.externalValue,
        mappedValue: c.mappedValue ?? null,
        detectedAt: c.detectedAt,
      })),
      counts: {
        statements: suggested.length,
        proposals: pendingProposals.length,
        actions: actions.length,
        inbound: inbound.length,
      },
    });
  });

  router.post("/api/boards/:id/review", async (ctx) => {
    const { req, res } = ctx;
    const route = "/api/boards/:id/review";
    if (!requireCsrf(req, res, route)) return;
    const boardId = ctx.param("id");
    const guard = await requireBoardRole(req, res, boardId, "editor", route);
    if (!guard.ok) return;
    let body: {
      nodeIds?: unknown;
      action?: unknown;
      label?: unknown;
      assignee?: unknown;
      dueDate?: unknown;
    };
    try {
      const raw = await readBody(req);
      body = raw ? (JSON.parse(raw) as typeof body) : {};
    } catch (err) {
      return send(res, 400, { error: "bad request", detail: (err as Error).message });
    }
    const action = body.action;
    if (action !== "approve" && action !== "reject" && action !== "edit" && action !== "assign") {
      return send(res, 400, { error: "action is approve, reject, edit or assign" });
    }
    if (
      !Array.isArray(body.nodeIds) ||
      body.nodeIds.length === 0 ||
      body.nodeIds.length > MAX_REVIEW_NODES ||
      !body.nodeIds.every((id) => typeof id === "string" && id.length > 0)
    ) {
      return send(res, 400, { error: `nodeIds is a list of 1–${MAX_REVIEW_NODES} statement ids` });
    }
    const nodeIds = [...new Set(body.nodeIds as string[])];
    if ((action === "edit" || action === "assign") && nodeIds.length !== 1) {
      return send(res, 400, { error: `${action} decides one statement at a time` });
    }
    const dueDate =
      typeof body.dueDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.dueDate)
        ? body.dueDate
        : null;
    const composed = reviewOps(guard.board.workspace, nodeIds, action, {
      ...(typeof body.label === "string" ? { label: body.label } : {}),
      assignee: typeof body.assignee === "string" ? body.assignee.slice(0, 120) : null,
      dueDate,
    });
    if (!composed.ok) return send(res, 400, { error: composed.error });
    const operations = stampAuthorship(composed.ops, guard.user.id);
    const errors = validateOperations(guard.board.workspace, operations);
    if (errors.length > 0) {
      return send(res, 422, { error: "the review no longer applies to this board", errors });
    }
    const label =
      action === "approve"
        ? `Approved ${nodeIds.length === 1 ? "a suggestion" : `${nodeIds.length} suggestions`}`
        : action === "reject"
          ? `Rejected ${nodeIds.length === 1 ? "a suggestion" : `${nodeIds.length} suggestions`}`
          : action === "edit"
            ? "Edited a suggestion"
            : "Assigned a suggestion";
    const outcome = await commitBatch(s, guard.board, guard.user.id, operations, label, {
      actorType: "user",
      actorId: guard.user.id,
      initiatedBy: guard.user.id,
    });
    if (!outcome.ok) {
      return send(res, 409, { error: "stale board", reason: outcome.reason, head: outcome.head });
    }
    await auditRow(req, guard.user.id, guard.board.orgId, `review.${action}`, boardId, {
      nodes: nodeIds.length,
      seq: outcome.seq,
    });
    // docs/26 A5: approved (or reworded) decisions may plan themselves — the
    // org's rule decides, when the job runs.
    if (action === "approve" || action === "edit") {
      const decisions = nodeIds.filter(
        (id) => guard.board.workspace.nodes[id]?.statement?.kind === "decision",
      );
      if (decisions.length > 0) {
        s.announceDecisionApproved({
          boardId,
          orgId: guard.board.orgId,
          nodeIds: decisions,
          by: guard.user.id,
        });
      }
    }
    send(res, 200, { seq: outcome.seq, applied: operations.length });
  });

  /** Runs with the names of who started and approved them. */
  async function withNames(runs: import("../aiRuns.js").AiRun[]) {
    const ids = [
      ...new Set(
        runs.flatMap((r) => [r.initiatedBy, r.approvedBy].filter((v): v is string => Boolean(v))),
      ),
    ].slice(0, 100);
    const names = new Map<string, string>();
    for (const id of ids) {
      const u = await userStore.findById(id);
      if (u) names.set(id, u.name || u.email);
    }
    return runs.map((r) => ({
      ...r,
      initiatedByName: r.initiatedBy ? (names.get(r.initiatedBy) ?? null) : null,
      approvedByName: r.approvedBy ? (names.get(r.approvedBy) ?? null) : null,
    }));
  }

  function runFilter(req: { url?: string }): { surface?: AiSurface; limit?: number } {
    const url = new URL(req.url ?? "/", "http://localhost");
    const surface = url.searchParams.get("surface");
    const limit = Number(url.searchParams.get("limit"));
    return {
      ...(surface && (AI_SURFACES as readonly string[]).includes(surface)
        ? { surface: surface as AiSurface }
        : {}),
      ...(Number.isInteger(limit) && limit > 0 ? { limit } : {}),
    };
  }

  router.get("/api/orgs/:id/ai-runs", async (ctx) => {
    const { req, res } = ctx;
    const orgId = ctx.param("id");
    const guard = await requireOrgRole(req, res, orgId, "owner", "/api/orgs/:id/ai-runs");
    if (!guard.ok) return;
    const runs = await aiRuns.forOrg(orgId, runFilter(req));
    const boardNames = new Map<string, string>();
    for (const id of new Set(runs.flatMap((r) => (r.boardId ? [r.boardId] : [])))) {
      const b = await boardStore.get(id);
      if (b) boardNames.set(id, b.name);
    }
    send(res, 200, {
      orgId,
      runs: (await withNames(runs)).map((r) => ({
        ...r,
        boardName: r.boardId ? (boardNames.get(r.boardId) ?? null) : null,
      })),
    });
  });

  router.get("/api/boards/:id/ai-runs", async (ctx) => {
    const { req, res } = ctx;
    const boardId = ctx.param("id");
    const guard = await requireBoardRole(req, res, boardId, "viewer", "/api/boards/:id/ai-runs");
    if (!guard.ok) return;
    const runs = await aiRuns.forOrg(guard.board.orgId, { ...runFilter(req), boardIds: [boardId] });
    send(res, 200, { boardId, runs: await withNames(runs) });
  });
};
