import type { RegisterRoutes } from "./context.js";
import { MAX_TEAM_NAME, TEAM_ROLES, newTeamId, type TeamRole } from "../teams.js";

/**
 * Teams (docs/26 A6):
 *
 *   GET    /api/orgs/:id/teams                         the org's teams and members (any member)
 *   POST   /api/orgs/:id/teams                         create (owner)
 *   PATCH  /api/orgs/:id/teams/:teamId                 rename (owner)
 *   DELETE /api/orgs/:id/teams/:teamId                 delete, with its board grants (owner)
 *   PUT    /api/orgs/:id/teams/:teamId/members/:userId add a member of the org (owner)
 *   DELETE /api/orgs/:id/teams/:teamId/members/:userId remove (owner)
 *
 *   GET    /api/boards/:id/teams                       teams with access to the board (viewer)
 *   PUT    /api/boards/:id/teams/:teamId               give a team a role on it (board owner)
 *   DELETE /api/boards/:id/teams/:teamId               take it away (board owner)
 *
 * A team an identity provider manages (SCIM Groups) is changed there, not
 * here: its name and members answer 409 to edits. Its board grants are
 * Lucent's to decide.
 */
export const registerTeamRoutes: RegisterRoutes = (router, s) => {
  const { send, readBody, requireCsrf, requireOrgRole, requireBoardRole, meter, auditRow } = s;
  const teams = s.teams;

  const json = async (req: import("node:http").IncomingMessage) => {
    const raw = await readBody(req);
    return (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
  };
  const managed = (team: { externalId: string | null }) => team.externalId !== null;

  router.get("/api/orgs/:id/teams", async (ctx) => {
    const { req, res } = ctx;
    const orgId = ctx.param("id");
    const guard = await requireOrgRole(req, res, orgId, "viewer", "/api/orgs/:id/teams");
    if (!guard.ok) return;
    const out = [];
    for (const team of await teams.list(orgId)) {
      const members = [];
      for (const userId of await teams.members(team.id)) {
        const u = await s.userStore.findById(userId);
        members.push({ userId, name: u?.name ?? "(removed)", email: u?.email ?? "" });
      }
      out.push({ id: team.id, name: team.name, managed: managed(team), members });
    }
    send(res, 200, { teams: out });
  });

  router.post("/api/orgs/:id/teams", async (ctx) => {
    const { req, res } = ctx;
    const route = "/api/orgs/:id/teams";
    if (!requireCsrf(req, res, route)) return;
    if (!meter(req, res, route)) return;
    const orgId = ctx.param("id");
    const guard = await requireOrgRole(req, res, orgId, "owner", route);
    if (!guard.ok) return;
    let body: Record<string, unknown>;
    try {
      body = await json(req);
    } catch (err) {
      return send(res, 400, { error: "bad request", detail: (err as Error).message });
    }
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > MAX_TEAM_NAME) {
      return send(res, 400, { error: `a team needs a name (1–${MAX_TEAM_NAME} characters)` });
    }
    if ((await teams.list(orgId)).some((t) => t.name.toLowerCase() === name.toLowerCase())) {
      return send(res, 409, { error: `there's already a team called "${name}"` });
    }
    const team = { id: newTeamId(), orgId, name, createdAt: Date.now(), externalId: null };
    await teams.create(team);
    void auditRow(req, guard.user.id, orgId, "team.created", team.id, { name });
    send(res, 201, { id: team.id, name, managed: false, members: [] });
  });

  router.patch("/api/orgs/:id/teams/:teamId", async (ctx) => {
    const { req, res } = ctx;
    const route = "/api/orgs/:id/teams/:teamId";
    if (!requireCsrf(req, res, route)) return;
    const orgId = ctx.param("id");
    const guard = await requireOrgRole(req, res, orgId, "owner", route);
    if (!guard.ok) return;
    const team = await teams.get(orgId, ctx.param("teamId"));
    if (!team) return send(res, 404, { error: "no such team" });
    if (managed(team)) return send(res, 409, { error: "your identity provider manages this team" });
    let body: Record<string, unknown>;
    try {
      body = await json(req);
    } catch (err) {
      return send(res, 400, { error: "bad request", detail: (err as Error).message });
    }
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > MAX_TEAM_NAME) {
      return send(res, 400, { error: `a team needs a name (1–${MAX_TEAM_NAME} characters)` });
    }
    await teams.rename(orgId, team.id, name);
    void auditRow(req, guard.user.id, orgId, "team.renamed", team.id, {
      from: team.name,
      to: name,
    });
    send(res, 200, { id: team.id, name });
  });

  router.delete("/api/orgs/:id/teams/:teamId", async (ctx) => {
    const { req, res } = ctx;
    const route = "/api/orgs/:id/teams/:teamId";
    if (!requireCsrf(req, res, route)) return;
    const orgId = ctx.param("id");
    const guard = await requireOrgRole(req, res, orgId, "owner", route);
    if (!guard.ok) return;
    const team = await teams.get(orgId, ctx.param("teamId"));
    if (!team) return send(res, 404, { error: "no such team" });
    if (managed(team)) return send(res, 409, { error: "your identity provider manages this team" });
    await teams.delete(orgId, team.id);
    void auditRow(req, guard.user.id, orgId, "team.deleted", team.id, { name: team.name });
    send(res, 200, { deleted: team.id });
  });

  const memberRoute = "/api/orgs/:id/teams/:teamId/members/:userId";
  const changeMember =
    (add: boolean) => async (ctx: Parameters<Parameters<typeof router.put>[1]>[0]) => {
      const { req, res } = ctx;
      if (!requireCsrf(req, res, memberRoute)) return;
      const orgId = ctx.param("id");
      const guard = await requireOrgRole(req, res, orgId, "owner", memberRoute);
      if (!guard.ok) return;
      const team = await teams.get(orgId, ctx.param("teamId"));
      if (!team) return send(res, 404, { error: "no such team" });
      if (managed(team)) {
        return send(res, 409, { error: "your identity provider manages this team" });
      }
      const userId = ctx.param("userId");
      if (add) {
        // Teams hold members: a guest is never lifted by a team.
        if (!(await s.orgRoleFor(userId, orgId))) {
          return send(res, 404, { error: "not a member of this workspace" });
        }
        await teams.addMember(team.id, userId);
      } else {
        await teams.removeMember(team.id, userId);
      }
      void auditRow(
        req,
        guard.user.id,
        orgId,
        add ? "team.member.added" : "team.member.removed",
        team.id,
        {
          userId,
        },
      );
      send(res, 200, { teamId: team.id, userId, member: add });
    };
  router.put(memberRoute, changeMember(true));
  router.delete(memberRoute, changeMember(false));

  router.get("/api/boards/:id/teams", async (ctx) => {
    const { req, res } = ctx;
    const boardId = ctx.param("id");
    const guard = await requireBoardRole(req, res, boardId, "viewer", "/api/boards/:id/teams");
    if (!guard.ok) return;
    const byId = new Map((await teams.list(guard.board.orgId)).map((t) => [t.id, t] as const));
    const grants = [];
    for (const grant of await teams.grants(boardId)) {
      const team = byId.get(grant.teamId);
      if (!team) continue;
      grants.push({
        teamId: team.id,
        name: team.name,
        role: grant.role,
        members: (await teams.members(team.id)).length,
      });
    }
    // The board's owner chooses from the workspace's teams; nobody else (a
    // guest reads this route too) learns their names.
    send(res, 200, {
      teams: grants,
      ...(guard.role === "owner"
        ? { available: [...byId.values()].map((t) => ({ teamId: t.id, name: t.name })) }
        : {}),
    });
  });

  const grantRoute = "/api/boards/:id/teams/:teamId";
  router.put(grantRoute, async (ctx) => {
    const { req, res } = ctx;
    if (!requireCsrf(req, res, grantRoute)) return;
    const boardId = ctx.param("id");
    const guard = await requireBoardRole(req, res, boardId, "owner", grantRoute);
    if (!guard.ok) return;
    const team = await teams.get(guard.board.orgId, ctx.param("teamId"));
    if (!team) return send(res, 404, { error: "no such team in this board's workspace" });
    let body: Record<string, unknown>;
    try {
      body = await json(req);
    } catch (err) {
      return send(res, 400, { error: "bad request", detail: (err as Error).message });
    }
    if (!(TEAM_ROLES as readonly unknown[]).includes(body.role)) {
      return send(res, 400, { error: `role must be one of: ${TEAM_ROLES.join(", ")}` });
    }
    const role = body.role as TeamRole;
    await teams.setGrant({ boardId, teamId: team.id, role });
    void auditRow(req, guard.user.id, guard.board.orgId, "board.team.granted", boardId, {
      teamId: team.id,
      role,
    });
    send(res, 200, { teamId: team.id, name: team.name, role });
  });

  router.delete(grantRoute, async (ctx) => {
    const { req, res } = ctx;
    if (!requireCsrf(req, res, grantRoute)) return;
    const boardId = ctx.param("id");
    const guard = await requireBoardRole(req, res, boardId, "owner", grantRoute);
    if (!guard.ok) return;
    const removed = await teams.removeGrant(boardId, ctx.param("teamId"));
    if (!removed) return send(res, 404, { error: "that team has no access here" });
    void auditRow(req, guard.user.id, guard.board.orgId, "board.team.removed", boardId, {
      teamId: ctx.param("teamId"),
    });
    send(res, 200, { removed: ctx.param("teamId") });
  });
};
