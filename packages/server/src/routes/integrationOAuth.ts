import type { RegisterRoutes } from "./context.js";
import { authenticate } from "../accounts.js";
import { bearerToken } from "../auth.js";
import {
  OAUTH_NAMES,
  OAUTH_REF,
  OAuthError,
  authorizeUrl,
  exchangeCode,
  isOAuthProvider,
  jiraSites,
  pkceVerifier,
  saveTokens,
  signState,
  verifyState,
  type OAuthProvider,
} from "../integrations/oauth.js";

/**
 * OAuth connect for Linear and Jira (docs/26 A5):
 *
 *   POST /api/orgs/:id/integrations/:provider/oauth    start (owner, CSRF) → { url }
 *   GET  /api/integrations/oauth/:provider/callback    the provider sends the owner back
 *
 * Start is a POST so it carries the CSRF check; it answers the provider's
 * authorize URL for the browser to open. The callback is the browser coming
 * back: it completes only for the person who started it (the signed state
 * names them), still an owner of that org, and ends on the admin page either
 * way — connected, or with the reason it didn't.
 */

/** What each provider needs from the owner before OAuth can finish. */
const REQUIRED: Record<OAuthProvider, string[]> = {
  linear: ["teamId"],
  jira: ["projectKey"],
};

export const registerIntegrationOAuthRoutes: RegisterRoutes = (router, s) => {
  const { send, readBody, requireCsrf, requireOrgRole, meter, config, secret, auditRow } = s;
  const redirectUri = (provider: string) =>
    `${config.webOrigin}/api/integrations/oauth/${provider}/callback`;

  router.post("/api/orgs/:id/integrations/:provider/oauth", async (ctx) => {
    const { req, res } = ctx;
    const route = "/api/orgs/:id/integrations/:provider/oauth";
    if (!requireCsrf(req, res, route)) return;
    if (!meter(req, res, route)) return;
    const orgId = ctx.param("id");
    const guard = await requireOrgRole(req, res, orgId, "owner", route);
    if (!guard.ok) return;
    const provider = ctx.param("provider");
    const oauth = s.integrations?.oauth;
    if (!isOAuthProvider(provider) || !oauth?.apps[provider]) {
      send(res, 404, { error: `${provider} can't be connected with OAuth on this server` });
      return;
    }
    let body: { config?: unknown };
    try {
      const raw = await readBody(req);
      body = raw ? (JSON.parse(raw) as typeof body) : {};
    } catch (err) {
      send(res, 400, { error: "bad request", detail: (err as Error).message });
      return;
    }
    const entered: Record<string, string> = {};
    if (body.config && typeof body.config === "object" && !Array.isArray(body.config)) {
      for (const [k, v] of Object.entries(body.config as Record<string, unknown>).slice(0, 10)) {
        if (typeof v === "string" && v.trim()) entered[k.slice(0, 60)] = v.trim().slice(0, 200);
      }
    }
    const missing = REQUIRED[provider].filter((k) => !entered[k]);
    if (missing.length > 0) {
      send(res, 400, { error: `fill in ${missing.join(", ")} first` });
      return;
    }
    const { token, state } = signState(
      secret,
      { o: orgId, u: guard.user.id, p: provider, c: entered },
      Date.now(),
    );
    send(res, 200, {
      url: authorizeUrl(
        oauth,
        provider,
        redirectUri(provider),
        token,
        pkceVerifier(secret, state.n),
      ),
    });
  });

  router.get("/api/integrations/oauth/:provider/callback", async (ctx) => {
    const { req, res } = ctx;
    const provider = ctx.param("provider");
    const url = new URL(req.url ?? "/", "http://callback.local");
    const back = (outcome: "connected" | "error", reason?: string) => {
      const target = new URL("/", config.webOrigin);
      target.searchParams.set("view", "admin");
      target.searchParams.set("integration", provider);
      target.searchParams.set("oauth", outcome);
      if (reason) target.searchParams.set("reason", reason.slice(0, 200));
      res.writeHead(302, { location: target.toString(), "cache-control": "no-store" });
      res.end();
    };
    const oauth = s.integrations?.oauth;
    if (!isOAuthProvider(provider) || !oauth?.apps[provider] || !s.integrations) {
      return back("error", "OAuth isn't set up for this provider on this server");
    }
    const state = verifyState(secret, url.searchParams.get("state") ?? "", Date.now());
    if (!state || state.p !== provider) {
      return back("error", "The sign-in link expired or was changed. Start again.");
    }
    if (url.searchParams.get("error")) {
      return back(
        "error",
        `${OAUTH_NAMES[provider]} didn't allow it (${url.searchParams.get("error")})`,
      );
    }
    // The person who started it, signed in here, still an owner of the org.
    const user = await authenticate(
      s.authCtx,
      req.headers.cookie ?? null,
      bearerToken(req.headers.authorization),
    );
    if (!user || user.id !== state.u || (await s.orgRoleFor(user.id, state.o)) !== "owner") {
      return back("error", "Finish connecting while signed in as the owner who started it.");
    }
    const code = url.searchParams.get("code");
    if (!code) return back("error", "The provider sent no authorization code.");

    try {
      const tokens = await exchangeCode(
        oauth,
        provider,
        code,
        redirectUri(provider),
        pkceVerifier(secret, state.n),
      );
      const connectionConfig: Record<string, string> = { ...state.c };
      if (provider === "jira") {
        // Which Jira site: the one the owner named, or the only one there is.
        const sites = await jiraSites(oauth, tokens.accessToken);
        const wanted = state.c.site?.replace(/\/$/, "").toLowerCase();
        const site = wanted
          ? sites.find((x) => x.url.replace(/\/$/, "").toLowerCase() === wanted)
          : sites.length === 1
            ? sites[0]
            : undefined;
        if (!site) {
          return back(
            "error",
            sites.length === 0
              ? "That Atlassian account can't reach any Jira site."
              : "That account reaches several Jira sites — name the one to use.",
          );
        }
        connectionConfig.site = site.url;
        connectionConfig.cloudId = site.id;
      }
      await saveTokens(oauth, state.o, provider, tokens, user.id);
      await s.integrations.store.putConnection(
        {
          orgId: state.o,
          provider,
          credentialRef: OAUTH_REF,
          viaOAuth: true,
          config: connectionConfig,
          createdBy: user.id,
        },
        Date.now(),
      );
      await s.integrations.store.recordCall(state.o, provider, { ok: true }, Date.now());
      void auditRow(req, user.id, state.o, "integration.connected", provider, {
        provider,
        via: "oauth",
      });
      return back("connected");
    } catch (err) {
      const message =
        err instanceof OAuthError ? err.message : "Couldn't finish connecting. Try again.";
      return back("error", message);
    }
  });
};
