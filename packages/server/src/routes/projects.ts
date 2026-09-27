import type { StoredBoard } from "../boards.js";
import type { IndexedStatement } from "../statementIndex.js";
import {
  newProjectId,
  validateProjectInput,
  type ProjectPatch,
  type StoredProject,
} from "../projects.js";
import type { RegisterRoutes } from "./context.js";

/**
 * Projects (docs/26 J2, ADR 0046):
 *
 *   GET    /api/orgs/:id/projects                   the org's projects (member), or those
 *                                                   holding a board shared with the caller
 *   POST   /api/orgs/:id/projects                   create (org editor, CSRF, audited)
 *   GET    /api/orgs/:id/projects/:pid              one project: boards, meetings, statements
 *   PATCH  /api/orgs/:id/projects/:pid              edit or archive (org editor, CSRF, audited)
 *   PUT    /api/orgs/:id/projects/:pid/boards/:bid  link a board (org editor, CSRF, audited)
 *   DELETE /api/orgs/:id/projects/:pid/boards/:bid  unlink it
 *   GET    /api/boards/:id/projects                 the projects a board is in (board viewer)
 *
 * A project grants nothing: its boards, meetings and statements are shown
 * only where the caller can read the board. A project someone can see no
 * board of — and isn't an org member — is "not found", the same answer as a
 * project that doesn't exist.
 */

/** What a project's page and card count, from the index. */
export interface ProjectStats {
  openQuestions: number;
  openActions: number;
  blocked: number;
  decisions: number;
  openRisks: number;
}

function statsOf(rows: readonly IndexedStatement[]): ProjectStats {
  const stats: ProjectStats = {
    openQuestions: 0,
    openActions: 0,
    blocked: 0,
    decisions: 0,
    openRisks: 0,
  };
  for (const r of rows) {
    if (r.kind === "question" && r.status === "open") stats.openQuestions += 1;
    if (r.kind === "action" && r.status === "open") stats.openActions += 1;
    if (r.kind === "action" && r.status === "open" && r.blocked) stats.blocked += 1;
    if (r.kind === "decision" && r.status !== "rejected" && r.status !== "superseded") {
      stats.decisions += 1;
    }
    if (r.kind === "risk" && r.status === "open") stats.openRisks += 1;
  }
  return stats;
}

function view(project: StoredProject, readable: ReadonlyMap<string, StoredBoard>) {
  return {
    id: project.id,
    orgId: project.orgId,
    name: project.name,
    objective: project.objective,
    status: project.status,
    leadId: project.leadId,
    members: project.members,
    createdBy: project.createdBy,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    archivedAt: project.archivedAt,
    // Only the boards this caller can open; the rest aren't mentioned.
    boards: project.boardIds
      .filter((id) => readable.has(id))
      .map((id) => {
        const b = readable.get(id)!;
        return { id: b.id, name: b.name, updatedAt: b.updatedAt };
      }),
  };
}

