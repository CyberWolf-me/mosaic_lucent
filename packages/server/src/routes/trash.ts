import type { RegisterRoutes } from "./context.js";
import { roleAtLeast, type Role } from "../identity.js";
import { TRASH_WINDOW_MS, type TrashKind } from "../trash.js";

/**
 * The trash (docs/26 A6):
 *
 *   DELETE /api/boards/:id/meetings/:mid       a meeting to the trash (board editor)
 *   DELETE /api/orgs/:id/projects/:pid         a project to the trash (org editor)
 *   GET    /api/orgs/:id/trash                 what you can restore here
 *   POST   /api/orgs/:id/trash/restore         { kind, id } — bring it back
 *   DELETE /api/orgs/:id/trash/:kind/:id       delete for good now (org owner)
 *
 * (DELETE /api/boards/:id already moves a board here.) Whoever could delete
 * something can restore it: a board's owner or the org's owner, a meeting's
 * board editors, the org's editors for a project. After 30 days the sweep
 * purges it; an org owner can do that sooner.
 */
export const registerTrashRoutes: RegisterRoutes = (router, s) => {
  const {
    send,
    readBody,
    requireCsrf,
    requireUser,
    requireOrgRole,
    requireBoardRole,
    meter,
    auditRow,
  } = s;
  const trash = s.trash;

  const meetingName = (m: { title?: string; startedAt: number }) =>
    m.title ?? `Meeting on ${new Date(m.startedAt).toISOString().slice(0, 10)}`;

  router.delete("/api/boards/:id/meetings/:mid", async (ctx) => {
    const { req, res } = ctx;
    const route = "/api/boards/:id/meetings/:mid";
    if (!requireCsrf(req, res, route)) return;
    const boardId = ctx.param("id");
    const guard = await requireBoardRole(req, res, boardId, "editor", route);
    if (!guard.ok) return;
    if (!s.meetings) return send(res, 503, { error: "meeting transcripts are not configured" });
    const meeting = await s.meetings.get(boardId, ctx.param("mid"));
    if (!meeting) return send(res, 404, { error: "no such meeting" });
    if (meeting.endedAt === null) {
      return send(res, 409, { error: "end the meeting before deleting it" });
    }
    const at = Date.now();
    await trash.put({
      kind: "meeting",
      id: meeting.id,
      orgId: guard.board.orgId,
      boardId,
      name: meetingName(meeting),
      deletedBy: guard.user.id,
      deletedAt: at,
    });
    void auditRow(req, guard.user.id, guard.board.orgId, "meeting.trashed", meeting.id, {
      boardId,
    });
    send(res, 200, { trashed: meeting.id, purgeAt: at + TRASH_WINDOW_MS });
  });

  router.delete("/api/orgs/:id/projects/:pid", async (ctx) => {
    const { req, res } = ctx;
    const route = "/api/orgs/:id/projects/:pid";
    if (!requireCsrf(req, res, route)) return;
    const orgId = ctx.param("id");
    const guard = await requireOrgRole(req, res, orgId, "editor", route);
    if (!guard.ok) return;
    const project = await s.projects.get(ctx.param("pid"));
    if (!project || project.orgId !== orgId) return send(res, 404, { error: "no such project" });
    const at = Date.now();
    await trash.put({
      kind: "project",
      id: project.id,
      orgId,
      boardId: null,
      name: project.name,
      deletedBy: guard.user.id,
      deletedAt: at,
    });
    void auditRow(req, guard.user.id, orgId, "project.trashed", project.id, { name: project.name });
    send(res, 200, { trashed: project.id, purgeAt: at + TRASH_WINDOW_MS });
  });

  /** May this person bring this item back (or see it in the trash)? */
  const mayRestore = async (
    userId: string,
    orgId: string,
    orgRole: Role | undefined,
    item: { kind: "board" | TrashKind; boardId: string | null; ownerId?: string },
  ): Promise<boolean> => {
    if (orgRole === "owner") return true;
    if (item.kind === "board") return item.ownerId === userId;
    if (item.kind === "project") return orgRole !== undefined && roleAtLeast(orgRole, "editor");
    if (!item.boardId) return false;
    const role = await s.boardStore.memberRole(item.boardId, userId, (uid) =>
      s.orgRoleFor(uid, orgId),
    );
    return role !== undefined && roleAtLeast(role, "editor");
  };

  router.get("/api/orgs/:id/trash", async (ctx) => {
    const { req, res } = ctx;
    const orgId = ctx.param("id");
    const guard = await requireOrgRole(req, res, orgId, "viewer", "/api/orgs/:id/trash");
    if (!guard.ok) return;
    const names = new Map<string, string>();
    const nameOf = async (userId: string) => {
      if (!names.has(userId)) {
        const u = await s.userStore.findById(userId);
        names.set(userId, u?.name || u?.email || "someone");
      }
      return names.get(userId)!;
    };
    const items = [];
    for (const t of await s.boardStore.trashed(orgId)) {
      const item = { kind: "board" as const, boardId: t.board.id, ownerId: t.board.ownerId };
      if (!(await mayRestore(guard.user.id, orgId, guard.role, item))) continue;
      items.push({
        kind: "board",
        id: t.board.id,
        name: t.board.name,
        deletedBy: await nameOf(t.deletedBy),
        deletedAt: t.deletedAt,
        purgeAt: t.deletedAt + TRASH_WINDOW_MS,
      });
    }
    for (const t of await trash.forOrg(orgId)) {
      if (!(await mayRestore(guard.user.id, orgId, guard.role, t))) continue;
      const board = t.boardId ? await s.boardStore.get(t.boardId) : undefined;
      items.push({
        kind: t.kind,
        id: t.id,
        name: t.name,
        ...(board ? { boardId: board.id, boardName: board.name } : {}),
        deletedBy: await nameOf(t.deletedBy),
        deletedAt: t.deletedAt,
        purgeAt: t.deletedAt + TRASH_WINDOW_MS,
      });
    }
    items.sort((a, b) => b.deletedAt - a.deletedAt);
    send(res, 200, { items, days: TRASH_WINDOW_MS / 86_400_000 });
  });

  router.post("/api/orgs/:id/trash/restore", async (ctx) => {
    const { req, res } = ctx;
    const route = "/api/orgs/:id/trash/restore";
    if (!requireCsrf(req, res, route)) return;
    if (!meter(req, res, route)) return;
    const orgId = ctx.param("id");
    const user = await requireUser(req, res);
    if (!user) return;
    const guard = await requireOrgRole(req, res, orgId, "viewer", route);
    if (!guard.ok) return;
    let body: { kind?: unknown; id?: unknown };
    try {
      const raw = await readBody(req);
      body = raw ? (JSON.parse(raw) as typeof body) : {};
    } catch (err) {
      return send(res, 400, { error: "bad request", detail: (err as Error).message });
    }
    const id = typeof body.id === "string" ? body.id : "";
    if (body.kind === "board") {
      const t = (await s.boardStore.trashed(orgId)).find((x) => x.board.id === id);
      if (
        !t ||
        !(await mayRestore(user.id, orgId, guard.role, {
          kind: "board",
          boardId: id,
          ownerId: t.board.ownerId,
        }))
      ) {
        return send(res, 404, { error: "nothing like that in the trash" });
      }
      await s.boardStore.restore(id);
    } else if (body.kind === "meeting" || body.kind === "project") {
      const t = await trash.get(body.kind, id);
      if (!t || t.orgId !== orgId || !(await mayRestore(user.id, orgId, guard.role, t))) {
        return send(res, 404, { error: "nothing like that in the trash" });
      }
      await trash.remove(body.kind, id);
    } else {
      return send(res, 400, { error: "kind is board, meeting or project" });
    }
    void auditRow(req, user.id, orgId, `${String(body.kind)}.restored`, id);
    send(res, 200, { restored: id, kind: body.kind });
  });

  router.delete("/api/orgs/:id/trash/:kind/:itemId", async (ctx) => {
    const { req, res } = ctx;
    const route = "/api/orgs/:id/trash/:kind/:itemId";
    if (!requireCsrf(req, res, route)) return;
    const orgId = ctx.param("id");
    const guard = await requireOrgRole(req, res, orgId, "owner", route);
    if (!guard.ok) return;
    const kind = ctx.param("kind");
    const id = ctx.param("itemId");
    if (kind === "board") {
      if (!(await s.boardStore.trashed(orgId)).some((t) => t.board.id === id)) {
        return send(res, 404, { error: "nothing like that in the trash" });
      }
      await s.boardStore.delete(id);
    } else if (kind === "meeting" || kind === "project") {
      const t = await trash.get(kind, id);
      if (!t || t.orgId !== orgId)
        return send(res, 404, { error: "nothing like that in the trash" });
      if (kind === "meeting" && t.boardId) await s.meetings?.delete(t.boardId, id);
      if (kind === "project") await s.projects.delete(id);
      await trash.remove(kind, id);
    } else {
      return send(res, 400, { error: "kind is board, meeting or project" });
    }
    void auditRow(req, guard.user.id, orgId, `${kind}.purged`, id);
    send(res, 200, { purged: id, kind });
  });
};
