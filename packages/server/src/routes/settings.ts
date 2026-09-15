import type { RegisterRoutes } from "./context.js";
import { parseOrgSettings, effectiveSettings } from "../classification.js";
import type { OrgSettings } from "../classification.js";

/**
 * The org policy plane (docs/23 S2, docs/24 Phase B):
 *
 *   GET   /api/orgs/:id/settings   read the org's policy (owner)
 *   PATCH /api/orgs/:id/settings   set it (owner, CSRF, audited)
 *
 * Owner-floor on both reads and writes, and deliberately NOT on the generic
 * `/api/orgs/:id` read: members see the org's identity (name, roles) but the
 * policy surface is the admin console's, and Phase C's "every member sees
 * the setting" rides the provider-policy surface, not this one.
 *
 * The route writes NO new enforcement logic — enforcement lives in the
 * Phase A gates, which now read the org through `checkOutboundFor` /
 * `effectiveSettings`. This module does three things and nothing else:
 * validate the patch strictly (an unparseable key is a 400, never a stored
 * surprise), merge it over the stored settings (PATCH semantics: absent
 * means unchanged, and the permissive default only ever comes from absence
 * in storage, never from a successful write), and audit exactly the keys
 * that changed. Inheritance needs no code: the gates read the org at
 * decision time, so a policy set today governs a board created last year.
 */
export const registerOrgSettingsRoutes: RegisterRoutes = (router, s) => {
  const { send, readBody, requireCsrf, requireOrgRole, orgStore, requestOrigin } = s;

  router.get("/api/orgs/:id/settings", async (ctx) => {
    const { req, res } = ctx;
    const id = ctx.param("id");
    const guard = await requireOrgRole(req, res, id, "owner", "/api/orgs/:id/settings");
    if (!guard.ok) return;
    if (!orgStore) return send(res, 503, { error: "org store not configured" });
    const org = await orgStore.get(id);
    if (!org) {
      // The membership guard passed but the row is gone: a delete raced. Same
      // 404 shape the generic org read uses for that race.
      return send(res, 404, { error: "org not found" });
    }
    // Both shapes ride the response: what is STORED (the admin console edits
    // the record) and what is EFFECTIVE (what the gates enforce, defaults
    // resolved). A console that rendered only the raw record would show an
    // empty form for an org whose defaults someone typed into the database.
    send(res, 200, { settings: org.settings ?? {}, effective: effectiveSettings(org) });
  });

  router.patch("/api/orgs/:id/settings", async (ctx) => {
    const { req, res } = ctx;
    if (!requireCsrf(req, res, "/api/orgs/:id/settings")) return;
    const id = ctx.param("id");
    const guard = await requireOrgRole(req, res, id, "owner", "/api/orgs/:id/settings");
    if (!guard.ok) return;
    if (!orgStore) return send(res, 503, { error: "org store not configured" });

    let parsedBody: Record<string, unknown>;
    try {
      const raw = await readBody(req);
      parsedBody = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch (err) {
      send(res, 400, { error: "bad request", detail: (err as Error).message });
      return;
    }
    const parsed = parseOrgSettings(parsedBody);
    if (!parsed.ok) {
      // A strict 400, not a silent ignore: a typo in a policy key must not
      // land in storage as an uninterpretable field that `effectiveSettings`
      // then fails closed over. The user gets the name of what is wrong.
      send(res, 400, { error: parsed.error });
      return;
    }
    const org = await orgStore.get(id);
    if (!org) return send(res, 404, { error: "org not found" });

    const before = org.settings ?? {};
    const merged: OrgSettings = { ...before, ...parsed.settings };
    await orgStore.setSettings(id, merged);

    // Audit names the CHANGED KEYS with from→to (docs/24 §4 acceptance):
    // "who moved what, and to what" must be answerable from the trail alone
    // without diffing two full settings blobs. Compared on resolved values,
    // so setting a field to its already-effective default records no change.
    const effBefore = effectiveSettings({ settings: before });
    const effAfter = effectiveSettings({ settings: merged });
    const changed: Record<string, { from: unknown; to: unknown }> = {};
    for (const key of Object.keys(effAfter) as Array<keyof typeof effAfter>) {
      if (effBefore[key] !== effAfter[key]) {
        changed[key] = { from: effBefore[key], to: effAfter[key] };
      }
    }
    await orgStore
      .audit({
        orgId: id,
        actorId: guard.user.id,
        action: "org.settings",
        subject: id,
        ...requestOrigin(req),
        metadata: { changed, requested: parsed.settings },
        at: Date.now(),
      })
      .catch(() => {
        // Warn-and-continue, the audit contract everywhere else (orgs.ts):
        // a settings write that landed must not 500 because the trail failed.
      });

    send(res, 200, { settings: merged, effective: effAfter, changed });
  });
};
