import type { RegisterRoutes } from "./context.js";

/**
 * Managing an org's members (docs/26 A6):
 *
 *   PATCH  /api/orgs/:id/members/:userId   change a member's role (owner)
 *   DELETE /api/orgs/:id/members/:userId   remove a member (owner), or leave (yourself)
 *
 * An org always keeps an owner: the last one can't be demoted or removed,
 * and can't leave. A personal workspace belongs to the person it was made
 * for — they can't be demoted or removed from it.
 *
 * Removing someone ends their access everywhere in the org at once: the
 * membership, every board they were given directly on the org's boards, and
 * any board they have open right now (their socket is detached, not left
 * committing under a role they no longer hold). Everything is audited.
 */

const ORG_ROLES = ["owner", "editor", "viewer"] as const;
type OrgRole = (typeof ORG_ROLES)[number];

export const registerOrgMemberRoutes: RegisterRoutes = (router, s) => {
  const { send, readBody, requireCsrf, requireUser, requireOrgRole, meter, auditRow } = s;

  /** The org's members, and whether removing or demoting this one leaves no owner. */
  const lastOwner = async (orgId: string, userId: string) => {
    const members = (await s.orgStore?.membersOf(orgId)) ?? [];
    const owners = members.filter((m) => m.role === "owner");
    return owners.length === 1 && owners[0]!.userId === userId;
  };
  const isFounder = (orgId: string, userId: string) => orgId === `org_personal_${userId}`;

  router.patch("/api/orgs/:id/members/:userId", async (ctx) => {
    const { req, res } = ctx;
    const route = "/api/orgs/:id/members/:userId";
    if (!requireCsrf(req, res, route)) return;
    if (!meter(req, res, route)) return;
    const orgId = ctx.param("id");
    const guard = await requireOrgRole(req, res, orgId, "owner", route);
    if (!guard.ok) return;
    const targetId = ctx.param("userId");
    let body: { role?: unknown };
    try {
      const raw = await readBody(req);
      body = raw ? (JSON.parse(raw) as typeof body) : {};
    } catch (err) {
      return send(res, 400, { error: "bad request", detail: (err as Error).message });
    }
    if (!(ORG_ROLES as readonly unknown[]).includes(body.role)) {
      return send(res, 400, { error: `role must be one of: ${ORG_ROLES.join(", ")}` });
    }
    const role = body.role as OrgRole;
    const current = await s.storedOrgRole(targetId, orgId);
    if (!current) return send(res, 404, { error: "not a member of this workspace" });
    if (current === role) return send(res, 200, { userId: targetId, role });
    if (current === "owner" && role !== "owner") {
      if (isFounder(orgId, targetId)) {
        return send(res, 409, { error: "a personal workspace stays its owner's" });
      }
      if (await lastOwner(orgId, targetId)) {
        return send(res, 409, {
          error: "a workspace needs an owner — make someone else owner first",
        });
      }
    }
    await s.memberships.set({ userId: targetId, orgId, role });
    void auditRow(req, guard.user.id, orgId, "org.member.role_changed", targetId, {
      from: current,
      to: role,
    });
    send(res, 200, { userId: targetId, role });
  });

  router.delete("/api/orgs/:id/members/:userId", async (ctx) => {
    const { req, res } = ctx;
    const route = "/api/orgs/:id/members/:userId";
    if (!requireCsrf(req, res, route)) return;
    if (!meter(req, res, route)) return;
    const orgId = ctx.param("id");
    const targetId = ctx.param("userId");
    const user = await requireUser(req, res);
    if (!user) return;
    const leaving = targetId === user.id;
    // Leaving needs only membership — as stored, so a workspace that requires
    // two-step verification can still be left (docs/26 A6). Removing someone
    // else needs ownership.
    if (!leaving) {
      const guard = await requireOrgRole(req, res, orgId, "owner", route);
      if (!guard.ok) return;
    }
    const current = await s.storedOrgRole(targetId, orgId);
    if (!current) return send(res, 404, { error: "not a member of this workspace" });
    if (isFounder(orgId, targetId)) {
      return send(res, 409, { error: "a personal workspace stays its owner's" });
    }
    if (current === "owner" && (await lastOwner(orgId, targetId))) {
      return send(res, 409, {
        error: leaving
          ? "you're the last owner — make someone else owner before you leave"
          : "a workspace needs an owner — make someone else owner first",
      });
    }

    await s.memberships.remove(orgId, targetId);
    await s.teams.removeUserFromOrg(orgId, targetId);
    // Their direct grants on the org's boards go too, and any board they have
    // open stops accepting their edits now.
    let boardsLost = 0;
    for (const board of await s.boardStore.listForOrg(orgId)) {
      const grant = (await s.boardStore.members(board.id)).find((m) => m.userId === targetId);
      if (grant) {
        await s.boardStore.removeMember(board.id, targetId);
        boardsLost += 1;
      }
      s.detachFromBoard(board.id, targetId);
    }
    void auditRow(
      req,
      user.id,
      orgId,
      leaving ? "org.member.left" : "org.member.removed",
      targetId,
      { role: current, boardGrantsRemoved: boardsLost },
    );
    send(res, 200, { removed: targetId, boardGrantsRemoved: boardsLost });
  });
};