export const registerProjectRoutes: RegisterRoutes = (router, s) => {
  const {
    send,
    requireUser,
    requireCsrf,
    requireOrgRole,
    requireBoardRole,
    readBody,
    readableBoards,
    projects,
    intelligence,
    meetings,
    boardStore,
    userStore,
    auditRow,
  } = s;

  /** The project if this caller may see it in this org, else undefined. */
  async function visible(orgId: string, projectId: string, userId: string) {
    const project = await projects.get(projectId);
    if (!project || project.orgId !== orgId) return undefined;
    const { member, boards } = await readableBoards(userId, orgId);
    const readable = new Map(boards.map((b) => [b.id, b] as const));
    if (!member && !project.boardIds.some((id) => readable.has(id))) return undefined;
    return { project, readable, member };
  }

  async function parse(req: Parameters<typeof readBody>[0]): Promise<unknown> {
    const raw = await readBody(req);
    return raw ? (JSON.parse(raw) as unknown) : {};
  }

  /**
   * Lead and members must be people in the org — never arbitrary ids. Read
   * through the same membership lookup as `readableBoards`, which holds for
   * personal orgs on every store.
   */
  async function checkPeople(orgId: string, patch: ProjectPatch): Promise<string | null> {
    const ids = [...new Set([...(patch.members ?? []), ...(patch.leadId ? [patch.leadId] : [])])];
    for (const id of ids) {
      const memberships = await userStore.membershipsFor(id);
      if (!memberships.some((m) => m.orgId === orgId)) {
        return "the lead and members must be members of this workspace";
      }
    }
    return null;
  }

  router.get("/api/orgs/:id/projects", async (ctx) => {
    const { req, res } = ctx;
    const user = await requireUser(req, res);
    if (!user) return;
    const orgId = ctx.param("id");
    const url = new URL(req.url ?? "/", "http://localhost");
    const includeArchived = url.searchParams.get("archived") === "1";
    const { member, boards } = await readableBoards(user.id, orgId);
    const readable = new Map(boards.map((b) => [b.id, b] as const));
    const all = await projects.listForOrg(orgId, { includeArchived });
    const shown = member ? all : all.filter((p) => p.boardIds.some((id) => readable.has(id)));

    // One index read for every card's counts.
    const linked = boards.filter((b) => shown.some((p) => p.boardIds.includes(b.id)));
    await intelligence.freshen(linked);
    const rows = await intelligence.store.query(linked.map((b) => b.id));
    send(res, 200, {
      orgId,
      projects: shown.map((p) => {
        const boardIds = new Set(p.boardIds);
        return {
          ...view(p, readable),
          stats: statsOf(rows.filter((r) => boardIds.has(r.boardId))),
        };
      }),
    });
  });

  router.post("/api/orgs/:id/projects", async (ctx) => {
    const { req, res } = ctx;
    if (!requireCsrf(req, res, "/api/orgs/:id/projects")) return;
    const orgId = ctx.param("id");
    const guard = await requireOrgRole(req, res, orgId, "editor", "/api/orgs/:id/projects");
    if (!guard.ok) return;
    let body: unknown;
    try {
      body = await parse(req);
    } catch (err) {
      return send(res, 400, { error: "bad request", detail: (err as Error).message });
    }
    const checked = validateProjectInput(body, "create");
    if (!checked.ok) return send(res, 400, { error: checked.error });
    const input = checked.value;
    const people = await checkPeople(orgId, input);
    if (people) return send(res, 400, { error: people });
    const boardIds = input.boardIds ?? [];
    for (const id of boardIds) {
      const board = await boardStore.get(id);
      if (!board || board.orgId !== orgId) {
        return send(res, 400, { error: "every board must be in this workspace" });
      }
    }
    const at = Date.now();
    const project: StoredProject = {
      id: newProjectId(),
      orgId,
      name: input.name!,
      objective: input.objective ?? "",
      status: input.status ?? "active",
      leadId: input.leadId ?? guard.user.id,
      members: input.members ?? [guard.user.id],
      createdBy: guard.user.id,
      createdAt: at,
      updatedAt: at,
      archivedAt: null,
      boardIds,
    };
    await projects.create(project);
    await auditRow(req, guard.user.id, orgId, "project.created", project.id, {
      name: project.name,
      boards: boardIds.length,
    });
    const { boards } = await readableBoards(guard.user.id, orgId);
    send(res, 201, view(project, new Map(boards.map((b) => [b.id, b] as const))));
  });

  router.get("/api/orgs/:id/projects/:pid", async (ctx) => {
    const { req, res } = ctx;
    const user = await requireUser(req, res);
    if (!user) return;
    const orgId = ctx.param("id");
    const found = await visible(orgId, ctx.param("pid"), user.id);
    if (!found) return send(res, 404, { error: "project not found" });
    const { project, readable } = found;
    const boards = project.boardIds.map((id) => readable.get(id)).filter((b) => b !== undefined);
    await intelligence.freshen(boards);
    const rows = await intelligence.store.query(boards.map((b) => b.id));
    const names = new Map(boards.map((b) => [b.id, b.name] as const));
    let meetingSummaries: unknown[] = [];
    if (meetings && boards.length > 0) {
      const { summarizeMeeting } = await import("../meetings.js");
      meetingSummaries = (await meetings.forBoards([...names.keys()], 50)).map((m) =>
        summarizeMeeting(m, names.get(m.boardId) ?? ""),
      );
    }
    send(res, 200, {
      project: { ...view(project, readable), stats: statsOf(rows) },
      meetings: meetingSummaries,
      statements: rows.map((r) => ({ ...r, boardName: names.get(r.boardId) ?? "" })),
    });
  });

  router.patch("/api/orgs/:id/projects/:pid", async (ctx) => {
    const { req, res } = ctx;
    if (!requireCsrf(req, res, "/api/orgs/:id/projects/:pid")) return;
    const orgId = ctx.param("id");
    const guard = await requireOrgRole(req, res, orgId, "editor", "/api/orgs/:id/projects/:pid");
    if (!guard.ok) return;
    const current = await projects.get(ctx.param("pid"));
    if (!current || current.orgId !== orgId) return send(res, 404, { error: "project not found" });
    let body: unknown;
    try {
      body = await parse(req);
    } catch (err) {
      return send(res, 400, { error: "bad request", detail: (err as Error).message });
    }
    const checked = validateProjectInput(body, "update");
    if (!checked.ok) return send(res, 400, { error: checked.error });
    const people = await checkPeople(orgId, checked.value);
    if (people) return send(res, 400, { error: people });
    const updated = await projects.update(current.id, checked.value, Date.now());
    if (!updated) return send(res, 404, { error: "project not found" });
    const archivedNow = checked.value.archived === true && current.archivedAt === null;
    await auditRow(
      req,
      guard.user.id,
      orgId,
      archivedNow ? "project.archived" : "project.updated",
      current.id,
      { fields: Object.keys(checked.value) },
    );
    const { boards } = await readableBoards(guard.user.id, orgId);
    send(res, 200, view(updated, new Map(boards.map((b) => [b.id, b] as const))));
  });

  for (const method of ["put", "delete"] as const) {
    router[method]("/api/orgs/:id/projects/:pid/boards/:bid", async (ctx) => {
      const { req, res } = ctx;
      const route = "/api/orgs/:id/projects/:pid/boards/:bid";
      if (!requireCsrf(req, res, route)) return;
      const orgId = ctx.param("id");
      const guard = await requireOrgRole(req, res, orgId, "editor", route);
      if (!guard.ok) return;
      const project = await projects.get(ctx.param("pid"));
      if (!project || project.orgId !== orgId)
        return send(res, 404, { error: "project not found" });
      const boardId = ctx.param("bid");
      const board = await boardStore.get(boardId);
      if (!board || board.orgId !== orgId) {
        return send(res, 404, { error: "board not found in this workspace" });
      }
      const at = Date.now();
      const changed =
        method === "put"
          ? await projects.linkBoard(project.id, boardId, guard.user.id, at)
          : await projects.unlinkBoard(project.id, boardId, at);
      if (changed) {
        await auditRow(
          req,
          guard.user.id,
          orgId,
          method === "put" ? "project.board_linked" : "project.board_unlinked",
          project.id,
          { boardId },
        );
      }
      const updated = (await projects.get(project.id)) ?? project;
      const { boards } = await readableBoards(guard.user.id, orgId);
      send(res, 200, view(updated, new Map(boards.map((b) => [b.id, b] as const))));
    });
  }

  router.get("/api/boards/:id/projects", async (ctx) => {
    const { req, res } = ctx;
    const boardId = ctx.param("id");
    const guard = await requireBoardRole(req, res, boardId, "viewer", "/api/boards/:id/projects");
    if (!guard.ok) return;
    const linked = (await projects.forBoard(boardId)).filter((p) => p.orgId === guard.board.orgId);
    send(res, 200, {
      boardId,
      projects: linked.map((p) => ({ id: p.id, name: p.name, status: p.status })),
    });
  });
};
