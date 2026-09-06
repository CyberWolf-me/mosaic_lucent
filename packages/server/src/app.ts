import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { LLMProvider, ImageProvider } from "@lucent/ai";
import { handleGenerate, handleGenerateStream } from "./generate.js";
import { readByoHeaders, resolveProvider } from "./modelRouter.js";
import { handleImage } from "./image.js";
import type { UsageTracker, UsageLimits } from "./usage.js";
import type { Telemetry, TelemetryEvent } from "./telemetry.js";
import {
  authenticate,
  handleAccountExport,
  handleBeginTotpEnrollment,
  handleCancelDeletion,
  handleConfirmTotpEnrollment,
  handleDisableTotp,
  handleListSessions,
  handleLogin,
  handleLogout,
  handleMe,
  handleRequestPasswordReset,
  handleRequestVerification,
  handleResetPassword,
  handleRevokeSession,
  handleScheduleDeletion,
  handleSignoutAll,
  handleSignup,
  handleUpdateProfile,
  handleVerifyEmail,
  handleVerifyTwoFactorLogin,
  mintSession,
  SESSION_COOKIE_HEADER,
  type AuthContext,
  type UserStore,
} from "./accounts.js";
import { bearerToken, verifyToken } from "./auth.js";
import { clearCookie, getCookie, parseCookies, serializeCookie } from "./cookies.js";
import {
  authorizationUrl,
  exchangeCodeForProfile,
  isOauthProviderName,
  mintOauthState,
  oauthRedirectUri,
  providerConfigured,
  resolveOauthUser,
  verifyOauthState,
  type OauthIdentityStore,
} from "./oauth.js";
import {
  emptyWorkspace,
  newBoardId,
  newShareToken,
  shareLinkUsable,
  type BoardStore,
  type ShareLink,
  type ShareRole,
  type StoredBoard,
} from "./boards.js";
import { RealtimeServer } from "./realtime.js";
import type { Limiter } from "./limiter.js";
import type { TicketStore } from "./realtimeTicket.js";
import type { StaticHandler } from "./static.js";
import type { SessionStore } from "./sessions.js";
import type { TokenStore } from "./tokens.js";
import { mintCsrf, verifyCsrf } from "./csrf.js";
import type { Mailer } from "./email/index.js";
import type { TotpStore } from "./totpStore.js";
import type { AccountDeletionStore } from "./accountDeletion.js";
import { newOrgId, InMemoryOrgStore, type OrgStore } from "./orgs.js";
import { type OrgInviteStore } from "./invites.js";
import { roleAtLeast, type Role, type StoredUser } from "./identity.js";
import { parseWorkspace } from "@lucent/core";
import type { Config } from "./config.js";
import { newRequestId, silentLogger, type Logger } from "./obs/logger.js";
import { AI_DURATION_BUCKETS, MetricsRegistry } from "./obs/metrics.js";
import {
  notify,
  type NotificationKind,
  type NotificationStore,
  type NotifyDeps,
  type NotifyEvent,
} from "./notifications.js";
import {
  allowanceHint,
  createEntitlements,
  DEFAULT_UPGRADE_URL,
  METERED_KEYS,
  type AllowanceHint,
  type EntitlementRefusal,
  type Entitlements,
  type MeteredEntitlementKey,
} from "./entitlements.js";
import {
  ENTITLEMENTS,
  EXPORT_FORMATS,
  type ExportFormat,
  type NumericEntitlementKey,
} from "./plans.js";
import { monthWindow, newUsageEventId, type UsageKind, type UsageStore } from "./usageStore.js";
import type { EmptyState } from "./http/router.js";
import { Router } from "./http/router.js";
import type { RouteServices } from "./routes/context.js";
import { registerSystemRoutes } from "./routes/system.js";
import { registerNotificationRoutes } from "./routes/notifications.js";
import { registerInviteRoutes } from "./routes/invites.js";
import { registerBoardOpsRoutes } from "./routes/boardOps.js";
import { registerMeetingRoutes } from "./routes/meetings.js";
import { registerProposalRoutes } from "./routes/proposals.js";
import { registerSsoRoutes } from "./routes/sso.js";
import { registerHistoryRoutes } from "./routes/history.js";
import { registerAskRoutes } from "./routes/ask.js";
import { registerSearchRoutes } from "./routes/search.js";
import { registerIntegrationRoutes } from "./routes/integrations.js";
import { mintLiveKitToken } from "./livekit.js";
import { registerAssetRoutes } from "./routes/assets.js";
import { registerScimRoutes } from "./routes/scim.js";
import { PUBLIC_TEMPLATES } from "./publicTemplates.js";
import type { ScimUserAccess } from "./scim.js";
import { createStripeWebhookReceiver, type StripeWebhookReceiver } from "./billing/webhook.js";
import { createIntegrationWebhookReceiver, MAX_WEBHOOK_BYTES, webhookSchemes } from "./integrations/webhook.js";
import { ingestInboundChange } from "./integrations/inbound.js";
import { openPortal, startCheckout, type BillingIntegration } from "./billing/service.js";

/**
 * The HTTP + WebSocket application, assembled from injected dependencies.
 *
 * Extracted from main.ts so it can be booted inside a test without the module
 * doing anything at import time (reading env, opening a pool, listening on a
 * port). That is what makes an end-to-end test of the real wiring possible —
 * the previous `scripts/smoke.ts` only exercised the provider and the reducer, so
 * a defect in the HTTP + WS seam (like `GET /api/boards/:id` 404ing every
 * non-owner) could ship with a green suite.
 *
 * main.ts owns configuration; this file owns behaviour.
 */

export interface AppDeps {
  config: Config;
  provider: LLMProvider;
  imageProvider: ImageProvider;
  userStore: UserStore;
  boardStore: BoardStore;
  secret: string;
  usage: UsageTracker;
  limits: UsageLimits;
  telemetry: Telemetry;
  authLimiter: Limiter;
  tickets: TicketStore;
  /** M1: when provided, browsers authenticate via an httpOnly cookie. */
  sessionStore?: SessionStore;
  /** M1.3: transport for transactional email. Omitted in tests. */
  mailer?: Mailer;
  /** M1.4: token store for email-verification links. */
  verificationTokens?: TokenStore;
  /** M1.4: token store for password-reset links. */
  resetTokens?: TokenStore;
  /** M1.6: TOTP + recovery-code store. */
  totpStore?: TotpStore;
  /** M1.7: pending-account-deletion store. */
  deletionStore?: AccountDeletionStore;
  /** M2: org lifecycle store (create/rename/delete, members, audit). */
  orgStore?: OrgStore;
  /** M2.4: org invite store (tokenised, expiring email invites). */
  inviteStore?: OrgInviteStore;
  /**
   * Serves the built web app on the same origin (M0.6). Omitted in tests and
   * in the dev split where Vite serves the client.
   */
  staticHandler?: StaticHandler;
  /**
   * M0.4 observability. Both default to something inert so no test has to know
   * they exist: a silent logger, and a registry private to this app. main.ts
   * passes the process-wide pair, which is what makes LUCENT_LOG_LEVEL real.
   */
  logger?: Logger;
  metrics?: MetricsRegistry;
  /**
   * M2.6 notifications. Optional the way `orgStore` is: without it the tray
   * routes answer 503 and every `notifyUser` call is a no-op, so a deployment
   * that has not configured one still serves boards.
   */
  notifications?: NotificationStore;
  /**
   * M4 monetization. One store carries the plan catalogue, the subscription
   * rows and the usage meters, so a single dep yields both the entitlement gate
   * and the meter that bills against it.
   *
   * Optional, and its absence disables the gates rather than closing them: a
   * deployment that has not configured billing is an unmetered deployment, not
   * a locked-out one. The same rule `notifications` follows.
   */
  usageStore?: UsageStore;
  /**
   * M3: cross-instance presence. When present, the realtime path mirrors
   * presence updates into this store so a peer list spans every instance,
   * and `isEmpty()` consults the store before evicting a room. Omitted for
   * single-instance deployments and unit tests.
   */
  presenceStore?: import("./presence.js").PresenceStore;
  /**
   * M3: cross-instance op fanout. When present, every committed op is
   * published so a sibling instance's subscribers catch up via the bus.
   * Omitted for single-instance deployments and unit tests.
   */
  fanout?: import("./fanout.js").Fanout;
  /**
   * M3: short identifier for this instance — used as `instanceId` in
   * presence rows so a compare-and-delete on leave cannot evict a row a
   * sibling instance is keeping alive. Defaults to `"local"` when not set.
   */
  instanceId?: string;
  /**
   * M2.6: org-scoped template library (team libraries). When present,
   * `GET/POST/DELETE /api/orgs/:id/templates` become real routes and the
   * org scope is enforced. Without it the same routes answer 503, the same
   * way `notifications` and `usageStore` fail open.
   */
  teamTemplates?: import("./teamTemplates.js").TeamTemplateStore;
  /**
   * E3/R3: meeting transcripts. When present, the board meetings routes are
   * real; without it they answer 503, the same fail-closed rule `notifications`
   * and `teamTemplates` follow. Built by `main.ts` (Postgres when
   * LUCENT_DATABASE_URL is set, in-memory otherwise).
   */
  meetings?: import("./meetings.js").MeetingStore;
  /**
   * Stage B3: review-gate proposals. When present, proposal create/list/
   * decide are real; without it they answer 503 (fail-closed, like the other
   * optional stores). Built by main.ts on the store-per-database rule.
   */
  proposals?: import("./proposals.js").ProposalStore;
  /**
   * F1: SSO connections + domain claims. When present, the admin SSO routes
   * and the SAML ACS are real; without it they answer 503. Built by
   * `main.ts` on the same store-per-database rule.
   */
  ssoStore?: import("./ssoStore.js").SsoStore;
  /**
   * Stage D4: the integration platform — the connection+link store and the
   * provider implementations by name, prebuilt (the billing-bundle
   * precedent). When absent the integration routes answer 503; the app
   * serves exactly as it did before integrations existed. Built by
   * `main.ts` (InMemory store + the FakeProvider in dev; the PG pair and
   * real providers land with D6).
   */
  integrations?: {
    store: import("./integrations/integrations.js").IntegrationStore;
    /** Stage D6: FACTORIES, not instances — a Linear credential is per-org
     * (the connection's credentialRef) while the map is process-global. */
    providers: Map<string, import("./integrations/provider.js").ExecutionProviderFactory>;
    /** Stage D5: the external-action proposal records + the execution ledger. */
    actions?: import("./integrations/integrations.js").IntegrationActionStore;
    ledger?: import("./integrations/ledger.js").ExecutionLedger;
    /** Stage D6: the executor's per-item provider-call race timeout
     * (default 15s; tests inject a short one so the hang arm is fast). */
    executionTimeoutMs?: number;
    /** Stage D7: the webhook delivery ledger + the inbound queue. When
     * absent the webhook route answers 503 — the fail-closed bundle rule. */
    webhookEvents?: import("./integrations/webhook.js").IntegrationWebhookEventStore;
    inbound?: import("./integrations/inbound.js").InboundChangeStore;
  };
  /**
   * M4.3: Stripe billing integration — the REST client, the endpoint signing
   * secret, the idempotency ledger and the event dispatcher, all prebuilt.
   * When absent the three `/api/billing` routes answer 503 and the app serves
   * exactly as it did before billing existed. Built by `main.ts`; tests inject
   * a `StripeClient` whose `fetchImpl` is a fake.
   */
  billing?: BillingIntegration;
  /**
   * Asset gateway. Optional the way `notifications` and `usageStore` are:
   * without it the asset gateway routes are simply absent and the deployment
   * keeps serving boards on top of inlined data URLs. When present, the
   * routes own the upload + thumbnail + delete paths and the gateway refuses
   * any tenant other than the caller's.
   */
  assetService?: import("./assets.js").AssetService;
  /**
   * M6/F1 SCIM 2.0 gateway. When present, `/scim/v2/Users` and Groups are
   * served with the SCIM content type and a Bearer-token gate. The userStore
   * is reused for the underlying account operations.
   *
   * Like `billing` and `teamTemplates`: omitted in dev, mounted in
   * enterprise deployments that point an IdP at this server. The bearer
   * token is configured by `LUCENT_SCIM_TOKEN`.
   */
  scim?: {
    config: import("./scim.js").ScimConfig;
    identities: import("./scim.js").ScimIdentityStore;
    hashPassword: (password: string) => Promise<{ salt: string; hash: string }>;
  };
}

export interface App {
  server: Server;
  realtime: RealtimeServer;
  /** The registry this app records into, so a test can assert on samples. */
  metrics: MetricsRegistry;
  close(): Promise<void>;
}

/**
 * Body cap. Base64 image attachments are large, so this allows a few megabytes
 * while still refusing an unbounded upload — the request schema enforces the
 * per-image and per-document limits inside that budget.
 */
const MAX_BODY_BYTES = 25_000_000;

/**
 * Path segments the router matches literally. A segment that is neither in here
 * nor id-shaped becomes ":seg" rather than a label of its own, so this list
 * drifting behind the router costs a vaguer metric label and never an unbounded
 * one — which is what makes a plain list safe here.
 */
const ROUTE_SEGMENTS = new Set([
  "api",
  "auth",
  "orgs",
  "boards",
  "invites",
  "account",
  "realtime",
  "generate",
  "image",
  "members",
  "share",
  "join",
  "audit",
  "csrf",
  "signup",
  "login",
  "logout",
  "profile",
  "me",
  "sessions",
  "verify",
  "reset",
  "request",
  "confirm",
  "2fa",
  "enroll",
  "disable",
  "delete",
  "cancel",
  "export",
  "accept",
  "ticket",
  "signout-all",
  "notifications",
  "prefs",
  "read",
  "read-all",
  "unread-count",
  "prometheus",
  "billing",
  "webhook",
  "checkout",
  "portal",
  "history",
  "ask",
]);

/**
 * Ids as they are actually minted: a short prefix with a base36/hex tail
 * (`brd_…`, `org_…`, `usr_…`), a UUID, or a long opaque token (a share link).
 */
const ID_SEGMENT =
  /^(?:[a-z]{2,5}_[A-Za-z0-9_-]{1,64}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[A-Za-z0-9_-]{20,})$/;

/**
 * Format a UTC date offset by `deltaDays` from `today` as the `YYYY-MM-DD`
 * key the `usage_rollups.day` column stores. Negative `deltaDays` is past;
 * zero is today. Hours/minutes come from `today` deliberately, because the
 * rollup key is calendar-aligned to UTC midnight.
 */
