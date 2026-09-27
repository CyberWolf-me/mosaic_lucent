import { orgInviteEmail } from "../email/index.js";
import type { AppRouter, RouteServices } from "./context.js";

/**
 * Org invites (M2.4) and their redemption.
 *
 * Two halves that read as one flow but sit on opposite sides of the trust
 * boundary: the first three routes are owner-only administration of an org's
 * pending seats, and `/api/invites/accept` is a *bearer-capability* route --
 * anyone holding the raw token, from any org, authenticated as themselves.
 * That is why the accept handler resolves the org from the invite row and never
 * from the request.
 */
export function registerInviteRoutes(router: AppRouter, s: RouteServices): void {
  const {
    send,
    readBody,
    requireCsrf,
    requireUser,
    requireOrgRole,
    gateStanding,
    notifyUser,
    userStore,
    orgStore,
    inviteStore,
    authCtx,
    logger,
    auditRow,
  } = s;

  /**
   * Invite by email. Owner only.
   *
   * Always 204, even for an address that is not an email: the response must not
   * differ by whether the invitee has an account, or it becomes an oracle over
   * the user table for anyone who owns one org.
   */
  router.post("/api/orgs/:id/invites", async (ctx) => {
    const { req, res } = ctx;
    if (!requireCsrf(req, res, "/api/orgs/:id/invites")) return;
    const orgId = ctx.param("id");
    const guard = await requireOrgRole(req, res, orgId, "owner", "/api/orgs/:id/invites");
    if (!guard.ok) return;
    if (!inviteStore) return send(res, 503, { error: "invite store not configured" });
    try {
      const raw = await readBody(req);
      const body = raw ? (JSON.parse(raw) as { email?: unknown; role?: unknown }) : {};
      if (typeof body.email !== "string" || !body.email.includes("@")) {
        send(res, 204, {});
        return;
      }
      const role = body.role === "viewer" ? "viewer" : "editor";
      const email = body.email.toLowerCase().trim();
      const now = Date.now();
      // M4: the `seats` ceiling, counted as members plus live invites. An
      // invite is a seat already promised: without the pending half, an org one
      // seat from its limit could mail ten invites and only discover the ceiling
      // when the tenth person clicked -- turning a billing limit into ten
      // strangers being bounced from a workspace they were told to join.
      const pending = await inviteStore.listForOrg(orgId, now);
      const seatsUsed = (await userStore.countMembers(orgId)) + pending.length;
      if (!(await gateStanding(req, res, orgId, "seats", seatsUsed, "/api/orgs/:id/invites")))
        return;
      // Imported here rather than at module scope because the surrounding try is
      // the whole point: nothing in this route may reach the client except a 204
      // or the catch's 400.
      const { randomBytes, createHash } = await import("node:crypto");
      const raw2 = randomBytes(32).toString("base64url");
      const tokenHash = createHash("sha256").update(raw2).digest("hex");
      await inviteStore.create({
        orgId,
        email,
        role,
        tokenHash,
        invitedBy: guard.user.id,
        createdAt: now,
        expiresAt: now + 7 * 24 * 60 * 60 * 1000,
      });
      // docs/26 F9: who was invited into the org, at what role.
      void auditRow(req, guard.user.id, orgId, "org.invite.created", orgId, { email, role });
      // M2.6: an invite to an address that already has an account also lands
      // in that account's tray. The accept path rides along because the row is
      // readable only by the user it belongs to, so the card carries no
      // capability the invite mail does not already put in their inbox.
      const invitee = await userStore.findByEmail(email);
      const org = await orgStore?.get(orgId);
      const orgName = org?.name ?? "a Lucent workspace";
      const inviterName = guard.user.name || guard.user.email;
      if (invitee) {
        notifyUser({
          kind: "org.invited",
          to: { userId: invitee.id, email: invitee.email },
          orgId,
          payload: {
            orgName,
            inviterName,
            role,
            acceptPath: `/invite?token=${encodeURIComponent(raw2)}`,
          },
        });
      }
      // Through `orgInviteEmail` rather than a string built here. The
      // hand-rolled body had no HTML part, named neither the inviter nor the
      // workspace, and hard-coded the product name -- on the one mail a new
      // teammate ever receives from us. The console mailer still prints the
      // link, so dev and the fixtures see it exactly as before.
      //
      // A send failure no longer fails the request. It threw into this route's
      // catch and answered 400 *after* the invite row was committed, so the
      // caller was told the invite had failed while the invite existed and its
      // link worked -- and the owner's natural next move, inviting again,
      // mailed a second live token for the same seat. The row is the durable
      // half; the mail is one delivery of it and can be resent.
      if (authCtx.mailer && authCtx.siteOrigin) {
        const tpl = orgInviteEmail(
          { siteOrigin: authCtx.siteOrigin },
          { inviterName, orgName, token: raw2, role },
        );
        await authCtx.mailer
          .send({ to: email, subject: tpl.subject, text: tpl.text, html: tpl.html })
          .catch((err: unknown) => {
            logger.warn("org_invite_mail_failed", {
              orgId,
              message: err instanceof Error ? err.message : String(err),
            });
          });
      }
      send(res, 204, {});
    } catch (err) {
      send(res, 400, { error: "bad request", detail: (err as Error).message });
    }
  });

  /**
   * List live invites for an org. Owner only.
   *
   * An unconfigured store answers an empty list rather than 503: the switcher
   * renders this beside the member list, and a 503 there would break a screen
   * whose other half is fine.
   */
  router.get("/api/orgs/:id/invites", async (ctx) => {
    const { req, res } = ctx;
    const orgId = ctx.param("id");
    const guard = await requireOrgRole(req, res, orgId, "owner", "/api/orgs/:id/invites");
    if (!guard.ok) return;
    if (!inviteStore) return send(res, 200, { invites: [] });
    const invites = await inviteStore.listForOrg(orgId, Date.now());
    // The token hash never leaves the store. Only the fields an owner needs to
    // recognise a pending seat and revoke it.
    send(res, 200, {
      invites: invites.map((i) => ({
        id: i.id,
        email: i.email,
        role: i.role,
        createdAt: i.createdAt,
        expiresAt: i.expiresAt,
      })),
    });
  });

  /**
   * Revoke an invite. Owner only.
   *
   * The org guard is what scopes this: `revoke` takes an invite id alone, so
   * without it an owner of any org could revoke any invite whose id they
   * guessed. 204 either way -- a revoked or never-existent invite are the same
   * end state, and distinguishing them would enumerate ids.
   */
  router.delete("/api/orgs/:id/invites/:inviteId", async (ctx) => {
    const { req, res } = ctx;
    if (!requireCsrf(req, res, "/api/orgs/:id/invites/:inviteId")) return;
    const orgId = ctx.param("id");
    const inviteId = ctx.param("inviteId");
    const guard = await requireOrgRole(req, res, orgId, "owner", "/api/orgs/:id/invites/:inviteId");
    if (!guard.ok) return;
    if (!inviteStore) return send(res, 204, {});
    await inviteStore.revoke(inviteId, Date.now());
    void auditRow(req, guard.user.id, orgId, "org.invite.revoked", inviteId);
    send(res, 204, {});
  });

  /**
   * Redeem an invite. Cookie-or-bearer authenticated; adds the caller as a
   * member of the target org with the granted role.
   *
   * The token is the authorisation here -- there is no org in the path to guard,
   * and `findByRawToken` is what turns the capability into a scope.
   */
  router.post("/api/invites/accept", async (ctx) => {
    const { req, res } = ctx;
    if (!requireCsrf(req, res, "/api/invites/accept")) return;
    const user = await requireUser(req, res);
    if (!user) return;
    if (!inviteStore) return send(res, 503, { error: "invite store not configured" });
    try {
      const raw = await readBody(req);
      const body = raw ? (JSON.parse(raw) as { token?: unknown }) : {};
      if (typeof body.token !== "string") {
        send(res, 400, { error: "token required" });
        return;
      }
      const invite = await inviteStore.findByRawToken(body.token, Date.now());
      if (!invite) {
        send(res, 404, { error: "invite is not valid" });
        return;
      }
      // M4: the `seats` ceiling again, on the redeeming side -- the send-time
      // check cannot be the only one, since an org can fill up in the week an
      // invite stays live. Counted against members alone, not members plus
      // invites: this invite is one of those pending seats, and counting it
      // twice would refuse the last seat the org actually paid for.
      //
      // Skipped when the user already holds a row, so re-clicking an accept link
      // stays idempotent rather than 402-ing once the org is full.
      //
      // The refusal body is the org-facing one from entitlements.ts, and the
      // person reading it here cannot act on it. That is deliberate over the
      // alternative: `reason` and `key` are in the payload, so the client can
      // render "this workspace is full -- ask an owner to add a seat" and skip
      // the upgrade button, which is a copy decision, not a server one.
      const alreadyMember = (await userStore.membershipsFor(user.id)).some(
        (m) => m.orgId === invite.orgId,
      );
      if (!alreadyMember) {
        const seatsUsed = await userStore.countMembers(invite.orgId);
        const ok = await gateStanding(
          req,
          res,
          invite.orgId,
          "seats",
          seatsUsed,
          "/api/invites/accept",
        );
        if (!ok) return;
      }
      await s.memberships.set({ userId: user.id, orgId: invite.orgId, role: invite.role });
      await inviteStore.consume(invite.id, Date.now());
      void auditRow(req, user.id, invite.orgId, "org.member.joined_via_invite", invite.orgId, {
        role: invite.role,
        inviteId: invite.id,
      });
      // M2.6: tell whoever sent the invite that it was taken up. This is the
      // one notification the joiner does not get -- they are standing in front
      // of the result of their own click.
      const inviter = await userStore.findById(invite.invitedBy);
      if (inviter && inviter.id !== user.id) {
        const org = await orgStore?.get(invite.orgId);
        notifyUser({
          kind: "org.member_joined",
          to: { userId: inviter.id, email: inviter.email },
          orgId: invite.orgId,
          payload: {
            orgName: org?.name ?? "your workspace",
            memberName: user.name || user.email,
            orgId: invite.orgId,
          },
        });
      }
      send(res, 200, { orgId: invite.orgId, role: invite.role });
    } catch (err) {
      send(res, 400, { error: "bad request", detail: (err as Error).message });
    }
  });
}
