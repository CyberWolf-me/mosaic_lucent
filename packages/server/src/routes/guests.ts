import type { RegisterRoutes } from "./context.js";

/**
 * Guests (docs/26 A6): people outside a workspace who were given one or
 * more of its boards — through a share link, or by email. A guest holds
 * board grants and no membership, so every workspace-wide read (projects,
 * intelligence, search, the member list) already refuses them; these routes
 * make them visible and manageable:
 *
 *   GET    /api/boards/shared-with-me        boards in other workspaces you were given
 *   GET    /api/orgs/:id/guests              who's in this workspace as a guest (owner)
 *   DELETE /api/orgs/:id/guests/:userId      end a guest's access to every board here (owner)
 */
export const registerGuestRoutes: RegisterRoutes = (router, s) => {
  const { send, requireCsrf, requireUser, requireOrgRole, meter, auditRow } = s;

  /** Is this person a member of the org (as opposed to a guest in it)? */
  const isMember = async (userId: string, orgId: string) =>
    (await s.storedOrgRole(userId, orgId)) !== undefined;

  router.get("/api/boards/shared-with-me", async (ctx) => {
    const { req, res } = ctx;
    const user = await requireUser(req, res);
    if (!user) return;
    const granted = await s.boardStore.listGrantedTo(user.id);
    const orgNames = new Map<string, string>();
    const boards = [];
    for (const { board, role } of granted) {
      // A board in your own workspace is in your workspace, not "shared".
      if (await isMember(user.id, board.orgId)) continue;
      // A workspace that's closed to you right now (docs/26 A6) lists nothing.
      if (await s.access.blocked(user.id, board.orgId)) continue;
      if (!orgNames.has(board.orgId)) {
        orgNames.set(
          board.orgId,
          (await s.orgStore?.get(board.orgId))?.name ?? "Another workspace",
        );
      }
      boards.push({
        id: board.id,
        name: board.name,
        orgId: board.orgId,
        orgName: orgNames.get(board.orgId)!,
        role,
        updatedAt: board.updatedAt,
        nodes: Object.keys(board.workspace.nodes).length,
      });
    }
    send(res, 200, { boards });
  });

  router.get("/api/orgs/:id/guests", async (ctx) => {
    const { req, res } = ctx;
    const orgId = ctx.param("id");
    const guard = await requireOrgRole(req, res, orgId, "owner", "/api/orgs/:id/guests");
    if (!guard.ok) return;
    const guests = new Map<
      string,
      {
        userId: string;
        name: string;
        email: string;
        boards: Array<{ id: string; name: string; role: string }>;
      }
    >();
    for (const board of await s.boardStore.listForOrg(orgId)) {
      for (const member of await s.boardStore.members(board.id)) {
        if (await isMember(member.userId, orgId)) continue;
        let guest = guests.get(member.userId);
        if (!guest) {
          const u = await s.userStore.findById(member.userId);
          guest = {
            userId: member.userId,
            name: u?.name ?? "(removed)",
            email: u?.email ?? "",
            boards: [],
          };
          guests.set(member.userId, guest);
        }
        guest.boards.push({ id: board.id, name: board.name, role: member.role });
      }
    }
    send(res, 200, { guests: [...guests.values()] });
  });

  router.delete("/api/orgs/:id/guests/:userId", async (ctx) => {
    const { req, res } = ctx;
    const route = "/api/orgs/:id/guests/:userId";
    if (!requireCsrf(req, res, route)) return;
    if (!meter(req, res, route)) return;
    const orgId = ctx.param("id");
    const guard = await requireOrgRole(req, res, orgId, "owner", route);
    if (!guard.ok) return;
    const targetId = ctx.param("userId");
    if (await isMember(targetId, orgId)) {
      return send(res, 409, { error: "they're a member here — remove them from Members instead" });
    }
    let removed = 0;
    for (const board of await s.boardStore.listForOrg(orgId)) {
      if ((await s.boardStore.members(board.id)).some((m) => m.userId === targetId)) {
        await s.boardStore.removeMember(board.id, targetId);
        s.detachFromBoard(board.id, targetId);
        removed += 1;
      }
    }
    if (removed === 0) return send(res, 404, { error: "not a guest here" });
    void auditRow(req, guard.user.id, orgId, "org.guest.removed", targetId, { boards: removed });
    send(res, 200, { removed: targetId, boards: removed });
  });
};