function formatDay(today: Date, deltaDays: number): string {
  const d = new Date(today.getTime() + deltaDays * 24 * 60 * 60 * 1000);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * One CSV cell, escaped per RFC 4180: quote when the value carries a comma,
 * a quote or any newline, doubling embedded quotes. Unquoted cells are the
 * readable default — every field the audit emits is either a plain id, an
 * epoch number or an email, and a CSV of nothing-but-quotes is a CSV nobody
 * reads. The escaping covers the hostile case (an action string with a
 * comma) rather than assuming it cannot happen.
 */
function csvCell(value: string | number): string {
  const s = String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
  return s;
}

/**
 * Collapse a URL into a bounded metrics label. A raw path as a label value is
 * the standard way a /metrics endpoint becomes a memory leak — obs/metrics.ts
 * caps series per metric for exactly that reason, and folding into
 * "__overflow__" is a worse outcome than labelling honestly up front. Every
 * board id in a path would otherwise be its own series.
 *
 * Exported so the collapsing can be tested without booting a server.
 */
export function routeLabel(url: string): string {
  const path = url.split("?")[0] ?? "/";
  if (
    path === "/health" ||
    path === "/metrics" ||
    path === "/metrics/prometheus" ||
    path === "/ws"
  ) {
    return path;
  }
  if (!path.startsWith("/api/") && path !== "/api") return "static";
  const segments = path.split("/").filter((s) => s.length > 0);
  // Deeper than any route this server defines: a prober's invented path must not
  // mint a series per variation.
  if (segments.length > 5) return "/api/other";
  const labelled = segments.map((segment, i) => {
    if (i === 0) return segment;
    if (ID_SEGMENT.test(segment)) return ":id";
    return ROUTE_SEGMENTS.has(segment) ? segment : ":seg";
  });
  return "/" + labelled.join("/");
}

export function createApp(deps: AppDeps): App {
  const {
    config,
    provider,
    imageProvider,
    userStore,
    boardStore,
    secret,
    usage,
    limits,
    telemetry,
    authLimiter,
    tickets,
    sessionStore,
    mailer,
    verificationTokens,
    resetTokens,
    totpStore,
    deletionStore,
    orgStore,
    inviteStore,
    staticHandler,
    notifications: notificationStore,
    usageStore,
    teamTemplates,
    billing,
    meetings,
    ssoStore,
    integrations,
    proposals: proposalStore,
  } = deps;

  const logger = deps.logger ?? silentLogger;
  const metrics = deps.metrics ?? new MetricsRegistry();

  /**
   * The Stripe webhook receiver, built once. Signature verification, ledger
   * claiming and dispatch all live behind `receive` (billing/webhook.ts); the
   * route below only supplies the raw bytes and answers with the returned
   * status. Null when billing is unconfigured — the route then answers 503
   * rather than silently accepting and dropping deliveries.
   */
  const webhookReceiver: StripeWebhookReceiver | null = billing
    ? createStripeWebhookReceiver({
        secret: billing.webhookSecret,
        store: billing.events,
        dispatcher: billing.dispatcher,
        logger,
      })
    : null;

  /**
   * Wire the in-memory OrgStore to the user store so `membersOf` can join
   * names + emails. The Postgres OrgStore joins the `users` table directly
   * and ignores this hook. Only set when the org store is the in-memory
   * implementation — Postgres' `membersOf` already does the join in SQL.
   */
  if (orgStore instanceof InMemoryOrgStore) {
    orgStore.userFinder = async (userId) => {
      const u = await userStore.findById(userId);
      if (!u) return undefined;
      return { email: u.email, name: u.name };
    };
  }

  /**
   * Shared auth context (M1). The cookie name and flags are derived from the
   * configured origin so dev (http://localhost) and prod (https://…) both
   * produce a sane cookie without per-environment code.
   */
  const authCtx: AuthContext = {
    userStore,
    sessionStore,
    sessionCookie: sessionStore
      ? {
          name: "lucent_session",
          cookieOptions: {
            // 30 days, sliding-window refreshed by `authenticate` via `touch`.
            maxAgeMs: 30 * 24 * 60 * 60 * 1000,
            path: "/",
            // Secure flag on by default; flipped off on loopback so the
            // dev origin (http://localhost:4387) accepts the cookie too.
            secure: config.webOrigin.startsWith("https://"),
            httpOnly: true,
            sameSite: "Lax",
          },
        }
      : undefined,
    // M1.4 wiring. The resetTokens + verificationTokens are optional so test
    // fixtures can omit them when the test doesn't exercise the flow.
    verificationTokens,
    resetTokens,
    // M1.6: TOTP + recovery-code store. Same optionality — tests omit it
    // when they don't exercise the 2FA path.
    totpStore,
    // M1.7: pending-account-deletion store.
    deletionStore,
    mailer,
    // The configured web origin is what verification/reset links use. In dev
    // that's http://localhost:5173 (Vite serves the web app); in prod the
    // deployment sets LUCENT_WEB_ORIGIN to its public hostname.
    siteOrigin: config.webOrigin,
    secret,
  };

  /**
   * Headers on every JSON answer.
   *
   * Three of these matter only for a deployment that serves the web app from a
   * different origin than the API - a CDN plus an api subdomain, which is a
   * normal shape. Dev proxies /api through Vite and production serves both from
   * one origin, so nothing here exercises them today, which is exactly why
   * their absence would be found the hard way: `x-csrf-token` has to be an
   * allowed request header or the preflight fails for every mutating call,
   * `allow-credentials` has to be true or the session cookie is not sent, and
   * `expose-headers` has to name x-request-id or the client cannot quote the
   * correlation id of a request that failed.
   */
  const jsonHeaders: Record<string, string> = {
    "content-type": "application/json",
    "access-control-allow-origin": config.webOrigin,
    "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type, authorization, x-csrf-token, x-request-id",
    "access-control-allow-credentials": "true",
    "access-control-expose-headers": "x-request-id",
  };

  function send(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { ...jsonHeaders });
    res.end(JSON.stringify(body));
  }

  function sendWithHeaders(
    res: ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string>,
  ): void {
    res.writeHead(status, { ...jsonHeaders, ...headers });
    res.end(JSON.stringify(body));
  }

  /**
   * The OAuth flow (M1.8): /start and /callback, both redirects end to end.
   * The state is bound to the browser twice over — signed with the session
   * secret AND mirrored in a short-lived cookie — so a callback URL replayed
   * into a different browser fails before any network call. Full reasoning
   * in oauth.ts; this handler is only the HTTP skin over it.
   */
  async function handleOauth(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const provider = req.url?.split("/")[4]?.split("?")[0] ?? "";
    if (!isOauthProviderName(provider)) {
      send(res, 404, { error: "unknown oauth provider" });
      return;
    }
    const stage = req.url?.includes("/callback") ? "callback" : "start";
    const oauth = config.oauth;

    // Unconfigured → 503 for the API-visible failure. The UI reads the same
    // fact from the csrf response (`oauth` flags) and hides the button, so a
    // user should only meet this page by hand-typing a URL.
    if (!providerConfigured(oauth, provider)) {
      send(res, 503, { error: `oauth provider ${provider} is not configured` });
      return;
    }

    const now = Date.now();
    const redirectUri = oauthRedirectUri(config.webOrigin, provider);
    const stateCookie = "lucent_oauth";

    if (stage === "start") {
      const state = mintOauthState(secret, provider, now);
      res.writeHead(302, {
        location: authorizationUrl(oauth, provider, redirectUri, state),
        "set-cookie": serializeCookie(stateCookie, state, {
          maxAgeMs: 10 * 60_000,
          path: "/",
          secure: config.webOrigin.startsWith("https://"),
          httpOnly: true,
          sameSite: "Lax",
        }),
      });
      res.end();
      return;
    }

    // --- callback ---
    const url = new URL(req.url ?? "/", "http://internal");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const cookieState = getCookie(parseCookies(req.headers.cookie), stateCookie);

    const fail = (reason: string) => {
      // Back to the app with the failure named; the AuthView surfaces it.
      // The state cookie is cleared either way: the flow is over.
      res.writeHead(302, {
        location: `${config.webOrigin}/login?oauth_error=${encodeURIComponent(reason)}`,
        "set-cookie": clearCookie(stateCookie),
      });
      res.end();
    };

    if (!code || !state) {
      fail(url.searchParams.has("error") ? "provider_denied" : "missing_code");
      return;
    }
    // Cookie first: a state string is only meaningful to the browser that
    // was handed it, which is what kills a replayed callback URL.
    if (!cookieState || cookieState !== state) {
      fail("state_mismatch");
      return;
    }
    if (!verifyOauthState(secret, provider, state, now).ok) {
      fail("state_invalid");
      return;
    }

    let profile;
    try {
      profile = await exchangeCodeForProfile(oauth, provider, redirectUri, code);
    } catch (err) {
      logger?.warn("oauth.exchange.failed", {
        provider,
        error: err instanceof Error ? err.message : String(err),
      });
      fail("exchange_failed");
      return;
    }

    const resolution = await resolveOauthUser(
      { userStore: userStore as UserStore & OauthIdentityStore, orgStore },
      provider,
      profile,
      now,
    );
    if (resolution.kind === "error") {
      fail(resolution.reason);
      return;
    }

    const user = resolution.user;
    const session = await mintSession(authCtx, user, {
      userAgent: req.headers["user-agent"] ?? null,
      ip: clientIp(req),
      now,
    });
    const headers: Record<string, string> = {
      "set-cookie": serializeCookie(stateCookie, "", { path: "/", maxAgeMs: -1 }),
    };
    if (session && authCtx.sessionCookie) {
      headers[SESSION_COOKIE_HEADER] = serializeCookie(
        authCtx.sessionCookie.name,
        session.id,
        authCtx.sessionCookie.cookieOptions,
      );
    }
    res.writeHead(302, { location: `${config.webOrigin}/?auth=oauth`, ...headers });
    res.end();
  }

  /**
   * Send a HandleResult that may carry Set-Cookie headers. `Set-Cookie` is
   * multi-valued (RFC 6265 §3) so node http requires one `setHeader` call
   * per cookie; this helper fans a `set-cookie` array into that shape.
   */
  function writeHandleResult(
    res: ServerResponse,
    result: { status: number; body: unknown; headers?: Record<string, string> },
  ): void {
    if (!result.headers) {
      send(res, result.status, result.body);
      return;
    }
    const normalized: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(result.headers)) {
      if (k.toLowerCase() === "set-cookie") {
        normalized[k] = [v];
      } else {
        normalized[k] = v;
      }
    }
    res.writeHead(result.status, { ...jsonHeaders, ...normalized });
    res.end(typeof result.body === "string" ? result.body : JSON.stringify(result.body));
  }

  function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reject(new Error("request body too large"));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
  }

  /**
   * Bytes-as-body reader. Used by the asset routes, where JSON is the wrong
   * carrier for a 10MB PNG. The default cap is the JSON one because the only
   * callers that need a different cap (`POST /api/assets`) say so explicitly
   * to match the `MAX_ASSET_BYTES` limit they advertise to clients.
   */
  function readRawBody(req: IncomingMessage, maxBytes: number = MAX_BODY_BYTES): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          reject(new Error("request body too large"));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  /**
   * Client identity for metering. Authenticated user takes precedence; the IP
   * is only trusted from `X-Forwarded-For` when the deployment explicitly opts
   * in (LUCENT_TRUST_PROXY=1). Without that, an attacker can pin the limiter
   * to a victim's bucket by setting the header themselves.
   */
  /**
   * The caller's network address. `trustProxy` decides whether
   * `x-forwarded-for` is evidence or user input: behind our own proxy it is the
   * only place the real address survives, and on a directly exposed port it is a
   * header anyone can set to anything.
   */
  function clientIp(req: IncomingMessage): string {
    if (config.trustProxy) {
      const forwarded = req.headers["x-forwarded-for"];
      if (typeof forwarded === "string" && forwarded.length > 0) {
        return forwarded.split(",")[0]!.trim();
      }
    }
    return req.socket.remoteAddress ?? "unknown";
  }

  /**
   * Where a request came from, in the two fields the session list and the audit
   * log both record.
   *
   * These were being filled with `clientKey(req)` (audit) or left null
   * (sessions). `clientKey` answers "whose rate-limit bucket is this", so for
   * any bearer-authenticated call it returns `usr:<id>` -- meaning every audit
   * row written by an API client recorded the actor id a second time in the
   * `ip` column and lost the address entirely. An audit log that cannot say
   * where an action came from does not do the job it exists for.
   *
   * The user agent is truncated because it is an unbounded client-supplied
   * header on its way to a `text` column.
   */
  function requestOrigin(req: IncomingMessage): { ip: string; userAgent: string | null } {
    const ua = req.headers["user-agent"];
    return {
      ip: clientIp(req),
      userAgent: typeof ua === "string" && ua.length > 0 ? ua.slice(0, 400) : null,
    };
  }

  function clientKey(req: IncomingMessage): string {
    const token = bearerToken(req.headers.authorization);
    if (token) {
      const payload = verifyToken(token, secret);
      if (payload) return `usr:${payload.userId}`;
    }
    return clientIp(req);
  }

  /**
   * Meter a request. Returns true when it may proceed; otherwise it has already
   * answered with 429 and a Retry-After.
   */
  function meter(req: IncomingMessage, res: ServerResponse, route: string): boolean {
    const decision = usage.check(clientKey(req));
    if (decision.allowed) return true;

    telemetry.record({ kind: "refused", route, reason: decision.reason ?? "rate" });
    sendWithHeaders(
      res,
      429,
      {
        error: decision.reason === "quota" ? "daily quota reached" : "rate limited",
        detail:
          decision.reason === "quota"
            ? "This deployment's daily request limit has been reached. It resets at 00:00 UTC."
            : "Too many requests in a short window. Please retry shortly.",
        retryAfterSeconds: decision.retryAfterSeconds,
      },
      { "retry-after": String(decision.retryAfterSeconds ?? 60) },
    );
    return false;
  }

  /** True (and already responded 401) when auth is required but absent/invalid. */
  async function requireUserIfNeeded(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<{ ok: true; userId?: string } | { ok: false }> {
    const user = await authenticate(
      authCtx,
      req.headers.cookie ?? null,
      bearerToken(req.headers.authorization),
    );
    if (user) return { ok: true, userId: user.id };
    if (config.requireAuth) {
      send(res, 401, { error: "authentication required" });
      return { ok: false };
    }
    return { ok: true };
  }

  /** Resolve the caller, or answer 401 and return undefined. */
  async function requireUser(req: IncomingMessage, res: ServerResponse) {
    const user = await authenticate(
      authCtx,
      req.headers.cookie ?? null,
      bearerToken(req.headers.authorization),
    );
    if (!user) {
      send(res, 401, { error: "authentication required" });
      return undefined;
    }
    return user;
  }

  /**
   * M2.2: look up the user's role on an org. Cache nothing — the org list
   * is small and called on every state-changing route.
   */
  async function orgRoleFor(userId: string, orgId: string): Promise<Role | undefined> {
    const memberships = await userStore.membershipsFor(userId);
    return memberships.find((m) => m.orgId === orgId)?.role;
  }

  /**
   * M2.2: cross-tenant leakage prevention. Every org-scoped request passes
   * through this guard, which checks the user's role on the requested org
   * against the minimum. A 404 (not 403) is returned when the org doesn't
   * exist or the user isn't a member — the response is identical so a
   * hostile caller can't enumerate org ids.
   */
  // Both guards below answer 404 whether the thing is missing or merely out of
  // reach, so ids stay unguessable. That masking is right for the caller and
  // wrong for us: "this board does not exist" and "this member cannot see it"
  // are the same line in `lucent_http_requests_total`, and they need opposite
  // answers when a customer reports a board they cannot open. This counter is
  // where the two are told apart, and it is what the `route` argument every
  // guard already takes is for. A denial is counted; a genuine miss is not.
  const authzDenials = metrics.counter({
    name: "lucent_authz_denials_total",
    help: "Requests refused by a role guard, by route template and guard scope.",
    labelNames: ["route", "scope"],
  });

  async function requireOrgRole(
    req: IncomingMessage,
    res: ServerResponse,
    orgId: string | undefined,
    required: Role,
    route: string,
  ): Promise<{ ok: true; user: StoredUser; role: Role } | { ok: false }> {
    const user = await requireUser(req, res);
    if (!user) return { ok: false };
    if (!orgId) {
      send(res, 400, { error: "orgId required" });
      return { ok: false };
    }
    const role = await orgRoleFor(user.id, orgId);
    if (!role || !roleAtLeast(role, required)) {
      // 404 to keep org ids unguessable; the response is the same whether
      // the org doesn't exist or the user just isn't a member.
      authzDenials.inc({ route, scope: "org" });
      send(res, 404, { error: "not found" });
      return { ok: false };
    }
    return { ok: true, user, role };
  }

  /**
   * M2.2: board-level guard that consults both the board's ownerId and
   * the user's org role. A user with `owner` on the board's org is owner
   * on every board in the org; otherwise the explicit `board_members`
   * row wins.
   *
   * This is the single board-authorisation path, and every board route calls
   * it. The bug it replaces was subtle: the guard existed but nothing used it,
   * and each route ran a bare `boardStore.memberRole(id, user.id)` with no
   * org-role resolver. Without the resolver `effectiveBoardRole` never sees an
   * org grant, so org-level roles were dead code — an org owner had no access
   * at all to a board in their own org unless someone separately added them as
   * a board member. The resolver below is the whole fix; keeping it in one
   * function is what stops the next route from forgetting it.
   *
   * Refusals are always 404 with an identical body, whether the board does not
   * exist or the caller merely cannot reach it, so board ids stay unguessable.
   *
   * `caller` lets a route that has already resolved the user (the share route
   * checks `emailVerifiedAt` before it authorises) skip a second
   * authentication round-trip; it is not an authorisation input.
   */
  async function requireBoardRole(
    req: IncomingMessage,
    res: ServerResponse,
    boardId: string,
    required: Role,
    route: string,
    caller?: StoredUser,
  ): Promise<{ ok: true; user: StoredUser; role: Role; board: StoredBoard } | { ok: false }> {
    const user = caller ?? (await requireUser(req, res));
    if (!user) return { ok: false };
    const board = await boardStore.get(boardId);
    if (!board) {
      send(res, 404, { error: "board not found" });
      return { ok: false };
    }
    // The third argument is the org-role resolver: `memberRole` combines the
    // org grant with the `board_members` row through `effectiveBoardRole` and
    // resolves the board owner without needing a row at all.
    const role = await boardStore.memberRole(boardId, user.id, (uid) =>
      orgRoleFor(uid, board.orgId),
    );
    if (!role || !roleAtLeast(role, required)) {
      authzDenials.inc({ route, scope: "board" });
      send(res, 404, { error: "board not found" });
      return { ok: false };
    }
    // The board travels with the guard so a route needn't re-read it.
    return { ok: true, user, role, board };
  }

  /** True (and already responded 429) when this IP+email pair is being throttled. */
  function applyAuthLimiter(
    req: IncomingMessage,
    res: ServerResponse,
    email: string,
    route: string,
  ): boolean {
    const key = `${clientKey(req)}|${normalizeForKey(email)}`;
    const decision = authLimiter.check(key);
    if (decision.allowed) return true;
    telemetry.record({ kind: "refused", route, reason: "rate" });
    sendWithHeaders(
      res,
      429,
      { error: "too many attempts", retryAfterSeconds: decision.retryAfterSeconds },
      { "retry-after": String(decision.retryAfterSeconds) },
    );
    return false;
  }

  /**
   * Per-IP rate limit for cookie-authenticated account mutations. Reuses the
   * same `authLimiter` map with a different key prefix so a shared abuse
   * pattern cannot exhaust the login budget.
   *
   * The cap is the limiter's per-window; the key only depends on the IP so
   * the same IP cannot schedule and cancel deletion rapidly in alternation.
   */
  function applyAccountLimiter(req: IncomingMessage, res: ServerResponse, route: string): boolean {
    const key = `account|${clientKey(req)}`;
    const decision = authLimiter.check(key);
    if (decision.allowed) return true;
    telemetry.record({ kind: "refused", route, reason: "rate" });
    sendWithHeaders(
      res,
      429,
      { error: "too many attempts", retryAfterSeconds: decision.retryAfterSeconds },
      { "retry-after": String(decision.retryAfterSeconds) },
    );
    return false;
  }

  /**
   * Throttle the two routes that send mail to an address the caller names:
   * `/api/auth/verify/request` and `/api/auth/reset/request`. Both answer 204
   * whatever happens -- deliberately, so neither is an account oracle -- and
   * both were unmetered, which made either one a free mail cannon: POST in a
   * loop with a stranger's address and we deliver the flood ourselves, from our
   * own sending reputation.
   *
   * Two buckets, both consulted. The address bucket stops one mailbox being
   * buried; the IP bucket stops one host walking a list of addresses, which the
   * address bucket alone cannot see.
   *
   * Deliberately not `applyAuthLimiter`: its bucket is keyed `ip|email` and
   * shared with login and signup, so ten fat-fingered logins would swallow the
   * password reset the user needs at exactly that moment. A separate prefix
   * costs one map entry and keeps recovery reachable.
   *
   * The confirm halves stay unmetered: their input is a random token, guessing
   * is already hopeless, and a per-IP cap there would break every suite that
   * redeems several tokens from 127.0.0.1.
   */
  function applyMailLimiter(
    req: IncomingMessage,
    res: ServerResponse,
    email: string,
    route: string,
  ): boolean {
    const ip = clientIp(req);
    for (const key of [`mail|${ip}|${normalizeForKey(email)}`, `mail|${ip}`]) {
      const decision = authLimiter.check(key);
      if (decision.allowed) continue;
      telemetry.record({ kind: "refused", route, reason: "rate" });
      sendWithHeaders(
        res,
        429,
        { error: "too many attempts", retryAfterSeconds: decision.retryAfterSeconds },
        { "retry-after": String(decision.retryAfterSeconds) },
      );
      return false;
    }
    return true;
  }

  /**
   * M1.2 CSRF guard. Returns false (and responds 403) when the request fails
   * the Origin / double-submit checks. State-changing routes call this at the
   * top and bail out on false; safe methods (GET/HEAD/OPTIONS) skip it.
   *
   * Server-to-server clients without an Origin header pass through; they
   * authenticate with a bearer token instead, which the auth layer enforces.
   */
  function requireCsrf(req: IncomingMessage, res: ServerResponse, route: string): boolean {
    const headerValue = Array.isArray(req.headers["x-csrf-token"])
      ? req.headers["x-csrf-token"][0]
      : req.headers["x-csrf-token"];
    const cookies = typeof req.headers.cookie === "string" ? req.headers.cookie : "";
    // CSRF only fires when the request is authenticated via the session
    // cookie — programmatic clients with no session cookie bypass and the
    // MCP client's bearer path still works.
    const hasSessionCookie = cookies.includes("lucent_session=");
    const result = verifyCsrf(
      {
        secret,
        allowedOrigins: [config.webOrigin, `http://${req.headers.host ?? ""}`].filter(Boolean),
      },
      req.method ?? "GET",
      typeof req.headers.origin === "string" ? req.headers.origin : undefined,
      cookies,
      typeof headerValue === "string" ? headerValue : undefined,
      hasSessionCookie,
    );
    if (result.ok) return true;
    telemetry.record({ kind: "refused", route, reason: `csrf:${result.reason}` });
    send(res, 403, { error: "csrf rejected", reason: result.reason });
    return false;
  }

  /** Normalise an email so `Ana@…` and `ana@…` don't double-bucket the limiter. */
  function normalizeForKey(email: string): string {
    return email.trim().toLowerCase();
  }

  /**
   * M2.6: the notification seam. Two rules, both load-bearing.
   *
   * It is fire-and-forget. `notify` writes a row and may then send mail, and
   * neither belongs on the critical path of the request that caused it: nothing
   * about telling someone their role changed should be able to turn a successful
   * role change into a 500, or add an SMTP round trip to its latency.
   *
   * And a deployment without a store configured is not an error — the calls
   * become no-ops, exactly as `orgStore?.audit` does, so boards keep working.
   */
  const notifyDeps: NotifyDeps | null = notificationStore
    ? {
        store: notificationStore,
        ...(mailer ? { mailer } : {}),
        siteOrigin: config.webOrigin,
      }
    : null;

  function notifyUser<K extends NotificationKind>(event: NotifyEvent<K>): void {
    if (!notifyDeps) return;
    void notify(notifyDeps, event).catch((err: unknown) => {
      logger.warn("notify_failed", {
        kind: event.kind,
        userId: event.to.userId,
        message: err instanceof Error ? err.message : String(err),
      });
    });
  }

  // --- Monetization: the entitlement gate (M4) ------------------------------
  //
  // entitlements.ts resolves what an org may do (`subscriptions` -> `plans` ->
  // compiled-in Free) and usageStore.ts records what it did. Both hang off the
  // single `usageStore` dep, which is why gating and metering a route costs two
  // lines rather than a paragraph.
  //
  // No store means no gate. An unconfigured billing integration must not read as
  // "every org is over its limit" -- that turns a missing Stripe key into an
  // outage -- so every helper below allows the request and every meter drops it,
  // exactly as `notifyUser` no-ops without a notification store.
  const entitlements: Entitlements | null = usageStore
    ? createEntitlements({ source: usageStore })
    : null;

  // Bounded labels on purpose: seven entitlement keys times a handful of plan
  // codes is the whole label space, which is what makes this safe to expose. It
  // is also the only series that answers "how many customers hit a paywall this
  // week" -- the number that decides whether a limit is priced right.
  const entitlementRefusals = metrics.counter({
    name: "lucent_entitlement_refusals_total",
    help: "Requests refused by a plan limit, by entitlement key and plan.",
    labelNames: ["key", "plan"],
  });
  // Metering is fire-and-forget, so a failed write is silent by construction.
  // Silent lost revenue is the worst failure mode in this file; it gets a
  // counter so it can be alerted on.
  const usageRecordFailures = metrics.counter({
    name: "lucent_usage_record_failures_total",
    help: "Billable acts that could not be written to the usage log.",
    labelNames: ["kind"],
  });

  /**
   * Answer with the refusal the gate built. The body is never assembled at a
   * call site: a route that writes its own `{ reason, upgradeUrl }` is a route
   * that will name the wrong tier or the wrong reset date, and those strings are
   * the upgrade prompt the whole tier system exists to produce.
   */
  function refuseByPlan(res: ServerResponse, route: string, refusal: EntitlementRefusal): false {
    entitlementRefusals.inc({ key: refusal.body.key, plan: refusal.body.plan });
    telemetry.record({ kind: "refused", route, reason: `plan:${refusal.body.key}` });
    send(res, refusal.status, refusal.body);
    return false;
  }

  /**
   * A metered monthly allowance. The store reads month-to-date itself, so this
   * is the entire gate for AI generations and voice minutes.
   *
   * The read happens before the provider call, so N concurrent requests against
   * a limit with one left can all see "one left" and all proceed. The overshoot
   * is bounded by in-flight concurrency and is not something a caller can drive;
   * a transaction per generation would trade that for a write on the hot path.
   * For a soft allowance the honest trade is to overshoot by a call or two and
   * bill accurately, which the usage log does regardless.
   */
  async function gateMonthly(
    res: ServerResponse,
    orgId: string,
    key: MeteredEntitlementKey,
    route: string,
    amount = 1,
  ): Promise<AllowanceHint | null | false> {
    // `false` means the refusal has been sent and the route must stop; a hint
    // means it may proceed and is this close to the ceiling; `null` means it may
    // proceed and nothing here is metered, so there is nothing to warn about.
    if (!entitlements) return null;
    const decision = await entitlements.checkMonthly(orgId, key, amount);
    if (!decision.allowed && decision.refusal) return refuseByPlan(res, route, decision.refusal);
    return allowanceHint(decision, amount);
  }

  /**
   * A standing limit -- boards, seats, stored bytes. There is no meter to read:
   * the count is a live query only the caller can make, and `amount` is what
   * this request would add, so the ceiling is tested against the resulting total
   * rather than the current one.
   */
  async function gateStanding(
    res: ServerResponse,
    orgId: string,
    key: NumericEntitlementKey,
    used: number,
    route: string,
    amount = 1,
  ): Promise<boolean> {
    if (!entitlements) return true;
    const decision = await entitlements.decide(orgId, key, used, amount);
    if (decision.allowed || !decision.refusal) return true;
    return refuseByPlan(res, route, decision.refusal);
  }

  /** Set-valued: is this export format included in the org's tier? */
  async function gateFormat(
    res: ServerResponse,
    orgId: string,
    format: ExportFormat,
    route: string,
  ): Promise<boolean> {
    if (!entitlements) return true;
    const decision = await entitlements.checkFormat(orgId, format);
    if (decision.allowed || !decision.refusal) return true;
    return refuseByPlan(res, route, decision.refusal);
  }

  /**
   * The other half of `gateMonthly`: hand a successful body the headroom the
   * gate measured, so a client can warn before it hits the wall instead of only
   * after (M4's soft limit).
   *
   * In the body rather than a response header, even though `sendWithHeaders`
   * exists: a cross-origin client cannot read a header that is missing from
   * `access-control-expose-headers`, and the failure is silent -- a customer who
   * never sees the warning, on the one feature whose whole purpose is to be seen
   * before a refusal. Attached only to a body that is a JSON object, so an error
   * shape is never rewritten.
   */
  function withAllowance(body: unknown, allowance: AllowanceHint | null): unknown {
    if (allowance === null || typeof body !== "object" || body === null || Array.isArray(body)) {
      return body;
    }
    return { ...(body as Record<string, unknown>), allowance };
  }

  /**
   * Record one billable act, off the request's critical path.
   *
   * Fire-and-forget for `notifyUser`'s reason: the customer's work has already
   * succeeded, and a write to the usage log must not be able to turn a delivered
   * generation into a 500. Unlike a missed notification, a missed meter is lost
   * revenue, so the failure is counted and logged instead of swallowed.
   *
   * The event id is random rather than derived from the request. With
   * `trustProxy` on, `x-request-id` is client-supplied, so a deterministic id
   * would hand a caller a way to replay one value and stop being billed. One
   * request that reached the provider is one billable act; deterministic ids
   * belong to the webhook and replay paths, where the *sender* owns the key.
   */
  function meterUsage(orgId: string, kind: UsageKind, quantity: number, metadata?: unknown): void {
    if (!usageStore) return;
    void usageStore
      .record({
        id: newUsageEventId(),
        orgId,
        kind,
        quantity,
        at: Date.now(),
        ...(metadata !== undefined ? { metadata } : {}),
      })
      .catch((err: unknown) => {
        usageRecordFailures.inc({ kind });
        logger.warn("usage_record_failed", {
          orgId,
          kind,
          quantity,
          message: err instanceof Error ? err.message : String(err),
        });
      });
  }

  /**
   * The org an AI call bills against, and whether the caller may treat the named
   * board as authoritative. Both answers come from one role resolution because
   * they are the same question: does this caller actually hold an editor grant on
   * that board?
   *
   * Billing on the requested `boardId` alone would let anyone spend a stranger's
   * monthly allowance by naming their board id -- quota vandalism with no upside
   * to the attacker beyond the damage. Everyone else bills to their first org,
   * which for a fresh account is their personal one.
   */
  async function resolveAiContext(
    userId: string | undefined,
    board: StoredBoard | undefined,
  ): Promise<{ orgId: string | undefined; authoritative: boolean }> {
    if (board && userId) {
      const role = await boardStore.memberRole(board.id, userId, (uid) =>
        orgRoleFor(uid, board.orgId),
      );
      if (role && roleAtLeast(role, "editor")) {
        return { orgId: board.orgId, authoritative: true };
      }
    }
    if (!userId) return { orgId: undefined, authoritative: false };
    const memberships = await userStore.membershipsFor(userId);
    return { orgId: memberships[0]?.orgId, authoritative: false };
  }

  // --- Observability (M0.4) -------------------------------------------------
  //
  // obs/logger.ts and obs/metrics.ts were written, then imported by nothing and
  // covered by nothing: LUCENT_LOG_LEVEL was a documented flag with no effect,
  // and the process had no request-level signal at all. test/obs.test.ts covers
  // both modules and this seam together. The block below is the seam that
  // makes both real — one correlation id per request, one structured access
  // line, and the three RED series.

  const httpRequests = metrics.counter({
    name: "lucent_http_requests_total",
    help: "HTTP requests completed, by method, route template and status.",
    labelNames: ["method", "route", "status"],
  });
  const httpDuration = metrics.histogram({
    name: "lucent_http_request_duration_seconds",
    help: "Wall-clock seconds from request start to response finish.",
    labelNames: ["method", "route"],
  });
  const httpInFlight = metrics.gauge({
    name: "lucent_http_requests_in_flight",
    help: "Requests currently being handled.",
  });
  const httpUnhandled = metrics.counter({
    name: "lucent_http_unhandled_errors_total",
    help: "Requests that escaped their route's own error handling.",
    labelNames: ["route"],
  });

  // --- Telemetry bridged into Prometheus ------------------------------------
  //
  // telemetry.ts counted refusals from the beginning, but only into its own JSON
  // snapshot: a scrape saw `lucent_entitlement_refusals_total` for plan limits
  // and nothing at all for the rate limiter or the CSRF check. Those are the two
  // series an on-call actually pages on -- a spike in rate refusals is either an
  // attack or a limit set too low, and a spike in CSRF refusals is a broken
  // deploy locking every browser out -- and neither was alertable.
  //
  // `reason` is narrowed to a class rather than passed through. The raw values
  // carry an entitlement key or a CSRF failure code, so as a label they would be
  // unbounded by design; four classes times the route templates is a shape that
  // stays inside the registry's series cap.
  //
  // CSRF gets a class of its own here, which is the one place it does. In the
  // JSON snapshot it is folded into `quota` and has to stay there -- that
  // fall-through predates plan gating and test/usage.test.ts locks the three
  // buckets -- so Prometheus is where the distinction lives.
  const refusals = metrics.counter({
    name: "lucent_refusals_total",
    help: "Requests turned away, by route template and refusal class.",
    labelNames: ["route", "reason"],
  });
  // Provider latency, not request latency. `lucent_http_request_duration_seconds`
  // already times /api/generate end to end, but that number moves when our own
  // validation or persistence slows down; this one isolates the model call, which
  // is the part we buy and the part that pages. Hence the seconds-scale buckets.
  const aiDuration = metrics.histogram({
    name: "lucent_ai_call_duration_seconds",
    help: "Seconds spent in a provider call, by kind and provider.",
    labelNames: ["kind", "provider"],
    buckets: AI_DURATION_BUCKETS,
  });

  // Realtime connection lifetime (docs/reliability/slo.md, "Realtime
  // reachability"): the share of sockets still connected at the five-minute
  // mark is the SLO, and it is only answerable from a duration histogram.
  // Buckets are coarse on purpose — the SLO reads one bucket boundary (300s)
  // plus a coarse tail for context; finer resolution would be series the
  // alerting rules never query. Defined at the same scope as the other
  // metrics so `createApp` owns the full registry it returns.
  const wsDuration = metrics.histogram({
    name: "lucent_realtime_connection_duration_seconds",
    help: "Seconds a WebSocket connection stayed open, observed at close.",
    labelNames: [],
    buckets: [1, 5, 30, 60, 120, 300, 600, 1800, 3600],
  });

  type RefusalReason = Extract<TelemetryEvent, { kind: "refused" }>["reason"];
  function refusalClass(reason: RefusalReason): "rate" | "quota" | "csrf" | "plan" {
    if (reason === "rate" || reason === "quota") return reason;
    return reason.startsWith("csrf:") ? "csrf" : "plan";
  }

  // Telemetry `error` events are deliberately not bridged: their route and
  // status are already in `lucent_http_requests_total`, and a second series
  // saying the same thing is a second series to keep in agreement.
  const unsubscribeTelemetry = telemetry.subscribe((event) => {
    switch (event.kind) {
      case "refused":
        refusals.inc({ route: event.route, reason: refusalClass(event.reason) });
        break;
      case "generate":
      case "image":
      case "ask":
        aiDuration.observe(event.ms / 1000, { kind: event.kind, provider: event.provider });
        break;
      default:
        break;
    }
  });

  /**
   * The correlation id for one request. An inbound `x-request-id` is honoured
   * only when the deployment says it sits behind a proxy — the same rule
   * `clientKey` applies to X-Forwarded-For, and for the same reason: with
   * nothing in front of this process, that header can only have come from the
   * caller. The charset is restricted because the value is echoed into a
   * response header and into a log line, neither of which may carry a newline.
   */
  const REQUEST_ID_SHAPE = /^[A-Za-z0-9._:-]{8,128}$/;
  function requestIdOf(req: IncomingMessage): string {
    if (!config.trustProxy) return newRequestId();
    const inbound = req.headers["x-request-id"];
    const value = Array.isArray(inbound) ? inbound[0] : inbound;
    return value && REQUEST_ID_SHAPE.test(value) ? value : newRequestId();
  }

  /**
   * Wraps every request: correlation id, access-log line, RED series, and the
   * outermost try/catch.
   *
   * That last part is not incidental. `createServer(async …)` does not await the
   * handler, so a rejection that escaped a route's own catch became an unhandled
   * promise rejection — which in current Node terminates the process. One
   * malformed request could stop the server. A 500 on that request is the
   * correct blast radius.
   */
  async function observe(
    req: IncomingMessage,
    res: ServerResponse,
    handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  ): Promise<void> {
    const startedAt = process.hrtime.bigint();
    const requestId = requestIdOf(req);
    const method = (req.method ?? "GET").toUpperCase();
    const route = routeLabel(req.url ?? "/");
    res.setHeader("x-request-id", requestId);
    httpInFlight.inc();

    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      httpInFlight.dec();
      const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
      const status = res.statusCode;
      httpDuration.observe(seconds, { method, route });
      httpRequests.inc({ method, route, status: String(status) });
      // A 4xx is a correct answer to a bad request and must not read as a server
      // fault; only 5xx does.
      const level = status >= 500 ? "error" : status >= 400 ? "warn" : "info";
      logger.log(level, "http_request", {
        requestId,
        method,
        route,
        status,
        durationMs: Math.round(seconds * 1000),
      });
    };
    // "close" covers a client that disconnected before the response finished,
    // where "finish" never fires; whichever lands first wins.
    res.on("finish", settle);
    res.on("close", settle);

    try {
      await handle(req, res);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      httpUnhandled.inc({ route });
      telemetry.record({ kind: "error", route, status: 500, message });
      logger.error("unhandled_request_error", { requestId, method, route, message });
      // The id travels in the body too: it is the one thing a user can quote
      // back that finds the exact line in the log.
      if (!res.headersSent) send(res, 500, { error: "internal error", requestId });
      else res.end();
    }
  }

  /**
   * The route table.
   *
   * Every registration here was a branch of the `if`-ladder in `handleRequest`
   * below, matched by hand against `req.url`. Matching on a parsed pathname with
   * `:id` holes is the difference between `/api/boards/:id/members/:userId`
   * being a pattern and being `startsWith` plus `includes` plus a hand-counted
   * `split("/")[3]`.
   *
   * `onError` rethrows instead of answering, because `observe` above owns the
   * 500 path -- the unhandled-error counter, the telemetry record and the
   * correlation id echoed in the body. A router that answered first would emit
   * a 500 that skips all three.
   *
   * `baseHeaders` is the very object the ladder answers with, so `ctx.send`
   * cannot produce a response missing the CORS block. Route modules still write
   * through `services.send`; see `routes/context.ts`.
   */
  const services: RouteServices = {
    config,
    logger,
    metrics,
    telemetry,
    secret,
    provider,
    imageProvider,
    authCtx,
    userStore,
    boardStore,
    orgStore,
    inviteStore,
    notificationStore,
    usageStore,
    meetings,
    ssoStore,
    integrations,
    proposals: proposalStore,
    entitlements,
    tickets,
    usage,
    limits,
    webOrigin: config.webOrigin,
    sessionStore,
    send,
    sendWithHeaders,
    writeHandleResult,
    readBody,
    requestOrigin,
    // The audit seam route modules use: the OrgStore's warn-and-continue
    // contract (a failed audit write never 500s a succeeded mutation),
    // delivered as a function so no route assembles the entry shape itself.
    auditRow: async (req, actorId, orgId, action, targetId) => {
      await orgStore
        ?.audit({
          orgId,
          actorId,
          action,
          targetId,
          targetType: action.split(".")[0],
          ...requestOrigin(req),
          at: Date.now(),
        })
        .catch(() => {
          // orgs.ts's contract: audit failures warn, they never fail.
        });
    },
    meter,
    requireUserIfNeeded,
    requireUser,
    orgRoleFor,
    requireOrgRole,
    requireBoardRole,
    requireCsrf,
    applyAuthLimiter,
    applyAccountLimiter,
    applyMailLimiter,
    notifyUser,
    gateMonthly,
    gateStanding,
    gateFormat,
    withAllowance,
    meterUsage,
    resolveAiContext,
    // Deferred deliberately: `realtime` is constructed below, after the HTTP
    // server it needs, so this closure resolves it at request time.
    evictBoard: (boardId) => realtime.evictBoard(boardId),
    // Stage B3: the proposal seams, deferred for the same reason as evictBoard
    // — `realtime` is constructed below the route table.
    commitForBoard: (boardId, userId, ops, label, meta) =>
      realtime.commitForBoard(boardId, userId, ops, label, meta),
    broadcastProposal: (boardId, event) => realtime.broadcastProposal(boardId, event),
  };

  const router = new Router<EmptyState>({
    maxBodyBytes: MAX_BODY_BYTES,
    baseHeaders: () => jsonHeaders,
    onError: (_ctx, err) => {
      throw err;
    },
  });

  registerSystemRoutes(router, services);
  registerNotificationRoutes(router, services);
  registerInviteRoutes(router, services);
  registerBoardOpsRoutes(router, services);
  registerMeetingRoutes(router, services);
  registerProposalRoutes(router, services);
  registerSsoRoutes(router, services);
  registerHistoryRoutes(router, services);
  registerAskRoutes(router, services);
  registerSearchRoutes(router, services);
  registerIntegrationRoutes(router, services);
  /**
   * Asset gateway (M7 / M4 storage): `/api/assets/*`. The handler is built
   * here, not registered through the router, because it consumes a body-cap
   * that is wider than the JSON one (`MAX_ASSET_BYTES + 1KB`) and replaces the
   * JSON-typed `readBody` with `readRawBody`. Mounting it as a separate
   * dispatch keeps that boundary visible and avoids a second body cap in the
   * router's shared config.
   */
  const assetRoutesHandle = deps.assetService
    ? registerAssetRoutes({
        assetService: deps.assetService,
        requireUser,
        membershipsFor: (userId: string) => userStore.membershipsFor(userId),
        requireOrgRole,
        requireCsrf,
        send,
        readRawBody,
        ...(logger ? { logger } : {}),
        warnMemoryStorage: deps.assetService.describe().blobs.startsWith("memory"),
      })
    : null;

  /**
   * SCIM gateway (M6 / F1). Mounted before the central switch so the SCIM
   * route's 401 answer (token mismatch) wins over the generic 404 the ladder
   * would otherwise emit on `/scim/v2/...`. The handler internally gates on
   * `scimAuthenticated`; a missing `deps.scim` makes the route a 404, the
   * same way billing and teamTemplates fail closed.
   */
  const scimUsersAccess: ScimUserAccess | undefined = deps.scim
    ? {
        findById: (id) => userStore.findById(id),
        findByEmail: (email) => userStore.findByEmail(email),
        insert: async (input) => {
          await userStore.insert({ ...input });
        },
        bumpTokenVersion: (userId, at) => userStore.bumpTokenVersion(userId, at),
      }
    : undefined;
  const scimHandle =
    deps.scim && scimUsersAccess
      ? registerScimRoutes({
          config: deps.scim.config,
          identities: deps.scim.identities,
          users: scimUsersAccess,
          hashPassword: deps.scim.hashPassword,
        })
      : null;

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method === "OPTIONS") {
      send(res, 204, {});
      return;
    }

    // --- Stage D7: the integration webhook receiver ------------------------
    //
    // Deliberately FIRST in the ladder, and with no auth guards — the
    // billing webhook precedent (see the /api/billing/webhook comment
    // below): the caller is Linear's infrastructure, not a user. It has
    // no cookie, no CSRF token and no bearer token; its authentication
    // *is* the HMAC signature over the raw body, verified inside
    // `receive`. No `requireCsrf`, no `requireUser`, no `meter`. The
    // receiver resolves WHICH org signed by matching every active
    // connection's webhook secret (the org resolution), so nothing about
    // the caller is trusted before the signature holds. A Buffer body —
    // the raw-body-is-the-message doctrine.
    if (
      req.method === "POST" &&
      /^\/api\/integrations\/[a-z]+\/webhook$/.test(req.url?.split("?")[0] ?? "")
    ) {
      const provider = (req.url!.split("?")[0]!.match(/^\/api\/integrations\/([a-z]+)\/webhook$/) ?? [])[1]!;
      if (!deps.integrations?.webhookEvents || !deps.integrations?.inbound || !deps.integrations) {
        send(res, 503, { error: "integrations are not configured" });
        return;
      }
      const { integrations } = deps;
      if (!integrations.providers.has(provider)) {
        send(res, 404, { error: `no provider implementation named "${provider}" is loaded` });
        return;
      }
      // Stage D8: the scheme registry — the provider-specific half of the
      // receiver (header format, verify, parse). A provider with no scheme
      // (Jira: Atlassian's Connect JWT/QSH model is its own project, not
      // a guess) answers the honest 404: no inbound exists for it.
      const scheme = webhookSchemes.get(provider);
      if (!scheme) {
        send(res, 404, { error: `no inbound webhook scheme for "${provider}"` });
        return;
      }
      let payload: Buffer;
      try {
        payload = await readRawBody(req, MAX_WEBHOOK_BYTES);
      } catch (err) {
        send(res, 400, { error: "bad request", detail: (err as Error).message });
        return;
      }
      // Org resolution input: every ACTIVE connection for this provider,
      // each with its webhookSecretRef resolved through the environment.
      // Secrets read per-delivery so a rotation takes effect without a
      // restart (the same temporariness clause as credentialRef).
      const connections = await integrations.store.connectionsFor(provider);
      const candidates = connections.flatMap((connection) => {
        const ref = connection.config?.webhookSecretRef;
        const secret = ref ? process.env[ref] : undefined;
        return secret
          ? [{ connectionId: connection.id, orgId: connection.orgId, secret }]
          : [];
      });
      const receiver = createIntegrationWebhookReceiver({
        provider,
        scheme,
        candidates,
        events: integrations.webhookEvents!,
        onChange: async (change, orgId) => {
          // A verified change lands in the human-gated queue. The
          // provider instance is per-delivery (mapStatus is pure), and
          // ingest touches no wire.
          const resolved = integrations.providers.get(provider);
          const connection = connections.find((c) => c.orgId === orgId);
          if (!resolved || !connection) return;
          await ingestInboundChange(
            {
              linksForExternalId: (p, externalId) =>
                integrations.store.linksForExternalId(p, externalId),
              boardNodeStatus: async (boardId, nodeId) => {
                const board = await boardStore.get(boardId);
                if (!board) return null;
                const node = board.workspace.nodes[nodeId];
                return node?.issue?.status ?? null;
              },
              store: integrations.inbound!,
              provider: resolved(connection),
            },
            change,
            orgId,
          );
        },
      });
      // The scheme owns the header name — GitHub signs X-Hub-Signature-256,
      // Linear X-Signature; the route guesses neither.
      const result = await receiver.receive({
        payload,
        signature: req.headers[scheme.signatureHeader],
      });
      send(res, result.status, result.body);
      return;
    }

    // --- Static (built web app, M0.6) ---
    // Short-circuits GETs the static handler serves. API / WS / health /
    // metrics all keep flowing into the rest of the router.
    if (staticHandler && (await staticHandler.serve(req, res))) return;

    // Domains that have been moved off the ladder. `handle` resolves false when
    // no pattern matched, so an unmoved route still reaches its `if` branch
    // below and the ladder's own final 404 stays the last word.
    if (await router.handle(req, res, {})) return;

    if (assetRoutesHandle && req.url?.startsWith("/api/assets")) {
      if (await assetRoutesHandle(req, res)) return;
    }

    if (scimHandle && req.url?.startsWith("/scim/v2")) {
      if (await scimHandle(req, res)) return;
    }

    // M2.3: list every org the caller is in. Used by the switcher UI to know
    // which org to land on; an org-aware "create board" route can pick the
    // active one from the query string.
    if (req.method === "GET" && (req.url === "/api/orgs" || req.url === "/api/orgs/")) {
      const user = await requireUser(req, res);
      if (!user) return;
      const list = await userStore.listOrgsForUser(user.id);
      send(res, 200, {
        orgs: list.map(({ org, role }) => ({
          id: org.id,
          name: org.name,
          role,
          createdAt: org.createdAt,
          isPersonal: org.id === `org_personal_${user.id}`,
        })),
      });
      return;
    }
    // M2.3: create a new (non-personal) org. The caller becomes its owner.
    if (req.method === "POST" && (req.url === "/api/orgs" || req.url === "/api/orgs/")) {
      if (!requireCsrf(req, res, "/api/orgs")) return;
      const user = await requireUser(req, res);
      if (!user) return;
      if (!orgStore) return send(res, 503, { error: "org store not configured" });
      try {
        const raw = await readBody(req);
        const body = raw ? (JSON.parse(raw) as { name?: unknown }) : {};
        if (
          typeof body.name !== "string" ||
          body.name.trim().length === 0 ||
          body.name.length > 100
        ) {
          send(res, 400, { error: "name is required (1–100 chars)" });
          return;
        }
        const id = newOrgId();
        const now = Date.now();
        await orgStore.insert({ id, name: body.name.trim(), createdAt: now });
        await userStore.setMembership({ userId: user.id, orgId: id, role: "owner" });
        await orgStore.audit({
          orgId: id,
          actorId: user.id,
          action: "org.create",
          subject: id,
          ...requestOrigin(req),
          metadata: { name: body.name.trim() },
          at: now,
        });
        send(res, 201, { id, name: body.name.trim(), role: "owner", createdAt: now });
      } catch (err) {
        send(res, 400, { error: "bad request", detail: (err as Error).message });
      }
      return;
    }
    // M2.3: read an org. Any member can fetch; this is the surface the admin
    // console hits. Refuses with 404 (not 403) so an org id is unguessable
    // to non-members — same rule `GET /api/boards/:id` already follows.
    if (
      req.method === "GET" &&
      req.url?.startsWith("/api/orgs/") &&
      !req.url.includes("/members") &&
      !req.url.includes("/invites") &&
      !req.url.includes("/audit") &&
      !req.url.includes("/billing") &&
      !req.url.includes("/templates") &&
      !req.url.includes("/analytics")
    ) {
      const id = req.url.slice("/api/orgs/".length).split("?")[0]!;
      const guard = await requireOrgRole(req, res, id, "viewer", "/api/orgs/:id");
      if (!guard.ok) return;
      if (!orgStore) return send(res, 503, { error: "org store not configured" });
      const org = await orgStore.get(id);
      if (!org) {
        // requireOrgRole already 404s on no-membership; reaching here with no
        // row means a race (org deleted between the membership check and now).
        send(res, 404, { error: "org not found" });
        return;
      }
      // Members joined to users via `membersOf`. The route mirrors the
      // board-members shape so the admin console can render the same way.
      const rawMembers = await orgStore.membersOf(id);
      const members = rawMembers.map((m) => ({
        userId: m.userId,
        role: m.role,
        email: m.email,
        name: m.name,
      }));
      const callerRole = guard.role;
      send(res, 200, {
        id: org.id,
        name: org.name,
        createdAt: org.createdAt,
        members,
        role: callerRole,
      });
      return;
    }
    // M2.3: rename an org. Owner-only.
    if (
      req.method === "PATCH" &&
      req.url?.startsWith("/api/orgs/") &&
      !req.url.includes("/members") &&
      !req.url.includes("/invites") &&
      !req.url.includes("/audit") &&
      !req.url.includes("/billing")
    ) {
      if (!requireCsrf(req, res, "/api/orgs/:id")) return;
      const id = req.url.slice("/api/orgs/".length).split("?")[0]!;
      const guard = await requireOrgRole(req, res, id, "owner", "/api/orgs/:id");
      if (!guard.ok) return;
      if (!orgStore) return send(res, 503, { error: "org store not configured" });
      try {
        const raw = await readBody(req);
        const body = raw ? (JSON.parse(raw) as { name?: unknown }) : {};
        if (
          typeof body.name !== "string" ||
          body.name.trim().length === 0 ||
          body.name.length > 100
        ) {
          send(res, 400, { error: "name is required (1–100 chars)" });
          return;
        }
        await orgStore.rename(id, body.name.trim());
        await orgStore.audit({
          orgId: id,
          actorId: guard.user.id,
          action: "org.rename",
          subject: id,
          ...requestOrigin(req),
          metadata: { name: body.name.trim() },
          at: Date.now(),
        });
        send(res, 200, { id, name: body.name.trim() });
      } catch (err) {
        send(res, 400, { error: "bad request", detail: (err as Error).message });
      }
      return;
    }
    // M2.3: delete an org. Owner-only. Refuses on personal orgs (those are
    // tied to the user account) and on orgs with live boards.
    if (
      req.method === "DELETE" &&
      req.url?.startsWith("/api/orgs/") &&
      !req.url.includes("/members") &&
      !req.url.includes("/invites") &&
      !req.url.includes("/audit") &&
      !req.url.includes("/billing") &&
      !req.url.includes("/templates")
    ) {
      if (!requireCsrf(req, res, "/api/orgs/:id")) return;
      const id = req.url.slice("/api/orgs/".length).split("?")[0]!;
      const user = await requireUser(req, res);
      if (!user) return;
      if (id === `org_personal_${user.id}`) {
        send(res, 400, { error: "cannot delete your personal org" });
        return;
      }
      const guard = await requireOrgRole(req, res, id, "owner", "/api/orgs/:id");
      if (!guard.ok) return;
      if (!orgStore) return send(res, 503, { error: "org store not configured" });
      // `countForOrg`, not `listForOrg(id).length`: the guard needs a number, and
      // the list pulls every board row -- workspace JSON included -- to discard it.
      if ((await boardStore.countForOrg(id)) > 0) {
        send(res, 409, { error: "org has live boards; delete them first" });
        return;
      }
      // The audit row goes in before the delete, not after. `auditLog.orgId`
      // references `organizations.id` with `onDelete: "cascade"`
      // (db/schema.ts), so writing afterwards was a foreign-key violation past
      // the point of no return: in Postgres the org was already gone and the
      // route answered 500, while the in-memory store silently kept a row that
      // `auditFor` could never return because its org no longer existed.
      //
      // The cascade itself is right -- an org is deleted so that its data stops
      // existing, and a surviving trail of a deleted tenant defeats that. So the
      // durable record of the deletion is the log line, which lives in the log
      // pipeline rather than in the table that just went away.
      const origin = requestOrigin(req);
      await orgStore.audit({
        orgId: id,
        actorId: user.id,
        action: "org.delete",
        subject: id,
        ...origin,
        metadata: {},
        at: Date.now(),
      });
      logger.info("org_deleted", { orgId: id, actorId: user.id, ip: origin.ip });
      await orgStore.delete(id);
      send(res, 204, {});
      return;
    }
    // M2.6: org-scoped template library (team libraries). Editors and above
    // can list and apply; only owners can add or remove. The route is
    // scoped by `orgId` from the URL — same guard as `/api/boards/:id` —
    // so a guessed template id in another org answers undefined / 404, never
    // the row.
    //
    // The unconfigured path answers 503 (same convention as notifications
    // and usageStore): a route that depends on a missing store should fail
    // loud rather than serve a half-true answer.
    const templatesSubpath = (() => {
      if (!req.url?.startsWith("/api/orgs/")) return undefined;
      const path = req.url.split("?")[0] ?? "";
      // Match `/api/orgs/<orgId>/templates` or `/api/orgs/<orgId>/templates/<id>`.
      const m = /^\/api\/orgs\/([^/]+)\/templates(?:\/([^/]+))?$/.exec(path);
      if (!m) return undefined;
      return { orgId: m[1]!, templateId: m[2] };
    })();
    if (templatesSubpath) {
      const guard = await requireOrgRole(
        req,
        res,
        templatesSubpath.orgId,
        req.method === "GET" ? "viewer" : "editor",
        "/api/orgs/:id/templates",
      );
      if (!guard.ok) return;
      if (!teamTemplates) {
        send(res, 503, { error: "team libraries are not configured" });
        return;
      }
      const { orgId, templateId } = templatesSubpath;

      if (req.method === "GET" && !templateId) {
        const list = await teamTemplates.listForOrg(orgId);
        send(res, 200, { templates: list });
        return;
      }
      if (req.method === "GET" && templateId) {
        const row = await teamTemplates.get(orgId, templateId);
        if (!row) {
          send(res, 404, { error: "template not found" });
          return;
        }
        send(res, 200, row);
        return;
      }
      // Mutations: editor or above; the role guard above already returned
      // false if the caller is only a viewer, so by the time we reach
      // here the caller has edit rights on the org.
      if (req.method === "POST" && !templateId) {
        if (!requireCsrf(req, res, "/api/orgs/:id/templates")) return;
        try {
          const raw = await readBody(req);
          const body = raw ? JSON.parse(raw) : {};
          // Validate by importing the helper inline so we can also reuse it
          // in the test suite without a circular dep on this file.
          const { validateNewTeamTemplate } = await import("./teamTemplates.js");
          const errors = validateNewTeamTemplate(body);
          if (errors.length > 0) {
            send(res, 400, { error: "invalid template", detail: errors.join("; ") });
            return;
          }
          // `body` has been structurally validated; cast through the shape
          // the helper accepts.
          const inserted = await teamTemplates.insert(
            {
              orgId,
              name: (body as { name: string }).name,
              kind: (body as { kind: string }).kind,
              description: (body as { description?: string | null }).description ?? null,
              ops: (body as { ops: import("@lucent/core").Operation[] }).ops,
              createdAt: Date.now(),
            },
            guard.user.id,
          );
          send(res, 201, inserted);
        } catch (err) {
          send(res, 400, { error: "bad request", detail: (err as Error).message });
        }
        return;
      }
      if (req.method === "DELETE" && templateId) {
        if (!requireCsrf(req, res, "/api/orgs/:id/templates")) return;
        const removed = await teamTemplates.remove(orgId, templateId);
        send(res, removed ? 204 : 404, removed ? {} : { error: "template not found" });
        return;
      }
      send(res, 405, { error: "method not allowed" });
      return;
    }
    // M2.6 + F1: read the audit log. Owner-only. Keyset-paginated (the store
    // plumbing existed; the route's fixed 100 was the bug — an org with a
    // week of traffic could not page past the newest page), and CSV-exported
    // when `?format=csv`: the format an enterprise buyer imports into their
    // own SIEM is the format the F1 item asked for.
    if (req.method === "GET" && /^\/api\/orgs\/[^/]+\/audit(\?.*)?$/.test(req.url ?? "")) {
      const url = req.url!;
      const orgId = url.split("?")[0]!.split("/")[3]!;
      const guard = await requireOrgRole(req, res, orgId, "owner", "/api/orgs/:id/audit");
      if (!guard.ok) return;
      if (!orgStore) return send(res, 200, { entries: [], nextCursor: null });

      const params = new URLSearchParams(url.split("?")[1] ?? "");
      // Keyset cursor: opaque to the client, structured in the store. A
      // missing/garbage cursor means "newest first".
      const cursorAt = Number(params.get("cursorAt"));
      const cursorId = params.get("cursorId");
      const cursor =
        Number.isFinite(cursorAt) && cursorAt > 0 && cursorId
          ? { at: cursorAt, id: cursorId }
          : undefined;
      const limit = Math.min(Math.max(1, Number(params.get("limit")) || 100), 200);

      const entries = await orgStore.auditFor(orgId, limit, cursor);

      if (params.get("format") === "csv") {
        // Attachment export: one row per entry, the columns the SIEM wants,
        // escaping per RFC 4180 (quote anything with a comma/quote/newline).
        const header = "id,at,actor_id,actor_email,action,target_type,target_id,ip";
        const rows = entries.map((e) =>
          [
            e.id,
            e.at,
            e.actorId ?? "",
            e.actorEmail ?? "",
            e.action,
            e.targetType ?? "",
            e.targetId ?? "",
            e.ip ?? "",
          ]
            .map(csvCell)
            .join(","),
        );
        const body = [header, ...rows].join("\r\n") + "\r\n";
        // Raw, not via `sendWithHeaders`: that helper JSON-stringifies, and
        // an attachment whose content-type says text/csv but whose body is a
        // JSON-quoted string is a file no spreadsheet opens.
        res.writeHead(200, {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="lucent-audit-${orgId}.csv"`,
        });
        res.end(body);
        return;
      }

      // The next page's cursor: the last row this page produced. Null when
      // the page is short — the client reads "no more" without a probe.
      const last = entries.length === limit ? entries[entries.length - 1] : undefined;
      send(res, 200, {
        entries,
        nextCursor: last ? { at: last.at, id: last.id } : null,
      });
      return;
    }
    // --- M4.3: Stripe billing routes --------------------------------------
    //
    // The webhook first, and deliberately before anything that could reject a
    // request for lacking a session: Stripe has no cookie, no CSRF token and
    // no bearer token — its authentication *is* the signature on the raw body,
    // verified inside `receive`. No `requireCsrf`, no `requireUser`, no
    // `meter`: this endpoint's caller is not a user, and the ledger's claim
    // protocol is its own rate limit.
    if (req.method === "POST" && req.url?.split("?")[0] === "/api/billing/webhook") {
      if (!webhookReceiver) {
        send(res, 503, { error: "billing is not configured" });
        return;
      }
      let payload: string;
      try {
        payload = await readBody(req);
      } catch (err) {
        send(res, 400, { error: "bad request", detail: (err as Error).message });
        return;
      }
      const result = await webhookReceiver.receive({
        payload,
        signature: req.headers["stripe-signature"],
      });
      send(res, result.status, result.body);
      return;
    }

    // Checkout and portal. Owner-only: both create Stripe objects billed to
    // the org, and the viewer-visible billing surface (`GET /api/orgs/:id/
    // billing`) already made the point that reading is wider than writing.
    // CSRF applies — the caller is a cookie-bearing browser session.
    if (req.method === "POST" && req.url === "/api/billing/checkout") {
      if (!billing || !usageStore) {
        send(res, 503, { error: "billing is not configured" });
        return;
      }
      if (!requireCsrf(req, res, "/api/billing/checkout")) return;
      let body: {
        orgId?: unknown;
        planCode?: unknown;
        interval?: unknown;
        seats?: unknown;
      } = {};
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        // An unreadable body falls through to the field checks below, which
        // answer 400 with the missing field named rather than a parse error.
      }
      const guard = await requireOrgRole(
        req,
        res,
        typeof body.orgId === "string" ? body.orgId : undefined,
        "owner",
        "/api/billing/checkout",
      );
      if (!guard.ok) return;
      if (typeof body.planCode !== "string" || body.planCode.length === 0) {
        send(res, 400, { error: "planCode is required" });
        return;
      }
      if (
        body.interval !== undefined &&
        body.interval !== "monthly" &&
        body.interval !== "annual"
      ) {
        send(res, 400, { error: 'interval must be "monthly" or "annual"' });
        return;
      }
      if (
        body.seats !== undefined &&
        (typeof body.seats !== "number" ||
          !Number.isInteger(body.seats) ||
          body.seats < 1 ||
          body.seats > 999)
      ) {
        send(res, 400, { error: "seats must be an integer between 1 and 999" });
        return;
      }
      const email =
        typeof guard.user.email === "string" && guard.user.email.length > 0
          ? guard.user.email
          : null;
      let outcome;
      try {
        outcome = await startCheckout(
          { client: billing.client, usageStore },
          {
            orgId: body.orgId as string,
            planCode: body.planCode,
            ...(body.interval !== undefined ? { interval: body.interval } : {}),
            ...(body.seats !== undefined ? { seats: body.seats } : {}),
            email,
            orgName: null,
          },
          config.webOrigin,
          Date.now(),
        );
      } catch (err) {
        // A Stripe REST failure inside the customer-resolution path (the
        // service only guards its own session call). 502: our configuration
        // reached for Stripe and Stripe said no.
        send(res, 502, { error: err instanceof Error ? err.message : "stripe request failed" });
        return;
      }
      if (outcome.ok) {
        await orgStore?.audit({
          orgId: body.orgId as string,
          actorId: guard.user.id,
          action: "billing.checkout",
          subject: body.orgId as string,
          ...requestOrigin(req),
          metadata: { planCode: body.planCode, interval: body.interval ?? "monthly" },
          at: Date.now(),
        });
        send(res, 200, { url: outcome.url });
        return;
      }
      send(res, outcome.status, { error: outcome.error });
      return;
    }

    if (req.method === "POST" && req.url === "/api/billing/portal") {
      if (!billing || !usageStore) {
        send(res, 503, { error: "billing is not configured" });
        return;
      }
      if (!requireCsrf(req, res, "/api/billing/portal")) return;
      let body: { orgId?: unknown } = {};
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        // Same as checkout: the guard below names the missing field.
      }
      const guard = await requireOrgRole(
        req,
        res,
        typeof body.orgId === "string" ? body.orgId : undefined,
        "owner",
        "/api/billing/portal",
      );
      if (!guard.ok) return;
      let outcome;
      try {
        outcome = await openPortal(
          { client: billing.client, usageStore },
          body.orgId as string,
          config.webOrigin,
          Date.now(),
        );
      } catch (err) {
        send(res, 502, { error: err instanceof Error ? err.message : "stripe request failed" });
        return;
      }
      if (outcome.ok) {
        await orgStore?.audit({
          orgId: body.orgId as string,
          actorId: guard.user.id,
          action: "billing.portal",
          subject: body.orgId as string,
          ...requestOrigin(req),
          at: Date.now(),
        });
        send(res, 200, { url: outcome.url });
        return;
      }
      send(res, outcome.status, { error: outcome.error });
      return;
    }

    // M4: the billing surface. What the org is on, what it has spent this month
    // and where its ceilings are -- in one response, because the settings pane
    // needs all three to draw a single row and three round-trips would render it
    // three times, each with a different idea of "now".
    //
    // Viewer, not owner: the member about to hit a limit is usually not the member
    // holding the card, and they still need to see how close they are. Nothing
    // here is a capability -- no Stripe ids, no portal link, no invoice -- which
    // is what makes the wider audience safe. The portal route, when it lands,
    // stays owner-only.
    if (
      req.method === "GET" &&
      req.url?.startsWith("/api/orgs/") &&
      req.url.split("?")[0]!.endsWith("/billing")
    ) {
      const orgId = req.url.split("?")[0]!.split("/")[3]!;
      const guard = await requireOrgRole(req, res, orgId, "viewer", "/api/orgs/:id/billing");
      if (!guard.ok) return;
      // Unconfigured billing says so, rather than reporting a confident Free
      // plan. Everywhere else in this file a missing store means the gate opens;
      // here it would mean rendering limits nobody enforces, which is worse than
      // rendering nothing.
      if (!entitlements || !usageStore) {
        send(res, 503, { error: "billing is not configured" });
        return;
      }
      const now = Date.now();
      const period = monthWindow(now);
      const [plan, totals, boardCount, seatCount] = await Promise.all([
        entitlements.plan(orgId),
        usageStore.totalsByKind(orgId, period),
        boardStore.countForOrg(orgId),
        userStore.countMembers(orgId),
      ]);
      // Seven explicit reads instead of a loop over ENTITLEMENT_KEYS: the
      // signature resolves its return type from the literal key, so a union key
      // collapses `NumericEntitlement | SetEntitlement` back into something
      // nothing can index without a cast. Seven lines is the cheaper honesty.
      const [ai, voice, boards, seats, storage, history, formats] = await Promise.all([
        entitlements.entitlement(orgId, "ai.generationsPerMonth"),
        entitlements.entitlement(orgId, "voice.minutes"),
        entitlements.entitlement(orgId, "boards"),
        entitlements.entitlement(orgId, "seats"),
        entitlements.entitlement(orgId, "storage.bytes"),
        entitlements.entitlement(orgId, "history.depth"),
        entitlements.entitlement(orgId, "export.formats"),
      ]);
      // `remaining` is computed here rather than in the client, because
      // "unlimited" and "nothing left" are one null apart and a UI that confuses
      // them shows a paying customer a paywall.
      const row = (key: NumericEntitlementKey, limit: number | null, used: number | null) => ({
        key,
        label: ENTITLEMENTS[key].label,
        period: ENTITLEMENTS[key].period,
        limit,
        used,
        unlimited: limit === null,
        remaining: limit === null || used === null ? null : Math.max(0, limit - used),
      });
      send(res, 200, {
        orgId,
        plan: {
          code: plan.code,
          name: plan.displayName,
          status: plan.status,
          seats: plan.seats,
          // `fallback` is the difference between "you are on Free" and "your
          // card failed and you are being treated as Free". The pane must not
          // flatten those two into the same sentence.
          fallback: plan.fallback,
          periodEnd: plan.periodEnd,
        },
        period,
        upgradeUrl: DEFAULT_UPGRADE_URL,
        limits: [
          row(
            "ai.generationsPerMonth",
            ai.limit,
            totals[METERED_KEYS["ai.generationsPerMonth"]] ?? 0,
          ),
          row("voice.minutes", voice.limit, totals[METERED_KEYS["voice.minutes"]] ?? 0),
          row("boards", boards.limit, boardCount),
          row("seats", seats.limit, seatCount),
          row("storage.bytes", storage.limit, totals["storage.bytes"] ?? 0),
          // History depth is per board, not per org, so there is no org total to
          // compare the ceiling against. Reported with a null usage rather than a
          // zero that would read as "you have used none of it".
          row("history.depth", history.limit, null),
        ],
        exportFormats: {
          key: "export.formats",
          label: ENTITLEMENTS["export.formats"].label,
          allowed: formats.formats,
          all: EXPORT_FORMATS,
        },
      });
      return;
    }

    // G1: the public template catalog. Anonymous by design — it is the one
    // API surface the marketing site and the MCP server may render, and
    // metadata-only by design (the ops are minted client-side with per-insert
    // ids; see publicTemplates.ts). No auth, no CSRF, no rate limit beyond
    // the global one: an anonymous list of template names leaks nothing.
    if (req.method === "GET" && (req.url === "/api/templates" || req.url === "/api/templates/")) {
      send(res, 200, { templates: PUBLIC_TEMPLATES });
      return;
    }

    // M7: Analytics trend. Owner-visible, mirrors the entitlement numbers
    // the dashboard renders so the chart cannot disagree with the paywall.
    // Fails open with `{ rows: [] }` when there is no usage store — older
    // deployments still render the meters (which come from `/api/orgs/:id/billing`).
    // M7: Analytics trend. Owner-visible, mirrors the entitlement numbers
    // the dashboard renders so the chart cannot disagree with the paywall.
    // Fails open with `{ rows: [] }` when there is no usage store — older
    // deployments still render the meters (which come from `/api/orgs/:id/billing`).
    {
      const path = (req.url ?? "").split("?")[0] ?? "";
      if (req.method === "GET" && /^\/api\/analytics\/[^/]+\/trend$/.test(path)) {
        const orgId = path.split("/")[3]!;
        const guard = await requireOrgRole(req, res, orgId, "owner", "/api/analytics/:orgId/trend");
        if (!guard.ok) return;
        const params = new URLSearchParams((req.url ?? "").split("?")[1] ?? "");
        const kind = params.get("kind") ?? "";
        const daysRaw = Number(params.get("days") ?? "30");
        const days =
          Number.isFinite(daysRaw) && daysRaw >= 1 && daysRaw <= 90 ? Math.floor(daysRaw) : 30;
        if (kind.length === 0) {
          send(res, 400, { error: "kind required" });
          return;
        }
        if (!usageStore) {
          send(res, 200, { rows: [] });
          return;
        }
        // The trend reader lives on the usage store (`rollups(orgId, fromDay, toDay)`).
        // Compute the day keys in UTC; the rollup table stores its `day` column as
        // `YYYY-MM-DD` strings (usageStore.ts:dayKey) so a string range scan reads
        // them lexicographically without an extra parse step.
        const today = new Date();
        const fromDay = formatDay(today, -days + 1);
        const toDay = formatDay(today, 0);
        const rollups = await usageStore.rollups(orgId, fromDay, toDay);
        const rows = rollups
          .filter((r) => r.kind === kind)
          .map((r) => ({ day: r.day, kind: r.kind, count: r.quantity }))
          .sort((a, b) => (a.day < b.day ? -1 : 1));
        send(res, 200, { rows });
        return;
      }
    }

    // --- Auth routes (always open) ---
    if (req.method === "GET" && req.url === "/api/auth/csrf") {
      // M1.2: mint a CSRF token. Browsers read the cookie; the body carries
      // the value the client must echo as X-CSRF-Token on state-changing
      // requests. Safe to call repeatedly — old cookies are replaced.
      const m = mintCsrf({ secret, allowedOrigins: [config.webOrigin] });
      const headers = { "set-cookie": m.cookie };
      // M1.8: which providers are fully configured. The AuthView renders one
      // button per entry; an unconfigured provider never renders as a button
      // that dead-ends at a 503.
      const oauth = {
        google: providerConfigured(config.oauth, "google"),
        github: providerConfigured(config.oauth, "github"),
      };
      res.writeHead(200, {
        "content-type": "application/json",
        "access-control-allow-origin": config.webOrigin,
        "access-control-allow-credentials": "true",
        ...headers,
      });
      res.end(JSON.stringify({ token: m.token, oauth }));
      return;
    }

    // --- M1.8: federated sign-in (Google / GitHub) -------------------------
    // Two GETs: /start sends the browser to the provider, /callback turns the
    // returned code into a session. Both are open routes (the caller is, by
    // definition, not authenticated yet) and both redirect rather than send
    // JSON: the client is a top-level browser navigation, not an API call.
    if (req.method === "GET" && req.url?.startsWith("/api/auth/oauth/")) {
      await handleOauth(req, res);
      return;
    }

    if (req.method === "POST" && req.url === "/api/auth/signup") {
      try {
        const raw = await readBody(req);
        const parsed = raw ? JSON.parse(raw) : {};
        const email = typeof parsed.email === "string" ? parsed.email : "";
        if (!applyAuthLimiter(req, res, email, "/api/auth/signup")) return;
        const result = await handleSignup(authCtx, parsed, orgStore, requestOrigin(req));
        writeHandleResult(res, result);
      } catch (err) {
        send(res, 400, { error: "bad request", detail: (err as Error).message });
      }
      return;
    }
    if (req.method === "POST" && req.url === "/api/auth/login") {
      try {
        const raw = await readBody(req);
        const parsed = raw ? JSON.parse(raw) : {};
        const email = typeof parsed.email === "string" ? parsed.email : "";
        if (!applyAuthLimiter(req, res, email, "/api/auth/login")) return;
        const result = await handleLogin(authCtx, parsed, requestOrigin(req));
        writeHandleResult(res, result);
      } catch (err) {
        send(res, 400, { error: "bad request", detail: (err as Error).message });
      }
      return;
    }
    // M1.7 profile update.
    if (req.method === "PATCH" && req.url === "/api/auth/profile") {
      if (!requireCsrf(req, res, "/api/auth/profile")) return;
      try {
        const raw = await readBody(req);
        const parsed = raw ? JSON.parse(raw) : {};
        const result = await handleUpdateProfile(
          authCtx,
          parsed,
          req.headers.cookie ?? null,
          bearerToken(req.headers.authorization),
        );
        writeHandleResult(res, result);
      } catch (err) {
        send(res, 400, { error: "bad request", detail: (err as Error).message });
      }
      return;
    }
    // M1.7 account export.
    if (req.method === "GET" && req.url === "/api/account/export") {
      const result = await handleAccountExport(
        authCtx,
        async (userId) => {
          // M2.1: a board can live in any org the user is a member of, so the
          // export walks every membership rather than asking the store for "all
          // boards this user can reach" — the store is now tenant-scoped.
          //
          // Privacy: `listForUser` (membership-scoped) is what walks the caller's
          // own grants; `listForOrg` would include every board in each org the
          // caller is in, including boards owned by other members they have no
          // `board_members` row for. The earlier export walked `listForOrg` and
          // shipped every other member's workspace to the caller — a clear data
          // leak closed here.
          const memberships = await userStore.membershipsFor(userId);
          const out: Array<{
            id: string;
            name: string;
            workspace: unknown;
            createdAt: number;
            updatedAt: number;
          }> = [];
          for (const m of memberships) {
            const boards = await boardStore.listForUser(m.orgId, userId);
            for (const b of boards) {
              out.push({
                id: b.id,
                name: b.name,
                workspace: b.workspace,
                createdAt: b.createdAt,
                updatedAt: b.updatedAt,
              });
            }
          }
          return out;
        },
        req.headers.cookie ?? null,
        bearerToken(req.headers.authorization),
      );
      send(res, result.status, result.body);
      return;
    }
    // M1.7 deletion schedule (7-day grace) + cancel.
    if (req.method === "POST" && req.url === "/api/account/delete") {
      if (!requireCsrf(req, res, "/api/account/delete")) return;
      // Rate limit per IP. The authLimiter's per-IP+email key is right for
      // login/signup (where an email is in the body) but here the request is
      // cookie-authenticated and the only stable key is the IP. A 429 stops
      // an attacker from hammering the schedule endpoint to flip the grace
      // window or racing the cancel endpoint.
      if (!applyAccountLimiter(req, res, "/api/account/delete")) return;
      const result = await handleScheduleDeletion(
        authCtx,
        req.headers.cookie ?? null,
        bearerToken(req.headers.authorization),
      );
      writeHandleResult(res, result);
      return;
    }
    if (req.method === "POST" && req.url === "/api/account/delete/cancel") {
      if (!requireCsrf(req, res, "/api/account/delete/cancel")) return;
      if (!applyAccountLimiter(req, res, "/api/account/delete/cancel")) return;
      const result = await handleCancelDeletion(
        authCtx,
        req.headers.cookie ?? null,
        bearerToken(req.headers.authorization),
      );
      writeHandleResult(res, result);
      return;
    }
    // M1.6: complete a 2FA-protected login by exchanging the login token
    // returned by /api/auth/login for a session cookie + bearer token.
    if (req.method === "POST" && req.url === "/api/auth/2fa/verify") {
      try {
        const raw = await readBody(req);
        const parsed = raw ? JSON.parse(raw) : {};
        const result = await handleVerifyTwoFactorLogin(
          authCtx,
          parsed,
          req.headers.cookie ?? null,
          requestOrigin(req),
        );
        writeHandleResult(res, result);
      } catch (err) {
        send(res, 400, { error: "bad request", detail: (err as Error).message });
      }
      return;
    }
    // M1.6: TOTP enrollment.
    if (req.method === "POST" && req.url === "/api/auth/2fa/enroll") {
      if (!requireCsrf(req, res, "/api/auth/2fa/enroll")) return;
      const result = await handleBeginTotpEnrollment(
        authCtx,
        req.headers.cookie ?? null,
        bearerToken(req.headers.authorization),
      );
      writeHandleResult(res, result);
      return;
    }
    if (req.method === "POST" && req.url === "/api/auth/2fa/enroll/confirm") {
      if (!requireCsrf(req, res, "/api/auth/2fa/enroll/confirm")) return;
      try {
        const raw = await readBody(req);
        const parsed = raw ? JSON.parse(raw) : {};
        const result = await handleConfirmTotpEnrollment(
          authCtx,
          parsed,
          req.headers.cookie ?? null,
          bearerToken(req.headers.authorization),
        );
        writeHandleResult(res, result);
      } catch (err) {
        send(res, 400, { error: "bad request", detail: (err as Error).message });
      }
      return;
    }
    if (req.method === "POST" && req.url === "/api/auth/2fa/disable") {
      if (!requireCsrf(req, res, "/api/auth/2fa/disable")) return;
      try {
        const raw = await readBody(req);
        const parsed = raw ? JSON.parse(raw) : {};
        const result = await handleDisableTotp(
          authCtx,
          parsed,
          req.headers.cookie ?? null,
          bearerToken(req.headers.authorization),
        );
        writeHandleResult(res, result);
      } catch (err) {
        send(res, 400, { error: "bad request", detail: (err as Error).message });
      }
      return;
    }
    if (req.method === "GET" && req.url === "/api/auth/me") {
      const result = await handleMe(
        authCtx,
        req.headers.cookie ?? null,
        bearerToken(req.headers.authorization),
      );
      send(res, result.status, result.body);
      return;
    }
    if (req.method === "POST" && req.url === "/api/auth/logout") {
      if (!requireCsrf(req, res, "/api/auth/logout")) return;
      const result = await handleLogout(authCtx, req.headers.cookie ?? null);
      writeHandleResult(res, result);
      return;
    }
    // M1.4 verification: request a verification email for {email}. Always
    // returns 204 to avoid an account-oracle leak.
    if (req.method === "POST" && req.url === "/api/auth/verify/request") {
      try {
        const raw = await readBody(req);
        const parsed = raw ? JSON.parse(raw) : {};
        const email = typeof parsed.email === "string" ? parsed.email : "";
        if (!applyMailLimiter(req, res, email, "/api/auth/verify/request")) return;
        const result = await handleRequestVerification(authCtx, parsed);
        writeHandleResult(res, result);
      } catch (err) {
        send(res, 400, { error: "bad request", detail: (err as Error).message });
      }
      return;
    }
    // M1.4 verification: redeem a token from the email link. Body carries
    // `{token}`; the response is the public user.
    if (req.method === "POST" && req.url === "/api/auth/verify/confirm") {
      try {
        const raw = await readBody(req);
        const parsed = raw ? JSON.parse(raw) : {};
        const result = await handleVerifyEmail(
          authCtx,
          typeof parsed.token === "string" ? parsed.token : undefined,
        );
        writeHandleResult(res, result);
      } catch (err) {
        send(res, 400, { error: "bad request", detail: (err as Error).message });
      }
      return;
    }
    // M1.4 password reset: request a reset email. Always 204 for the same
    // reason as verification — a typo and a real address look the same.
    if (req.method === "POST" && req.url === "/api/auth/reset/request") {
      try {
        const raw = await readBody(req);
        const parsed = raw ? JSON.parse(raw) : {};
        const email = typeof parsed.email === "string" ? parsed.email : "";
        if (!applyMailLimiter(req, res, email, "/api/auth/reset/request")) return;
        const result = await handleRequestPasswordReset(authCtx, parsed);
        writeHandleResult(res, result);
      } catch (err) {
        send(res, 400, { error: "bad request", detail: (err as Error).message });
      }
      return;
    }
    // M1.4 password reset: redeem a token + new password.
    if (req.method === "POST" && req.url === "/api/auth/reset/confirm") {
      try {
        const raw = await readBody(req);
        const parsed = raw ? JSON.parse(raw) : {};
        const result = await handleResetPassword(
          authCtx,
          typeof parsed.token === "string" ? parsed.token : undefined,
          typeof parsed.password === "string" ? parsed.password : undefined,
        );
        writeHandleResult(res, result);
      } catch (err) {
        send(res, 400, { error: "bad request", detail: (err as Error).message });
      }
      return;
    }
    if (req.method === "POST" && req.url === "/api/auth/signout-all") {
      if (!requireCsrf(req, res, "/api/auth/signout-all")) return;
      const result = await handleSignoutAll(
        authCtx,
        req.headers.cookie ?? null,
        bearerToken(req.headers.authorization),
      );
      writeHandleResult(res, result);
      return;
    }
    if (req.method === "GET" && req.url === "/api/auth/sessions") {
      const result = await handleListSessions(
        authCtx,
        req.headers.cookie ?? null,
        bearerToken(req.headers.authorization),
      );
      send(res, result.status, result.body);
      return;
    }
    // DELETE /api/auth/sessions/:id — revoke one session by id.
    const sessionsMatch = /^\/api\/auth\/sessions\/([A-Za-z0-9_-]+)$/.exec(req.url ?? "");
    if (req.method === "DELETE" && sessionsMatch) {
      // CSRF: a state-changing cookie-authenticated route must echo the
      // double-submit token. Bearer-authenticated callers (programmatic, MCP)
      // are exempt because they have no session cookie to forge from. The
      // CSRF helper already short-circuits when no session cookie is present,
      // so this is a one-line addition that closes the gap without affecting
      // programmatic clients.
      if (!requireCsrf(req, res, "/api/auth/sessions/:id")) return;
      const result = await handleRevokeSession(
        authCtx,
        sessionsMatch[1]!,
        req.headers.cookie ?? null,
        bearerToken(req.headers.authorization),
      );
      writeHandleResult(res, result);
      return;
    }

    // M0.3: mint a one-shot, 60s ticket the client can hand to the WS upgrade.
    // Cookie or bearer auth both work; cookies are how M1's session layer will
    // wire this, but bearer tokens keep the route useful for the MCP client
    // and programmatic API keys.
    if (req.method === "POST" && req.url === "/api/realtime/ticket") {
      if (!requireCsrf(req, res, "/api/realtime/ticket")) return;
      const user = await requireUser(req, res);
      if (!user) return;
      const ticket = tickets.mint(user.id);
      send(res, 200, { ticket, ttlMs: config.realtimeTicketTtlMs });
      return;
    }

    // M5/E3: LiveKit access tokens — the route the web client already
    // implements the calling side of (stt/livekit.ts `fetchToken` POSTs its
    // tokenUrl and expects `{ token, url? }`). Per-room, per-user, short-lived;
    // the API secret never leaves this branch. 503 when unconfigured, the
    // same fail-open shape as billing: a deployment with no LiveKit falls
    // back to on-device STT and the route is simply absent.
    //
    // No voice-minute metering here on purpose: `voice.minutes` meters hosted
    // transcription actually consumed, and the only honest place to record
    // that is where STT segments arrive, not where a token is minted (a minted
    // token can go entirely unused). Metering the mint would bill every
    // aborted click of the mic button.
    if (req.method === "POST" && req.url === "/api/livekit/token") {
      if (!requireCsrf(req, res, "/api/livekit/token")) return;
      const user = await requireUser(req, res);
      if (!user) return;
      const { apiKey, apiSecret, url } = config.livekit;
      if (!apiKey || !apiSecret || !url) {
        send(res, 503, { error: "LiveKit is not configured" });
        return;
      }
      let room = "lucent-voice";
      try {
        const raw = await readBody(req);
        const body = raw ? (JSON.parse(raw) as { room?: unknown }) : {};
        // Room names are scoped per board so presence (and the transcript's
        // speaker set) never crosses boards; the client may omit the room and
        // get the default.
        if (typeof body.room === "string" && body.room.trim().length > 0) {
          room = body.room.trim().slice(0, 128);
        }
      } catch {
        // An unreadable body keeps the default room — the client contract
        // sends JSON, but a missing body is not worth failing a mic click on.
      }
      const minted = mintLiveKitToken({
        config: { apiKey, apiSecret, url },
        room,
        identity: user.id,
        name: user.name,
      });
      send(res, 200, {
        token: minted.token,
        url: minted.url,
        expiresAt: minted.expiresAt,
      });
      return;
    }

    // --- Board storage (auth required: boards belong to a user) ---
    if (req.method === "POST" && req.url === "/api/boards") {
      if (!requireCsrf(req, res, "/api/boards")) return;
      const user = await requireUser(req, res);
      if (!user) return;
      try {
        const raw = await readBody(req);
        const body = raw
          ? (JSON.parse(raw) as { id?: string; orgId?: string; name?: string; workspace?: unknown })
          : {};
        // M2.1: every board lives in an org the user is a member of. The
        // personal org is the default when none is supplied, so a brand-new
        // user lands without ceremony.
        const requestedOrgId = typeof body.orgId === "string" ? body.orgId : undefined;
        const memberships = await userStore.membershipsFor(user.id);
        const targetOrgId = requestedOrgId ?? memberships[0]?.orgId;
        if (!targetOrgId) {
          send(res, 500, { error: "no personal org on file" });
          return;
        }
        if (requestedOrgId && !memberships.some((m) => m.orgId === requestedOrgId)) {
          send(res, 404, { error: "org not found" });
          return;
        }
        const existing = typeof body.id === "string" ? await boardStore.get(body.id) : undefined;
        // Existence oracle: a board the caller cannot see must answer the
        // same shape whether it does not exist or exists but is not theirs.
        // Otherwise `POST /api/boards {id: "brd_X"}` distinguishes between
        // "no such board" and "board belongs to someone else" and lets a
        // caller enumerate board ids by trial. 404 with `board not found`
        // mirrors the GET path (`app.ts:587`).
        if (existing && existing.ownerId !== user.id) {
          send(res, 404, { error: "board not found" });
          return;
        }
        if (existing && existing.orgId !== targetOrgId) {
          send(res, 400, { error: "cannot move board to a different org" });
          return;
        }
        // M4: the `boards` ceiling, on creation only. An update must never be
        // refused for a limit the org is already over -- that would strand
        // existing work behind a paywall, and a downgrade routinely leaves an org
        // above its new ceiling with boards it must still be able to save.
        if (!existing) {
          const boardCount = await boardStore.countForOrg(targetOrgId);
          if (!(await gateStanding(res, targetOrgId, "boards", boardCount, "/api/boards"))) return;
        }
        const now = Date.now();
        const stored = {
          id: existing?.id ?? newBoardId(),
          orgId: targetOrgId,
          ownerId: existing?.ownerId ?? user.id,
          name:
            typeof body.name === "string" && body.name.trim()
              ? body.name.trim()
              : (existing?.name ?? "Untitled"),
          workspace: emptyWorkspace(""),
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };
        if (body.workspace !== undefined) {
          // Body-size guard first — refuse an oversized blob with 413, which is
          // what load balancers and clients understand. Then validate shape.
          if (raw && raw.length > config.maxWorkspaceBytes) {
            send(res, 413, {
              error: "workspace too large",
              detail: `payload exceeds the ${config.maxWorkspaceBytes}-byte server limit`,
            });
            return;
          }
          const parsed = parseWorkspace(body.workspace);
          if (!parsed.ok) {
            send(res, 400, { error: "invalid workspace", detail: parsed.detail });
            return;
          }
          stored.workspace = parsed.workspace!;
        }
        await boardStore.put(stored);
        send(res, 201, { id: stored.id, name: stored.name, updatedAt: stored.updatedAt });
      } catch (err) {
        send(res, 400, { error: "bad request", detail: (err as Error).message });
      }
      return;
    }

    if (
      req.method === "GET" &&
      (req.url === "/api/boards" ||
        req.url === "/api/boards/" ||
        req.url?.startsWith("/api/boards?"))
    ) {
      // GET /api/boards?orgId=…[&scope=org|shared] — two views over one route,
      // selected by a query parameter the way ?token= narrows DELETE /share.
      //
      //   scope=org (the default) — every board in the tenant. Requires a real
      //     `memberships` row: an org member seeing their org's boards is the
      //     point of an org, and the admin console needs the same view.
      //   scope=shared — only boards the caller owns or holds a `board_members`
      //     row on, via `listForUser`. Deliberately does *not* require org
      //     membership: an outside collaborator who redeemed a share link is
      //     not an org member (and redemption must never make them one — see
      //     the join route), so this is the only listing that can reach them.
      //     It leaks nothing for a non-member, because every row it returns is
      //     one the caller already has a grant on.
      const user = await requireUser(req, res);
      if (!user) return;
      const url = new URL(req.url, "http://localhost");
      const orgId = url.searchParams.get("orgId");
      if (!orgId) {
        send(res, 400, { error: "orgId query parameter required" });
        return;
      }
      const requestedScope = url.searchParams.get("scope");
      if (requestedScope !== null && requestedScope !== "org" && requestedScope !== "shared") {
        send(res, 400, { error: "scope must be org or shared" });
        return;
      }
      const scope = requestedScope ?? "org";
      if (scope === "org") {
        const memberships = await userStore.membershipsFor(user.id);
        if (!memberships.some((m) => m.orgId === orgId)) {
          send(res, 404, { error: "org not found" });
          return;
        }
      }
      const boards =
        scope === "shared"
          ? await boardStore.listForUser(orgId, user.id)
          : await boardStore.listForOrg(orgId);
      send(res, 200, {
        orgId,
        scope,
        boards: boards.map((b) => ({
          id: b.id,
          name: b.name,
          orgId: b.orgId,
          updatedAt: b.updatedAt,
          nodes: Object.keys(b.workspace.nodes).length,
        })),
      });
      return;
    }

    // Redeem a share link. Idempotent: joining twice keeps the existing role
    // rather than downgrading someone who already has a stronger grant.
    if (req.method === "POST" && req.url?.startsWith("/api/boards/") && req.url.endsWith("/join")) {
      if (!requireCsrf(req, res, "/api/boards/:id/join")) return;
      const user = await requireUser(req, res);
      if (!user) return;
      const id = req.url.slice("/api/boards/".length, -"/join".length);
      try {
        const raw = await readBody(req);
        const body = raw ? (JSON.parse(raw) as { token?: unknown }) : {};
        if (typeof body.token !== "string" || body.token.length === 0) {
          send(res, 400, { error: "invalid request", detail: "token is required" });
          return;
        }
        const link = await boardStore.shareLinkByToken(body.token);
        // A token for a different board is as good as no token: it must not
        // grant access to the board named in the path.
        if (!link || link.boardId !== id || !shareLinkUsable(link)) {
          send(res, 404, { error: "invite link is not valid" });
          return;
        }
        const board = await boardStore.get(id);
        if (!board) {
          // A link whose board is gone is not a link. Deleting a board drops
          // its links, so this is belt-and-braces rather than a live path.
          send(res, 404, { error: "invite link is not valid" });
          return;
        }
        // Idempotency looks at the *board* grant only — no org-role resolver on
        // purpose. Joining twice must not downgrade someone who already holds a
        // stronger board grant, but an org-level role is not a board membership:
        // letting one suppress the row would leave the collaborator's access
        // dependent on an org grant that can be revoked on its own.
        const existing = await boardStore.memberRole(id, user.id);
        if (!existing) {
          await boardStore.setMember({
            boardId: id,
            userId: user.id,
            role: link.role,
            invitedBy: null,
            createdAt: Date.now(),
          });
        }
        // M2.6: tell the owner someone walked in through their link — only on
        // the call that actually created the grant, so a reload of the invite
        // page does not re-announce the same person.
        if (!existing && board.ownerId !== user.id) {
          const owner = await userStore.findById(board.ownerId);
          if (owner) {
            notifyUser({
              kind: "board.member_joined",
              to: { userId: owner.id, email: owner.email },
              orgId: board.orgId,
              payload: {
                boardId: id,
                boardName: board.name,
                memberName: user.name || user.email,
              },
            });
          }
        }
        // A share link is a capability for exactly one board and nothing else.
        // It used to also write a `memberships` row for the board's org, which
        // turned a link to one board into a key to the tenant: org members are
        // the ones `GET /api/boards?orgId=` lists every board to, so anyone
        // handed a single link could then enumerate the whole org — and, with
        // effective roles live, would inherit the link's role on every board in
        // it. Board membership only; org membership comes from an invite
        // (POST /api/invites/accept), which an org owner controls.
        const role = await boardStore.memberRole(id, user.id, (uid) =>
          orgRoleFor(uid, board.orgId),
        );
        send(res, 200, { boardId: id, role: role ?? link.role });
      } catch (err) {
        send(res, 400, { error: "bad request", detail: (err as Error).message });
      }
      return;
    }

    // Mint a share link (owner only).
    if (
      req.method === "POST" &&
      req.url?.startsWith("/api/boards/") &&
      req.url.endsWith("/share")
    ) {
      if (!requireCsrf(req, res, "/api/boards/:id/share")) return;
      const user = await requireUser(req, res);
      if (!user) return;
      // M1.4: sharing a board publicly is gated on a verified email so a
      // spammer can't sign up with someone else's address, mint a link, and
      // invite people to a board owned by the victim. Verification is
      // required at the gate, not at signup, so the user can still create
      // boards while their mailbox is unconfirmed.
      if (user.emailVerifiedAt === null) {
        send(res, 403, { error: "verify your email before sharing a board" });
        return;
      }
      const id = req.url.slice("/api/boards/".length, -"/share".length);
      // Effective owner: the board's owner, or an owner of the board's org.
      // Refuses with 404 rather than 403 so a board id stays unguessable. The
      // caller is passed in because the verification gate above already
      // resolved it.
      const guard = await requireBoardRole(req, res, id, "owner", "/api/boards/:id/share", user);
      if (!guard.ok) return;
      try {
        const raw = await readBody(req);
        const body = raw ? (JSON.parse(raw) as { role?: unknown; expiresInHours?: unknown }) : {};
        const role: ShareRole = body.role === "editor" ? "editor" : "viewer";
        const hours = typeof body.expiresInHours === "number" ? body.expiresInHours : null;
        const link: ShareLink = {
          token: newShareToken(),
          boardId: id,
          role,
          createdBy: user.id,
          createdAt: Date.now(),
          expiresAt: hours === null ? null : Date.now() + hours * 3_600_000,
          revokedAt: null,
        };
        await boardStore.createShareLink(link);
        send(res, 201, { token: link.token, role: link.role, expiresAt: link.expiresAt });
      } catch (err) {
        send(res, 400, { error: "bad request", detail: (err as Error).message });
      }
      return;
    }

    // Revoke share links (owner only). Omit ?token= to revoke every live link.
    if (
      req.method === "DELETE" &&
      req.url?.startsWith("/api/boards/") &&
      req.url.includes("/share")
    ) {
      if (!requireCsrf(req, res, "/api/boards/:id/share")) return;
      const user = await requireUser(req, res);
      if (!user) return;
      const url = new URL(req.url, "http://localhost");
      const id = url.pathname.slice("/api/boards/".length, -"/share".length);
      const guard = await requireBoardRole(req, res, id, "owner", "/api/boards/:id/share", user);
      if (!guard.ok) return;
      const token = url.searchParams.get("token") ?? undefined;
      send(res, 200, { revoked: await boardStore.revokeShareLinks(id, Date.now(), token) });
      return;
    }

    // Board members: any member may read, owner only may write.
    if (req.url?.startsWith("/api/boards/") && req.url.includes("/members")) {
      if (req.method !== "GET" && !requireCsrf(req, res, "/api/boards/:id/members")) return;
      const user = await requireUser(req, res);
      if (!user) return;
      const url = new URL(req.url, "http://localhost");
      const [id, , targetUserId] = url.pathname.slice("/api/boards/".length).split("/");
      if (!id) {
        send(res, 404, { error: "board not found" });
        return;
      }
      // Viewer is the floor for reading the member list; the owner-only
      // branches below re-check `callerRole`. An org owner is an effective
      // owner here, which is what lets them administer a board in their own
      // org without first being added to it.
      const guard = await requireBoardRole(req, res, id, "viewer", "/api/boards/:id/members", user);
      if (!guard.ok) return;
      const callerRole = guard.role;

      if (req.method === "GET") {
        // Any member may see who else is here — needed to attribute comments
        // and presence to names rather than raw ids.
        //
        // Members joined to users: the raw membership rows only carry
        // `userId` and `role`. The UI (admin console, ShareDialog) needs
        // names and emails to render "Ada — editor" rather than "usr_X —
        // editor". We fetch the user rows here and shape the response so the
        // consumer never has to make a second call.
        const members = await boardStore.members(id);
        const out: Array<{
          userId: string;
          role: Role;
          invitedBy: string | null;
          createdAt: number;
          name: string;
          email: string;
        }> = [];
        for (const m of members) {
          const u = await userStore.findById(m.userId);
          out.push({
            userId: m.userId,
            role: m.role,
            invitedBy: m.invitedBy,
            createdAt: m.createdAt,
            // A deleted account shows up as a tombstone row rather than a
            // crash, so a stale membership can't break the UI.
            name: u?.name ?? "(removed)",
            email: u?.email ?? "",
          });
        }
        send(res, 200, { members: out, role: callerRole });
        return;
      }
      if (callerRole !== "owner") {
        send(res, 403, { error: "owner role required" });
        return;
      }
      const board = guard.board;
      if (targetUserId && board.ownerId === targetUserId) {
        // The owner's role lives on the board row, not board_members; patching
        // or deleting it here would orphan the board.
        send(res, 409, { error: "cannot change the board owner" });
        return;
      }
      if (req.method === "PATCH" && targetUserId) {
        try {
          const raw = await readBody(req);
          const body = raw ? (JSON.parse(raw) as { role?: unknown }) : {};
          if (body.role !== "editor" && body.role !== "viewer") {
            send(res, 400, { error: "invalid request", detail: "role must be editor or viewer" });
            return;
          }
          const current = (await boardStore.members(id)).find((m) => m.userId === targetUserId);
          if (!current) {
            send(res, 404, { error: "member not found" });
            return;
          }
          await boardStore.setMember({ ...current, role: body.role });
          // M2.6: a role change is the one board event the affected user cannot
          // see for themselves until the next time something is refused.
          if (current.role !== body.role && targetUserId !== user.id) {
            const target = await userStore.findById(targetUserId);
            if (target) {
              notifyUser({
                kind: "board.role_changed",
                to: { userId: target.id, email: target.email },
                orgId: board.orgId,
                payload: {
                  boardId: id,
                  boardName: board.name,
                  role: body.role,
                  byName: user.name || user.email,
                },
              });
            }
          }
          send(res, 200, { userId: targetUserId, role: body.role });
        } catch (err) {
          send(res, 400, { error: "bad request", detail: (err as Error).message });
        }
        return;
      }
      // M2.6: grant a named person access, as opposed to minting a link that
      // anyone holding it can redeem. Restricted to members of the board's own
      // org, which is what keeps this from becoming an account-existence oracle:
      // the caller can already list those members, so "no account here" tells
      // them nothing they could not read from GET /api/orgs/:id/members. An
      // address outside the workspace goes through an org invite instead.
      if (req.method === "POST" && !targetUserId) {
        try {
          const raw = await readBody(req);
          const body = raw ? (JSON.parse(raw) as { email?: unknown; role?: unknown }) : {};
          if (typeof body.email !== "string" || !body.email.includes("@")) {
            send(res, 400, { error: "invalid request", detail: "email is required" });
            return;
          }
          if (body.role !== "editor" && body.role !== "viewer") {
            send(res, 400, { error: "invalid request", detail: "role must be editor or viewer" });
            return;
          }
          const target = await userStore.findByEmail(body.email.toLowerCase().trim());
          const inOrg = target ? await orgRoleFor(target.id, board.orgId) : undefined;
          if (!target || !inOrg) {
            send(res, 404, { error: "no member of this workspace has that address" });
            return;
          }
          if (target.id === board.ownerId) {
            send(res, 409, { error: "cannot change the board owner" });
            return;
          }
          const existingGrant = (await boardStore.members(id)).find((m) => m.userId === target.id);
          await boardStore.setMember({
            boardId: id,
            userId: target.id,
            role: body.role,
            invitedBy: user.id,
            createdAt: existingGrant?.createdAt ?? Date.now(),
          });
          if (existingGrant && existingGrant.role !== body.role) {
            // Re-granting at a different role is a role change to the person on
            // the receiving end; the card should say so rather than claim a
            // board they already had.
            notifyUser({
              kind: "board.role_changed",
              to: { userId: target.id, email: target.email },
              orgId: board.orgId,
              payload: {
                boardId: id,
                boardName: board.name,
                role: body.role,
                byName: user.name || user.email,
              },
            });
          } else if (!existingGrant) {
            notifyUser({
              kind: "board.invited",
              to: { userId: target.id, email: target.email },
              orgId: board.orgId,
              payload: {
                boardId: id,
                boardName: board.name,
                inviterName: user.name || user.email,
                role: body.role,
              },
            });
          }
          send(res, existingGrant ? 200 : 201, { userId: target.id, role: body.role });
        } catch (err) {
          send(res, 400, { error: "bad request", detail: (err as Error).message });
        }
        return;
      }
      if (req.method === "DELETE" && targetUserId) {
        await boardStore.removeMember(id, targetUserId);
        send(res, 200, { removed: targetUserId });
        return;
      }
      send(res, 405, { error: "method not allowed" });
      return;
    }

    // Delete a board. Owner-only, where "owner" is the effective role: the
    // board's owner, or an owner of the board's org. The org owner matters more
    // than it looks — DELETE /api/orgs/:id refuses while any board is left in
    // the org, and there was no board-delete route at all, so an org that had
    // ever held a board could never be deleted by anyone. The exact-match regex
    // keeps this off the /join, /share and /members paths above.
    const boardDeleteMatch = /^\/api\/boards\/([^/?#]+)(?:\?.*)?$/.exec(req.url ?? "");
    if (req.method === "DELETE" && boardDeleteMatch) {
      if (!requireCsrf(req, res, "/api/boards/:id")) return;
      const id = decodeURIComponent(boardDeleteMatch[1]!);
      const guard = await requireBoardRole(req, res, id, "owner", "/api/boards/:id");
      if (!guard.ok) return;
      // Drop any live room first: the socket layer would otherwise keep
      // accepting ops for a board that no longer exists and try to append them
      // to a deleted op log.
      realtime.evictBoard(id);
      await boardStore.delete(id);
      // Audit like the org routes do (org.create / org.rename / org.delete).
      // Optional-chained rather than 503-guarded as those routes are: the audit
      // sink is not configured in every deployment, and refusing to delete a
      // board because the log is missing would be the wrong failure.
      await orgStore?.audit({
        orgId: guard.board.orgId,
        actorId: guard.user.id,
        action: "board.delete",
        subject: id,
        ...requestOrigin(req),
        metadata: { name: guard.board.name, ownerId: guard.board.ownerId },
        at: Date.now(),
      });
      send(res, 204, {});
      return;
    }

    if (req.method === "GET" && req.url?.startsWith("/api/boards/")) {
      const user = await requireUser(req, res);
      if (!user) return;
      const id = req.url.slice("/api/boards/".length);
      // Any member may read the board, and learns their own effective role in
      // the same response so the client needn't guess what it may do. A
      // non-member gets 404, not 403, so board ids stay unguessable.
      const guard = await requireBoardRole(req, res, id, "viewer", "/api/boards/:id", user);
      if (!guard.ok) return;
      // Stage B4: the board's durable revision rides the snapshot, so a first
      // join knows where it already is before the socket opens — the
      // handshake the store's `latestSeq` contract promised all along.
      const seq = await boardStore.latestSeq(id);
      send(res, 200, { ...guard.board, role: guard.role, latestSeq: seq });
      return;
    }

    // M4: the export gate. Which formats a tier includes is a sold line item, so
    // the answer lives on the server even though the rendering does not.
    //
    // This is a product gate and not a security boundary -- the comment is here so
    // nobody later mistakes it for one. PNG and SVG are drawn in the browser from
    // a workspace the client already holds, so anyone determined can always save
    // one locally. What the route buys is a single honest place to ask "is PDF in
    // this plan", a 402 the UI can turn into an upgrade prompt instead of a dead
    // menu item, and an export meter that reconciles against the invoice.
    if (
      req.method === "POST" &&
      req.url?.startsWith("/api/boards/") &&
      req.url.endsWith("/export")
    ) {
      if (!requireCsrf(req, res, "/api/boards/:id/export")) return;
      const id = req.url.slice("/api/boards/".length, -"/export".length);
      // Viewer is enough: an export reads the board, and anyone who can open it
      // already sees everything the file would contain.
      const guard = await requireBoardRole(req, res, id, "viewer", "/api/boards/:id/export");
      if (!guard.ok) return;
      try {
        const raw = await readBody(req);
        const body = raw ? (JSON.parse(raw) as { format?: unknown }) : {};
        const requested = typeof body.format === "string" ? body.format : "";
        const format = EXPORT_FORMATS.find((f) => f === requested);
        if (!format) {
          send(res, 400, {
            error: "invalid request",
            detail: `format must be one of ${EXPORT_FORMATS.join(", ")}`,
          });
          return;
        }
        // Billed to the board's org rather than the caller's: the board is the
        // thing being exported, and its org is the one paying for it. A guest
        // editor from another workspace does not spend their own allowance here.
        if (!(await gateFormat(res, guard.board.orgId, format, "/api/boards/:id/export"))) return;
        meterUsage(guard.board.orgId, "export", 1, { boardId: id, format, by: guard.user.id });
        send(res, 200, { ok: true, boardId: id, format });
      } catch (err) {
        send(res, 400, { error: "bad request", detail: (err as Error).message });
      }
      return;
    }

    if (req.method === "POST" && req.url === "/api/generate") {
      if (!requireCsrf(req, res, "/api/generate")) return;
      const auth = await requireUserIfNeeded(req, res);
      if (!auth.ok) return;
      if (!meter(req, res, "/api/generate")) return;
      const started = Date.now();
      try {
        const raw = await readBody(req);
        const parsed = raw ? JSON.parse(raw) : {};
        // Authoritative mode: a boardId backed by server storage makes
        // validation run against real state instead of the client's summary.
        const requestedBoardId = typeof parsed.boardId === "string" ? parsed.boardId : undefined;
        const storedBoard = requestedBoardId ? await boardStore.get(requestedBoardId) : undefined;
        // The old test here was `storedBoard.ownerId === auth.userId`, which
        // quietly downgraded every collaborator to advisory validation: an editor's
        // ops were checked against the summary they sent rather than against stored
        // state, so "connect to a node someone else just deleted" was accepted for
        // everyone but the owner. The effective role is the right test -- it folds
        // ownership, the board grant and the org grant into one resolution -- and
        // it answers the billing question in the same call.
        const aiCtx = await resolveAiContext(auth.userId, storedBoard);
        const authoritative =
          storedBoard && aiCtx.authoritative
            ? { boardId: storedBoard.id, store: boardStore }
            : undefined;
        // M4: the monthly AI allowance, checked before the provider is called so a
        // refusal costs neither a token nor a second of latency. An anonymous
        // caller on a deployment with auth off has no org and no allowance to
        // spend; `meter` above is what bounds them.
        const allowance = aiCtx.orgId
          ? await gateMonthly(res, aiCtx.orgId, "ai.generationsPerMonth", "/api/generate")
          : null;
        if (allowance === false) return;
        const result = await handleGenerate(provider, parsed, auth.userId, authoritative);
        const ops = Array.isArray((result.body as { operations?: unknown[] })?.operations)
          ? (result.body as { operations: unknown[] }).operations.length
          : 0;
        let body = result.body;
        if (result.status >= 400) {
          telemetry.record({
            kind: "error",
            route: "/api/generate",
            status: result.status,
            message: JSON.stringify((result.body as { error?: string })?.error ?? result.body),
          });
        } else {
          telemetry.record({
            kind: "generate",
            ms: Date.now() - started,
            provider: provider.name,
            operations: ops,
          });
          // Metered on success only. A provider timeout is our failure, and
          // billing for it is a refund request with extra steps.
          if (aiCtx.orgId) {
            meterUsage(aiCtx.orgId, "ai.generation", 1, {
              boardId: storedBoard?.id ?? null,
              provider: provider.name,
              operations: ops,
              // The model that answered and what it cost, from the provider's own
              // response: "revenue reconciles against usage_events" (M4 exit) is
              // not answerable from a row that only says a generation happened.
              // Null rather than absent so every row has the same columns, and 0
              // is never inferred from a provider that reported nothing.
              model: result.completion?.model ?? null,
              inputTokens: result.completion?.usage?.inputTokens ?? null,
              outputTokens: result.completion?.usage?.outputTokens ?? null,
            });
          }
          // Only a successful body carries the headroom: nothing was counted
          // against a failed generation, so a figure attached to one would not
          // reconcile with what the customer is shown next.
          body = withAllowance(body, allowance);
        }
        send(res, result.status, body);
      } catch (err) {
        telemetry.record({
          kind: "error",
          route: "/api/generate",
          status: 400,
          message: (err as Error).message,
        });
        send(res, 400, { error: "bad request", detail: (err as Error).message });
      }
      return;
    }

    // --- M5/E1: streaming generation over Server-Sent Events ---------------
    // Same body, same gates, same pipeline as /api/generate — only the
    // transport differs. Frames: `start`, then `delta` (model payload text,
    // display material only), then exactly one terminal `done` (validated
    // operations; the only frame a client may apply) or `error`. CSRF and
    // metering are identical to the JSON route; BYO keys resolve through the
    // router and are never logged.
    if (req.method === "POST" && req.url === "/api/generate/stream") {
      if (!requireCsrf(req, res, "/api/generate/stream")) return;
      const auth = await requireUserIfNeeded(req, res);
      if (!auth.ok) return;
      if (!meter(req, res, "/api/generate/stream")) return;
      const started = Date.now();

      const router = resolveProvider(
        { allowByoKeys: config.allowByoKeys, defaultProvider: provider },
        readByoHeaders({
          get: (name) => {
            const value = req.headers[name];
            return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
          },
        }),
      );
      if (!router.ok) {
        send(res, router.status, { error: router.error });
        return;
      }
      const requestProvider = router.provider;

      // SSE headers are set once; frames are written as they happen. A client
      // that disconnects mid-stream makes res.write throw asynchronously —
      // swallowed by the write guard inside handleGenerateStream's send.
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
        "access-control-allow-origin": config.webOrigin,
        "access-control-allow-credentials": "true",
      });

      let closed = false;
      res.on("close", () => {
        closed = true;
      });
      const sendFrame = (event: string, data: unknown): void => {
        if (closed) return;
        try {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        } catch {
          closed = true;
        }
      };

      try {
        const raw = await readBody(req);
        const parsed = raw ? JSON.parse(raw) : {};
        const requestedBoardId = typeof parsed.boardId === "string" ? parsed.boardId : undefined;
        const storedBoard = requestedBoardId ? await boardStore.get(requestedBoardId) : undefined;
        const aiCtx = await resolveAiContext(auth.userId, storedBoard);
        const authoritative =
          storedBoard && aiCtx.authoritative
            ? { boardId: storedBoard.id, store: boardStore }
            : undefined;
        const allowance = aiCtx.orgId
          ? await gateMonthly(res, aiCtx.orgId, "ai.generationsPerMonth", "/api/generate/stream")
          : null;
        if (allowance === false) {
          // The gate answered with its own JSON; the stream never opened.
          return;
        }

        const outcome = await handleGenerateStream(
          requestProvider,
          parsed,
          auth.userId,
          authoritative,
          (event, data) => sendFrame(event, data),
        );
        closed = true;
        res.end();

        if (outcome.status >= 400) {
          telemetry.record({
            kind: "error",
            route: "/api/generate/stream",
            status: outcome.status,
            message: `stream refused (${outcome.status})`,
          });
          return;
        }
        telemetry.record({
          kind: "generate",
          ms: Date.now() - started,
          provider: outcome.provider,
          operations: outcome.operations,
        });
        if (aiCtx.orgId) {
          meterUsage(aiCtx.orgId, "ai.generation", 1, {
            boardId: storedBoard?.id ?? null,
            provider: outcome.provider,
            operations: outcome.operations,
            model: outcome.completion?.model ?? null,
            inputTokens: outcome.completion?.usage?.inputTokens ?? null,
            outputTokens: outcome.completion?.usage?.outputTokens ?? null,
          });
        }
      } catch (err) {
        // Read/parse failures after the headers went out: report in-band.
        if (!closed) {
          sendFrame("error", { error: "bad request", detail: (err as Error).message });
          closed = true;
          res.end();
        }
        telemetry.record({
          kind: "error",
          route: "/api/generate/stream",
          status: 400,
          message: (err as Error).message,
        });
      }
      return;
    }

    if (req.method === "POST" && req.url === "/api/image") {
      if (!requireCsrf(req, res, "/api/image")) return;
      const auth = await requireUserIfNeeded(req, res);
      if (!auth.ok) return;
      if (!meter(req, res, "/api/image")) return;
      const started = Date.now();
      try {
        const raw = await readBody(req);
        const parsed = raw ? JSON.parse(raw) : {};
        // ASSUMPTION: image generation draws on the same `ai.generationsPerMonth`
        // allowance as text generation. There is no image line item in plans.ts to
        // gate against, and an uncapped second model call per tier is the one shape
        // we cannot ship -- images are the more expensive call of the two.
        //
        // It is therefore metered as `ai.generation`, not *only* as
        // `image.generation`: the gate reads month-to-date for the kind
        // METERED_KEYS maps the entitlement to, so a lone image kind here would
        // mean images were checked against text usage alone and never counted at
        // all. That row is the allowance; the `image.generation` row written
        // beside it is the line item, so an image is visible as an image in the
        // usage log without an image's cost moving out of the AI allowance. A
        // real per-image ceiling is then a plans.ts number, not a rework.
        //
        // /api/image carries no boardId (see image.ts), so this bills to the
        // caller's first org rather than to any board's.
        const imageCtx = await resolveAiContext(auth.userId, undefined);
        const allowance = imageCtx.orgId
          ? await gateMonthly(res, imageCtx.orgId, "ai.generationsPerMonth", "/api/image")
          : null;
        if (allowance === false) return;
        const result = await handleImage(imageProvider, parsed);
        let body = result.body;
        if (result.status >= 400) {
          telemetry.record({
            kind: "error",
            route: "/api/image",
            status: result.status,
            message: JSON.stringify((result.body as { error?: string })?.error ?? result.body),
          });
        } else {
          telemetry.record({
            kind: "image",
            ms: Date.now() - started,
            provider: imageProvider.name,
          });
          if (imageCtx.orgId) {
            // The model is the provider's, not the response's: an images
            // endpoint answers with bytes, and the only party that knows which
            // model made them is the one that asked.
            const drawnBy = {
              provider: imageProvider.name,
              model: imageProvider.model ?? null,
            };
            meterUsage(imageCtx.orgId, "ai.generation", 1, { sort: "image", ...drawnBy });
            // The line item. `billedAs` says the allowance was charged on the row
            // above, so a reconciliation query that sums both kinds knows this is
            // the same act described twice rather than two billable ones.
            meterUsage(imageCtx.orgId, "image.generation", 1, {
              ...drawnBy,
              billedAs: "ai.generation",
            });
          }
          body = withAllowance(body, allowance);
        }
        send(res, result.status, body);
      } catch (err) {
        telemetry.record({
          kind: "error",
          route: "/api/image",
          status: 400,
          message: (err as Error).message,
        });
        send(res, 400, { error: "bad request", detail: (err as Error).message });
      }
      return;
    }

    send(res, 404, { error: "not found" });
  };

  const server = createServer((req, res) => {
    void observe(req, res, handleRequest);
  });

  // Realtime collaboration shares the HTTP server, upgrading /ws connections.
  // `orgRoleFor` is the WS half of M2.2's effective roles: a socket join has to
  // resolve the same role the HTTP guard would, or an org owner would be refused
  // their own org's board over WebSocket while REST admitted them.
  // `notify` carries the comment kinds: realtime is where humans author
  // comments, so this is where mention/reply notifications belong.
  const realtime = new RealtimeServer({
    userStore,
    boardStore,
    secret,
    tickets,
    orgRoleFor,
    notify: notifyUser,
    // M3: optional cross-instance wiring. When present, the realtime path
    // publishes commits and presence updates to the bus / store so a sibling
    // instance's subscribers see the same state. main.ts is the only caller
    // that wires these in production; tests pass `undefined` and exercise the
    // single-instance path.
    presenceStore: deps.presenceStore,
    fanout: deps.fanout,
    instanceId: deps.instanceId,
    // The SLO histogram: one observation per finished connection. Injected
    // rather than imported so the realtime layer stays metric-shape-agnostic
    // (it names seconds, not a series) and tests construct none.
    observeConnectionDuration: (seconds) => wsDuration.observe(seconds),
  });
  realtime.attach(server);

  return {
    server,
    realtime,
    metrics,
    async close(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      realtime.close();
      // The Telemetry instance outlives the app -- it is constructed by the
      // caller -- so a closed app that stayed subscribed would go on writing
      // into a registry nobody scrapes, and a test that builds several apps
      // around one Telemetry would count each event once per app.
      unsubscribeTelemetry();
    },
  };
}
