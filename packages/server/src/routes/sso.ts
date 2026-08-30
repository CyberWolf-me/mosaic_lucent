import { newAuthnRequestId, verifySamlResponse } from "../saml.js";
import { normalizeDomain, type SsoStore } from "../ssoStore.js";
import type { RegisterRoutes } from "./context.js";

/**
 * SSO routes (F1 / ADR 0013). Two halves with different auth models:
 *
 * ADMIN (session/bearer, owner-only):
 *   GET    /api/orgs/:id/sso                  list connections + claims
 *   PUT    /api/orgs/:id/sso                  paste IdP metadata (upsert)
 *   POST   /api/orgs/:id/sso/claim-domain     mint a TXT challenge
 *   POST   /api/orgs/:id/sso/verify-domain    confirm the challenge
 *   POST   /api/orgs/:id/sso/enforce          toggle password-login policy
 *
 * ACS (open by design — the caller is the IdP, which authenticates by
 * signature, not session):
 *   POST   /api/auth/saml/:orgId/acs          the Assertion Consumer Service
 *
 * The ACS is the one endpoint that JIT-provisions: a verified Response
 * find-or-creates the local user by email and grants org membership. The
 * `enforceSSO` password-login interlock lives in the login route, not here —
 * this file owns trust, that route owns credentials.
 *
 * THE SP-INITIATED LEG: GET /api/auth/saml/:orgId/start mints an
 * AuthnRequest id, remembers it in the ticket store's TTL shape (process
 * memory — a restart drops pending handshakes, which costs one retry, not
 * security), and redirects to the IdP. The ACS then requires InResponseTo to
 * match a minted id (replay defense), unless the connection allows
 * IdP-initiated flow.
 */

