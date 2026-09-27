import {
  statementKindSchema,
  statementStatusSchema,
  type StatementKind,
  type StatementStatus,
} from "@lucent/core";
import type { RegisterRoutes } from "./context.js";

/**
 * Workspace intelligence (docs/26 J3, ADR 0046):
 *
 *   GET  /api/orgs/:id/intelligence          every statement the caller can read
 *   POST /api/orgs/:id/intelligence/rebuild  drop and re-derive the org's index (owner)
 *
 * The read answers only from the boards the caller can read (the two scopes
 * of the workspace meetings list), repairs any of them the index has fallen
 * behind before answering, and narrows by `kind`, `status` (comma lists),
 * `project`, `board` and `assignee` (`me`, or a name). Counts per kind cover
 * the whole scope, before the kind/status/assignee filters, so a caller can
 * show "3 open questions" beside a list of decisions.
 */

const KINDS = new Set<string>(statementKindSchema.options);
const STATUSES = new Set<string>(statementStatusSchema.options);
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2000;

function list<T extends string>(raw: string | null, allowed: Set<string>): T[] | "invalid" {
  if (!raw) return [];
  const values = raw
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  return values.every((v) => allowed.has(v)) ? (values as T[]) : "invalid";
}

export const registerIntelligenceRoutes: RegisterRoutes = (router, s) => {
  const {
    send,
    requireUser,
    requireCsrf,
    requireOrgRole,
    readableBoards,
    projects,
    intelligence,
    boardStore,
    auditRow,
  } = s;

  router.get("/api/orgs/:id/intelligence", async (ctx) => {
    const { req, res } = ctx;
    const user = await requireUser(req, res);
    if (!user) return;
    const orgId = ctx.param("id");
    const url = new URL(req.url ?? "/", "http://localhost");

    const kinds = list<StatementKind>(url.searchParams.get("kind"), KINDS);
    const statuses = list<StatementStatus>(url.searchParams.get("status"), STATUSES);
    if (kinds === "invalid") {
      return send(res, 400, { error: `kind is a comma list of ${[...KINDS].join(", ")}` });
    }
    if (statuses === "invalid") {
      return send(res, 400, { error: `status is a comma list of ${[...STATUSES].join(", ")}` });
    }
    const requested = Number(url.searchParams.get("limit"));
    const limit =
      Number.isInteger(requested) && requested > 0 ? Math.min(requested, MAX_LIMIT) : DEFAULT_LIMIT;

    const { member, boards } = await readableBoards(user.id, orgId, req);
    let scope = boards;
    const projectId = url.searchParams.get("project");
    if (projectId) {
      const project = await projects.get(projectId);
      // A project in another org, or one the caller can see none of, is
      // simply not found — the same answer as a project that doesn't exist.
      const linked = new Set(project?.orgId === orgId ? project.boardIds : []);
      scope = scope.filter((b) => linked.has(b.id));
      if (!project || project.orgId !== orgId || (!member && scope.length === 0)) {
        return send(res, 404, { error: "project not found" });
      }
    }
    const boardId = url.searchParams.get("board");
    if (boardId) scope = scope.filter((b) => b.id === boardId);

    const fresh = await intelligence.freshen(scope);
    const rows = await intelligence.store.query(scope.map((b) => b.id));

    const counts: Record<string, { total: number; open: number }> = {};
    for (const kind of KINDS) counts[kind] = { total: 0, open: 0 };
    for (const row of rows) {
      counts[row.kind]!.total += 1;
      if (row.status === "open") counts[row.kind]!.open += 1;
    }

    const assignee = url.searchParams.get("assignee")?.trim().toLowerCase() ?? "";
    // "me": the caller's name, their email, or the part before the @ — the
    // spellings an assignee field typed by hand or synced from a tracker uses.
    const names =
      assignee === "me"
        ? new Set(
            [user.name, user.email, user.email.split("@")[0]]
              .filter((v): v is string => typeof v === "string" && v.length > 0)
              .map((v) => v.toLowerCase()),
          )
        : new Set(assignee ? [assignee] : []);

    const boardNames = new Map(scope.map((b) => [b.id, b.name] as const));
    const matching = rows.filter(
      (r) =>
        (kinds.length === 0 || kinds.includes(r.kind)) &&
        (statuses.length === 0 || statuses.includes(r.status)) &&
        (names.size === 0 || (r.assignee !== undefined && names.has(r.assignee.toLowerCase()))),
    );
    send(res, 200, {
      orgId,
      statements: matching
        .slice(0, limit)
        .map((r) => ({ ...r, boardName: boardNames.get(r.boardId) ?? "" })),
      total: matching.length,
      truncated: matching.length > limit,
      counts,
      boards: scope.length,
      // Boards the index was behind on and couldn't catch up this read; they
      // answer from their last derivation and catch up on the next.
      stale: fresh.stale,
    });
  });

  router.post("/api/orgs/:id/intelligence/rebuild", async (ctx) => {
    const { req, res } = ctx;
    if (!requireCsrf(req, res, "/api/orgs/:id/intelligence/rebuild")) return;
    const orgId = ctx.param("id");
    const guard = await requireOrgRole(
      req,
      res,
      orgId,
      "owner",
      "/api/orgs/:id/intelligence/rebuild",
    );
    if (!guard.ok) return;
    const boards = await boardStore.listForOrg(orgId);
    const count = await intelligence.rebuild(orgId, boards);
    await auditRow(req, guard.user.id, orgId, "intelligence.rebuilt", orgId, { boards: count });
    send(res, 200, { orgId, boards: count });
  });
};