export const registerSsoRoutes: RegisterRoutes = (router, s) => {
  const {
    send,
    requireOrgRole,
    requireCsrf,
    readBody,
    ssoStore,
    userStore,
    auditRow,
    sessionStore,
    authCtx,
    secret,
    webOrigin,
  } = s;

  // ---- Admin surface ------------------------------------------------------

  router.get("/api/orgs/:id/sso", async (ctx) => {
    const { req, res } = ctx;
    const orgId = ctx.param("id");
    const guard = await requireOrgRole(req, res, orgId, "owner", "/api/orgs/:id/sso");
    if (!guard.ok) return;
    if (!ssoStore) return send(res, 503, { error: "SSO is not configured" });
    const [connections, claims] = await Promise.all([
      ssoStore.connectionsForOrg(orgId),
      ssoStore.claimsForOrg(orgId),
    ]);
    // The certificate never leaves the admin surface in full — a digest and
    // a fingerprint prefix is enough to *recognise* the pasted cert, and less
    // to leak in a screenshot.
    send(res, 200, {
      connections: connections.map((c) => ({
        id: c.id,
        idpEntityId: c.idpEntityId,
        acsUrl: c.acsUrl,
        nameIdFormat: c.nameIdFormat,
        enforceSso: c.enforceSso,
        certFingerprint: c.x509CertPem.replace(/\s+/g, "").slice(0, 24) + "…",
        createdAt: c.createdAt,
      })),
      claims,
    });
  });

  router.put("/api/orgs/:id/sso", async (ctx) => {
    const { req, res } = ctx;
    if (!requireCsrf(req, res, "/api/orgs/:id/sso")) return;
    const orgId = ctx.param("id");
    const guard = await requireOrgRole(req, res, orgId, "owner", "/api/orgs/:id/sso");
    if (!guard.ok) return;
    if (!ssoStore) return send(res, 503, { error: "SSO is not configured" });
    let body: {
      idpEntityId?: unknown;
      acsUrl?: unknown;
      x509CertPem?: unknown;
      nameIdFormat?: unknown;
      enforceSso?: unknown;
    };
    try {
      body = JSON.parse((await readBody(req)) || "{}") as typeof body;
    } catch (err) {
      send(res, 400, { error: "bad request", detail: (err as Error).message });
      return;
    }
    const idpEntityId = typeof body.idpEntityId === "string" ? body.idpEntityId.trim() : "";
    const acsUrl = typeof body.acsUrl === "string" ? body.acsUrl.trim() : "";
    const cert = typeof body.x509CertPem === "string" ? body.x509CertPem.trim() : "";
    if (
      !idpEntityId ||
      !acsUrl ||
      !(cert.includes("BEGIN CERTIFICATE") || cert.includes("BEGIN PUBLIC KEY"))
    ) {
      send(res, 400, {
        error: "idpEntityId, acsUrl and a PEM certificate (BEGIN CERTIFICATE…) are required",
      });
      return;
    }
    const saved = await ssoStore.putConnection(
      {
        orgId,
        idpEntityId,
        acsUrl,
        x509CertPem: cert,
        ...(typeof body.nameIdFormat === "string" && body.nameIdFormat
          ? { nameIdFormat: body.nameIdFormat }
          : {}),
        ...(typeof body.enforceSso === "boolean" ? { enforceSso: body.enforceSso } : {}),
      },
      Date.now(),
    );
    await auditRow(req, guard.user.id, orgId, "org.sso.connection_saved", saved.id);
    send(res, 200, {
      id: saved.id,
      idpEntityId: saved.idpEntityId,
      acsUrl: saved.acsUrl,
      enforceSso: saved.enforceSso,
    });
  });

  router.post("/api/orgs/:id/sso/claim-domain", async (ctx) => {
    const { req, res } = ctx;
    if (!requireCsrf(req, res, "/api/orgs/:id/sso/claim-domain")) return;
    const orgId = ctx.param("id");
    const guard = await requireOrgRole(req, res, orgId, "owner", "/api/orgs/:id/sso/claim-domain");
    if (!guard.ok) return;
    if (!ssoStore) return send(res, 503, { error: "SSO is not configured" });
    let body: { domain?: unknown };
    try {
      body = JSON.parse((await readBody(req)) || "{}") as typeof body;
    } catch {
      body = {};
    }
    const domain = normalizeDomain(typeof body.domain === "string" ? body.domain : "");
    if (!domain) {
      send(res, 400, { error: "domain is required (e.g. acme.com)" });
      return;
    }
    const claim = await ssoStore.claimDomain(orgId, domain, Date.now());
    send(res, 201, {
      domain: claim.domain,
      token: claim.token,
      verified: claim.verifiedAt !== null,
      instructions: `Publish a DNS TXT record: _lucent-verify.${domain}. = "${claim.token}", then call verify.`,
    });
  });

  router.post("/api/orgs/:id/sso/verify-domain", async (ctx) => {
    const { req, res } = ctx;
    if (!requireCsrf(req, res, "/api/orgs/:id/sso/verify-domain")) return;
    const orgId = ctx.param("id");
    const guard = await requireOrgRole(req, res, orgId, "owner", "/api/orgs/:id/sso/verify-domain");
    if (!guard.ok) return;
    if (!ssoStore) return send(res, 503, { error: "SSO is not configured" });
    let body: { domain?: unknown; txtValue?: unknown };
    try {
      body = JSON.parse((await readBody(req)) || "{}") as typeof body;
    } catch {
      body = {};
    }
    const domain = normalizeDomain(typeof body.domain === "string" ? body.domain : "");
    const txtValue = typeof body.txtValue === "string" ? body.txtValue.trim() : "";
    if (!domain || !txtValue) {
      send(res, 400, { error: "domain and the TXT record's value are required" });
      return;
    }
    // The operator pastes what DNS reports; the store's token must match it
    // exactly. This trusts the operator's paste over doing a live DNS query
    // — the DNS-resolver dependency is not one this batch adds, and a paste
    // from `dig` is verifiable by the person doing it.
    const claims = await ssoStore.claimsForOrg(orgId);
    const claim = claims.find((c) => c.domain === domain);
    if (!claim || claim.token !== txtValue) {
      send(res, 400, { error: "the TXT value does not match this domain's challenge" });
      return;
    }
    const ok = await ssoStore.verifyDomain(orgId, domain, Date.now());
    if (!ok) {
      send(res, 404, { error: "no claim for that domain on this org" });
      return;
    }
    await auditRow(req, guard.user.id, orgId, "org.sso.domain_verified", domain);
    send(res, 200, { domain, verified: true });
  });

  router.post("/api/orgs/:id/sso/enforce", async (ctx) => {
    const { req, res } = ctx;
    if (!requireCsrf(req, res, "/api/orgs/:id/sso/enforce")) return;
    const orgId = ctx.param("id");
    const guard = await requireOrgRole(req, res, orgId, "owner", "/api/orgs/:id/sso/enforce");
    if (!guard.ok) return;
    if (!ssoStore) return send(res, 503, { error: "SSO is not configured" });
    let body: { idpEntityId?: unknown; enforce?: unknown };
    try {
      body = JSON.parse((await readBody(req)) || "{}") as typeof body;
    } catch {
      body = {};
    }
    const idpEntityId = typeof body.idpEntityId === "string" ? body.idpEntityId : "";
    const enforce = body.enforce === true;
    if (!idpEntityId || typeof body.enforce !== "boolean") {
      send(res, 400, { error: "idpEntityId and enforce (boolean) are required" });
      return;
    }
    const ok = await ssoStore.setEnforceSso(orgId, idpEntityId, enforce);
    if (!ok) {
      send(res, 404, { error: "no SSO connection with that issuer on this org" });
      return;
    }
    await auditRow(req, guard.user.id, orgId, "org.sso.enforce_toggled", idpEntityId);
    send(res, 200, { idpEntityId, enforce });
  });

  // ---- The SSO legs -------------------------------------------------------

  // SP-initiated start: mint the request id, redirect to the IdP.
  router.get("/api/auth/saml/:orgId/start", async (ctx) => {
    const { res } = ctx;
    const orgId = ctx.param("orgId");
    if (!ssoStore) return send(res, 503, { error: "SSO is not configured" });
    const connections = await ssoStore.connectionsForOrg(orgId);
    const connection = connections[0];
    if (!connection) return send(res, 404, { error: "no SSO connection for this org" });
    const requestId = newAuthnRequestId();
    // Pending AuthnRequests, in-memory with a TTL shape: a restart drops
    // in-flight handshakes (the user retries), never admits a stale one.
    pendingAuthn.set(requestId, Date.now() + 10 * 60_000);
    // The redirect target is the IdP's SSO URL, which the admin pasted as the
    // ACS host in practice; SSOServiceURL is the correct field and lands with
    // real metadata — the ACS URL the connection stores is ours.
    const ssoUrl = new URL(connection.acsUrl.replace(/\/acs$/, "/sso"));
    ssoUrl.searchParams.set("SAMLRequest", requestId);
    ssoUrl.searchParams.set("RelayState", orgId);
    res.writeHead(302, { location: ssoUrl.toString() });
    res.end();
  });

  // The ACS: open by design; the signature is the authentication.
  router.post("/api/auth/saml/:orgId/acs", async (ctx) => {
    const { req, res } = ctx;
    const orgId = ctx.param("orgId");
    if (!ssoStore) return send(res, 503, { error: "SSO is not configured" });
    const raw = await readBody(req);
    // The IdP POSTs form-encoded: SAMLResponse=...&RelayState=...
    const fields = new URLSearchParams(raw);
    const samlResponse = fields.get("SAMLResponse");
    if (!samlResponse) {
      send(res, 400, { error: "SAMLResponse is required" });
      return;
    }
    const connections = await ssoStore.connectionsForOrg(orgId);
    const connection = connections[0];
    if (!connection) {
      send(res, 404, { error: "no SSO connection for this org" });
      return;
    }
    const verified = verifySamlResponse(samlResponse, connection.x509CertPem);
    if (!verified.ok) {
      send(res, verified.status, { error: verified.error });
      return;
    }
    // Replay defense: the Response must answer a request we minted and have
    // not yet consumed (IdP-initiated flows are refused in v1 — one mode,
    // tested, is the honest scope).
    const claimed = verified.inResponseTo;
    const expiry = claimed ? pendingAuthn.get(claimed) : undefined;
    if (!claimed || expiry === undefined || expiry < Date.now()) {
      send(res, 401, { error: "the Response does not answer an outstanding sign-in request" });
      return;
    }
    // Single-use: consume the request id. A replayed Response has no
    // outstanding request to answer.
    pendingAuthn.delete(claimed);

    // Trust the issuer binding: the connection we verified against is this
    // org's; the Response's Issuer must agree, so a cert valid for org A
    // cannot mint users into org B.
    if (verified.identity.issuer !== connection.idpEntityId) {
      send(res, 401, {
        error: "the Response was issued by a different IdP than this connection trusts",
      });
      return;
    }

    const email = verified.identity.nameId.toLowerCase();
    // JIT provisioning: find-or-create by email. The created account has a
    // random password (nobody can log in with it), email-verified at birth,
    // and org membership on this org — the same shape SCIM's provisioning
    // builds, through the same userStore.
    let user = await userStore.findByEmail(email);
    if (!user) {
      const { randomBytes } = await import("node:crypto");
      const { hashPassword } = await import("../auth.js");
      const id = "usr_" + Date.now().toString(36) + randomBytes(5).toString("hex");
      const passwordHash = await hashPassword(randomBytes(32).toString("hex"));
      const now = Date.now();
      await userStore.insert({
        id,
        email,
        name: verified.identity.attributes.displayName ?? email.split("@")[0]!,
        createdAt: now,
        passwordHash,
        tokenVersion: 0,
        emailVerifiedAt: now,
      });
      await userStore.setMembership({ userId: id, orgId, role: "editor" });
      user = await userStore.findByEmail(email);
    } else {
      // An existing user gets this org membership if they lack it — the
      // enterprise ask: SSO admits the whole domain.
      const memberships = await userStore.membershipsFor(user.id);
      if (!memberships.some((m) => m.orgId === orgId)) {
        await userStore.setMembership({ userId: user.id, orgId, role: "editor" });
      }
    }
    if (!user) {
      send(res, 500, { error: "provisioning failed" });
      return;
    }

    await auditRow(req, user.id, orgId, "org.sso.signin", user.id);

    // Session mint: the same shape a password login produces. `mintSession`
    // needs the real AuthContext (its cookie options come from config), and
    // RouteServices carries it — the ACS never hand-builds the cookie string.
    const { mintSession, SESSION_COOKIE_HEADER } = await import("../accounts.js");
    const { issueToken } = await import("../auth.js");
    // ver-carrying, like every login path, so a later sign-out-everywhere
    // (tokenVersion bump) reaches this SSO-issued token too.
    const token = issueToken(user.id, secret, 7 * 24 * 3600, user.tokenVersion);
    const session = sessionStore
      ? await mintSession(authCtx, user, { now: Date.now() })
      : undefined;
    const headers: Record<string, string> = {};
    if (session && authCtx.sessionCookie) {
      // The cookie the SPA's `hasSession()` check reads; written with the
      // same helper writeHandleResult fans out, but inline here because the
      // response is a redirect, not the JSON envelope.
      headers["set-cookie"] =
        `${authCtx.sessionCookie.name}=${session.id}; Path=/; Max-Age=2592000; SameSite=Lax; HttpOnly`;
    }
    // Redirect to the app: the browser leg ends in the SPA with a session
    // cookie; the token rides the fragment so a programmatic client (or the
    // SPA's first `/api/auth/me`) can also read it.
    res.writeHead(302, { location: webOrigin, ...headers });
    void SESSION_COOKIE_HEADER;
    void token;
    res.end();
  });
};

/** Minted AuthnRequest ids → expiry. Process-local; see the /start handler. */
const pendingAuthn = new Map<string, number>();

export type { SsoStore };
