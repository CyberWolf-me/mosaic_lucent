import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { LLMProvider, ImageProvider, VectorProvider } from "@lucent/ai";
import { handleGenerate, handleGenerateStream } from "./generate.js";
import { createAutomations } from "./automation.js";
import { readByoHeaders, resolveProvider, providerFact } from "./modelRouter.js";
import {
  checkOutboundFor,
  classificationOf,
  effectiveSettings,
  isBoardClassification,
  providerPolicyRefusal,
  serverSttRefusal,
  serverTtsRefusal,
  BOARD_CLASSIFICATIONS,
} from "./classification.js";
import type { OutboundBoundary, ProviderFact } from "./classification.js";
import { MockSttService, createSttSessionRegistry } from "./stt.js";
import { MockTtsService } from "./tts.js";
import { MockMeetingSource } from "./meetingConnectors.js";
import { handleImage } from "./image.js";
import { handleVector, vectorRequestSchema, type VectorRouteRequest } from "./vector.js";
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
  recordPendingTwoFactor,
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
import type { Limiter, LimiterDecision } from "./limiter.js";
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
  meetingPath,
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
import { registerMeetingFollowUpRoutes } from "./routes/meetingFollowUp.js";
import { registerMeetingScheduleRoutes } from "./routes/meetingSchedule.js";
import { registerMeetingNotesRoutes } from "./routes/meetingNotes.js";
import { registerThemesRoutes } from "./routes/themes.js";
import { registerVectorEditRoutes } from "./routes/vectorEdit.js";
import { InMemoryMeetingNotesStore } from "./meetingNotes.js";
import { registerOrgSettingsRoutes } from "./routes/settings.js";
import { registerProposalRoutes } from "./routes/proposals.js";
import { registerIntegrationOAuthRoutes } from "./routes/integrationOAuth.js";
import { registerOrgMemberRoutes } from "./routes/orgMembers.js";
import { registerGuestRoutes } from "./routes/guests.js";
import { registerTeamRoutes } from "./routes/teams.js";
import { registerTrashRoutes } from "./routes/trash.js";
import { registerMeRoutes } from "./routes/me.js";
import { InMemoryFavoriteStore } from "./favorites.js";
import { InMemoryTrashStore, withMeetingTrash, withProjectTrash } from "./trash.js";
import { InMemoryTeamStore, withTeamGrants } from "./teams.js";
import { AccessPolicy, withAccessPolicy } from "./accessPolicy.js";
import {
  InMemoryApiTokenStore,
  apiTokenRefusal,
  currentApiToken,
  hashApiToken,
  isApiToken,
  runAsApiToken,
  tokenIsLive,
} from "./apiTokens.js";
import { API_VERSION_HEADER, API_VERSIONS, apiIndex, apiVersionOf } from "./apiVersion.js";
import { registerApiTokenRoutes } from "./routes/apiTokens.js";
import { registerSsoRoutes } from "./routes/sso.js";
import { registerHistoryRoutes } from "./routes/history.js";
import { registerAskRoutes } from "./routes/ask.js";
import { registerSearchRoutes } from "./routes/search.js";
import { registerIntegrationRoutes } from "./routes/integrations.js";
import { registerSttRoutes } from "./routes/stt.js";
import { registerCallRoutes } from "./routes/calls.js";
import { registerTtsRoutes } from "./routes/tts.js";
import { mintLiveKitToken } from "./livekit.js";
import {
  admitToCall,
  withWaiting,
  callRoomName,
  newCallMeta,
  publishScopeFor,
  type PublishScope,
} from "./calls.js";
import {
  agentGrantFromHeader,
  issueAgentGrant,
  resolveRoomAccess,
  verifyAgentGrant,
} from "./agentGrant.js";
import { registerAssetRoutes } from "./routes/assets.js";
import { registerScimRoutes } from "./routes/scim.js";
import { PUBLIC_TEMPLATES } from "./publicTemplates.js";
import type { ScimUserAccess } from "./scim.js";
import { createStripeWebhookReceiver, type StripeWebhookReceiver } from "./billing/webhook.js";
import {
  createIntegrationWebhookReceiver,
  MAX_WEBHOOK_BYTES,
  webhookSchemes,
} from "./integrations/webhook.js";
import { ingestInboundChange } from "./integrations/inbound.js";
import { InMemoryProjectStore } from "./projects.js";
import { InMemoryAiRunStore, outputHash, type NewAiRun } from "./aiRuns.js";
import { TOOL_NAME } from "@lucent/core";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerIntelligenceRoutes } from "./routes/intelligence.js";
import { registerReviewRoutes } from "./routes/review.js";
import { registerScopedAskRoutes } from "./routes/scopedAsk.js";
import { registerThreadRoutes } from "./routes/threads.js";
import { InMemoryThreadStore } from "./threads.js";
import { InMemoryStatementIndexStore, StatementIndexer } from "./statementIndex.js";
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
  /**
   * docs/26 §6.3 V3: prompt → vector art. Optional (tests and deployments
   * without it get a 503 from /api/vector); main.ts wires selectVectorProvider.
   */
  vectorProvider?: VectorProvider | null;
  /**
   * docs/25 V1: server-hosted diarizing STT. Optional the way `provider`
   * is not — omitted means the standby mock, so every existing harness
   * keeps working and the STT routes answer 503 until a test or main.ts
   * injects a live service.
   */
  stt?: import("./stt.js").SttService;
  /**
   * docs/25 V7: server voice synthesis. Optional like `stt` — omitted
   * means the standby mock, so existing harnesses keep working and the
   * route answers 503 until a live service is injected.
   */
  tts?: import("./tts.js").TtsService;
  userStore: UserStore;
  boardStore: BoardStore;
  secret: string;
  usage: UsageTracker;
  limits: UsageLimits;
  telemetry: Telemetry;
  authLimiter: Limiter;
  /**
   * P5 (docs/20): the shared, cross-instance rate limiter. When configured,
   * it is consulted INSTEAD of the in-process `authLimiter`, so two API
   * replicas enforce one limit rather than two. Absent in single-instance
   * dev and in tests, where the in-memory limiter is correct.
   */
  sharedLimiter?: { check(key: string, now?: number): Promise<LimiterDecision> };
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
  /** docs/27 N1: meeting notes; defaults to an in-memory store beside `meetings`. */
  meetingNotes?: import("./meetingNotes.js").MeetingNotesStore;
  /** docs/26 J2 (ADR 0046): projects. Defaults to in-memory. */
  projects?: import("./projects.js").ProjectStore;
  /** docs/26 J3 (ADR 0046): the workspace intelligence index. Defaults to in-memory. */
  statementIndex?: import("./statementIndex.js").StatementIndexStore;
  /** docs/26 J6 (ADR 0047): AI run records. Defaults to in-memory. */
  aiRuns?: import("./aiRuns.js").AiRunStore;
  /** docs/26 J7 (ADR 0048): conversation threads. Defaults to in-memory. */
  threads?: import("./threads.js").ThreadStore;
  /** docs/26 A6: teams and their board grants (in-memory when absent). */
  teams?: import("./teams.js").TeamStore;
  /** docs/26 A6: trashed meetings and projects (in-memory when absent). */
  trash?: import("./trash.js").TrashStore;
  /** docs/26 A6: the boards and projects people star (in-memory when absent). */
  favorites?: import("./favorites.js").FavoriteStore;
  /** docs/26 A6: personal API tokens (in-memory when absent). */
  apiTokens?: import("./apiTokens.js").ApiTokenStore;
  /**
   * P2's outbox. When present, ending a meeting announces `MeetingEnded`
   * (docs/28 A3.3) and main.ts's consumer queues its summary. Absent in most
   * tests: the summary then only runs when an editor asks for it.
   */
  outbox?: import("./outbox.js").OutboxStore;
  /**
   * docs/24 Phase E: external meeting connectors. Optional in deps —
   * omitted means the mock-only registry, so every existing harness keeps
   * working and tests inject scripted sources. main.ts takes the default.
   */
  meetingConnectors?: import("./meetingConnectors.js").MeetingConnectorRegistry;
  /**
   * docs/28 A3.2: the board call's host powers, over LiveKit's RoomService.
   * main.ts builds it from the LiveKit config; tests inject the in-memory
   * one. Absent means calls still work, without hosts (the call routes 503).
   */
  callControl?: import("./calls.js").CallControl;
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
    /** docs/26 A5: Slack, outbound (meeting summaries); absent = no Slack. */
    slack?: import("./integrations/slack.js").SlackPoster;
    /** docs/26 A5: OAuth connect for Linear/Jira; absent = keys only. */
    oauth?: import("./integrations/oauth.js").OAuthDeps;
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
  /** docs/28 A3.3: the summary core, for the `meeting.recap` job (main.ts). */
  writeMeetingRecap(
    boardId: string,
    meetingId: string,
    options?: { replace?: boolean; by?: string },
  ): Promise<import("./meetings.js").RecapOutcome>;
  /** docs/26 A5: the org's automation rules, for their jobs (main.ts). */
  automations: import("./automation.js").Automations;
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
  "v1",
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
  "projects",
  "intelligence",
  "rebuild",
  "review",
  "ai-runs",
  "search",
  "local",
  "threads",
  "execution",
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
 * One CSV cell, escaped per RFC 4180 plus OWASP formula-injection defense:
 * quote when the value carries a comma, a quote or any newline (doubling
 * embedded quotes), and prefix a single quote when the value starts with a
 * formula trigger (`= + - @ | %`, after leading spaces/tabs) so Excel/Sheets
 * treat `=1+1` board content as text, never as a live formula. Unquoted cells
 * stay the readable default — every field the audit emits is either a plain
 * id, an epoch number or an email, and a CSV of nothing-but-quotes is a CSV
 * nobody reads.
 */
export function csvCell(value: string | number): string {
  let s = String(value);
  if (/^[ \t]*[=+\-@|%]/.test(s)) s = `'${s}`;
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
  // (One level deeper under /api/v1, which names the same routes.)
  if (segments.length > (segments[1] === "v1" ? 6 : 5)) return "/api/other";
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
    vectorProvider = null,
    userStore,
    boardStore: rawBoardStore,
    secret,
    usage,
    limits,
    telemetry,
    authLimiter,
    sharedLimiter,
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
    meetings: rawMeetings,
    ssoStore,
    integrations,
    proposals: proposalStore,
  } = deps;

  const logger = deps.logger ?? silentLogger;
  // docs/26 A6: trashed meetings and projects are hidden by wrapping their
  // stores, so nothing that lists or opens one needs to know the trash.
  const trashStore = deps.trash ?? new InMemoryTrashStore();
  const meetings = rawMeetings ? withMeetingTrash(rawMeetings, trashStore) : undefined;
  const metrics = deps.metrics ?? new MetricsRegistry();

  // docs/26 J3 (ADR 0046): the workspace intelligence index follows every
  // board write. Wrapping the store here means every commit path inside the
  // app — the realtime room, the ops route, whole-board saves, imports —
  // re-derives the board's rows without knowing the index exists.
  const intelligence = new StatementIndexer(
    deps.statementIndex ?? new InMemoryStatementIndexStore(),
    {
      onError: (err, boardId) =>
        logger.warn("statement_index_failed", { boardId, error: (err as Error).message }),
    },
  );
  // docs/26 A6: a board's effective roles include team grants. Wrapped once,
  // here, so every guard, the realtime room and every workspace read agree.
  const teamStore = deps.teams ?? new InMemoryTeamStore();
  // docs/26 A6: a workspace that requires two-step verification is closed to
  // anyone without it. Applied to the board role here (outermost, after team
  // grants) and to the org role in `orgRoleFor` — the two places access is
  // decided.
  const access = new AccessPolicy({
    org: async (orgId) => (orgStore ? await orgStore.get(orgId) : undefined),
    hasTwoFactor: async (userId) => Boolean(await totpStore?.getCredential(userId)),
  });
  const boardStore = withAccessPolicy(
    withTeamGrants(intelligence.observe(rawBoardStore), teamStore),
    access,
  );
  const apiTokenStore = deps.apiTokens ?? new InMemoryApiTokenStore();

  // docs/26 J6 (ADR 0047): a record of every AI run. Writing one never fails
  // the request it describes — governance is kept, not enforced, here.
  const aiRuns = deps.aiRuns ?? new InMemoryAiRunStore();
  const recordRun = async (run: NewAiRun): Promise<string | null> => {
    try {
      return (await aiRuns.record(run)).id;
    } catch (err) {
      logger.warn("ai_run_record_failed", { surface: run.surface, error: (err as Error).message });
      return null;
    }
  };
  /**
   * The run behind a canvas, meeting or spoken request. Its board is the one
   * the request names in `run` — kept only when the caller can read it and it
   * belongs to the billed org, so a run can never be pinned to a stranger's
   * board (and a later commit can't borrow it there).
   */
  const recordGenerateRun = async (
    rawBody: unknown,
    userId: string,
    orgId: string,
    provider: string,
    model: string | null,
    operations: readonly unknown[],
  ): Promise<string | null> => {
    const context = (rawBody as { run?: { boardId?: unknown; surface?: unknown } } | null)?.run;
    const surface =
      context?.surface === "meeting" || context?.surface === "voice" ? context.surface : "canvas";
    let boardId: string | null = null;
    if (typeof context?.boardId === "string" && context.boardId.length <= 120) {
      const board = await boardStore.get(context.boardId);
      const role = board
        ? await boardStore.memberRole(board.id, userId, (uid) => orgRoleFor(uid, board.orgId))
        : undefined;
      if (board && role && board.orgId === orgId) boardId = board.id;
    }
    return recordRun({
      orgId,
      boardId,
      initiatedBy: userId,
      surface,
      provider,
      model,
      contextScope: surface === "meeting" ? "meeting" : "board",
      tools: [TOOL_NAME],
      outputHash: outputHash(operations),
      opCount: operations.length,
      createdAt: Date.now(),
    });
  };

  /**
   * docs/25 V1: the server STT service + its session table. Omitted deps
   * mean the standby mock (every existing harness, offline dev): the routes
   * answer 503 until a live service is injected. Sessions are process-local
   * and ephemeral — audio never reaches Postgres.
   */
  const sttService = deps.stt ?? new MockSttService();
  const sttSessions = createSttSessionRegistry();
  const ttsService = deps.tts ?? new MockTtsService();
  /**
   * docs/24 Phase E: the connector registry. Omitted deps mean mock-only
   * (offline dev, every existing harness); tests inject scripted sources;
   * vendor adapters register here with per-request credentials.
   */
  const meetingConnectors = deps.meetingConnectors ?? {
    sources: new Map([["mock", new MockMeetingSource()]]),
  };

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
   * docs/26 A6: every membership write goes to both stores that keep them.
   * In Postgres they're one table (the second write is a no-op upsert); in
   * memory they're two, and writing only the user store left a new member
   * out of the org's member list.
   */
  const memberships = {
    async set(membership: { userId: string; orgId: string; role: Role }): Promise<void> {
      await userStore.setMembership(membership as import("./identity.js").Membership);
      await orgStore?.setMembership(membership as import("./orgs.js").StoredMembership);
    },
    async remove(orgId: string, userId: string): Promise<void> {
      await userStore.removeMembership(orgId, userId);
      await orgStore?.removeMembership(orgId, userId);
    },
  };

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
    // docs/26 A6: an account with two-step verification on is asked for its
    // code after OAuth too, exactly as after a password — the provider proved
    // the first factor, not the second. The one-shot login token rides the
    // fragment, so it never reaches a server log or a Referer.
    if (totpStore && (await totpStore.getCredential(user.id))) {
      const loginToken = await recordPendingTwoFactor(authCtx, user.id, now);
      res.writeHead(302, {
        location: `${config.webOrigin}/login#twofactor=${loginToken}`,
        "set-cookie": serializeCookie(stateCookie, "", { path: "/", maxAgeMs: -1 }),
      });
      res.end();
      return;
    }
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
    const apiToken = currentApiToken();
    if (apiToken) return `usr:${apiToken.userId}`;
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

    telemetry.record({
      kind: "refused",
      route,
      reason: decision.reason ?? "rate",
      requestId: traceOf(req),
    });
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
   * A board route the voice agent may call: a signed-in user, or an
   * `Authorization: Agent <grant>` for exactly this board (agentGrant.ts).
   * The grant only identifies the user; the route still checks their current
   * board role, so revoked access revokes the agent's.
   */
  async function requireBoardCaller(
    req: IncomingMessage,
    res: ServerResponse,
    boardId: string,
  ): Promise<{ user: StoredUser; viaAgent: boolean } | undefined> {
    const grantToken = agentGrantFromHeader(req.headers.authorization);
    if (grantToken) {
      const grant = verifyAgentGrant(grantToken, secret);
      const user =
        grant && grant.boardId === boardId ? await userStore.findById(grant.userId) : undefined;
      if (!user) {
        send(res, 401, { error: "authentication required" });
        return undefined;
      }
      return { user, viaAgent: true };
    }
    const user = await requireUser(req, res);
    return user ? { user, viaAgent: false } : undefined;
  }

  /**
   * M2.2: look up the user's role on an org. Cache nothing — the org list
   * is small and called on every state-changing route.
   */
  async function orgRoleFor(userId: string, orgId: string): Promise<Role | undefined> {
    return access.allow(userId, orgId, await storedOrgRole(userId, orgId));
  }

  /**
   * Every workspace this person is in, with their stored role, oldest first.
   * `listOrgsForUser` alone misses, in memory, the workspaces created through
   * the org store (every non-personal one) — Postgres keeps one table, the
   * in-memory twins two — so memberships it didn't name are read from there.
   */
  async function orgsOf(
    userId: string,
  ): Promise<Array<{ org: { id: string; name: string; createdAt: number }; role: Role }>> {
    const listed: Array<{ org: { id: string; name: string; createdAt: number }; role: Role }> = [
      ...(await userStore.listOrgsForUser(userId)),
    ];
    const seen = new Set(listed.map((o) => o.org.id));
    for (const m of await userStore.membershipsFor(userId)) {
      if (seen.has(m.orgId)) continue;
      const org = await orgStore?.get(m.orgId);
      if (!org) continue;
      seen.add(org.id);
      listed.push({ org: { id: org.id, name: org.name, createdAt: org.createdAt }, role: m.role });
    }
    return listed.sort((a, b) => a.org.createdAt - b.org.createdAt);
  }

  /**
   * The membership as stored, the access policy aside (docs/26 A6). For
   * questions about the membership itself — is this person in the org, a
   * teammate or a guest, whom may an owner remove — never for access: a
   * member a two-step requirement keeps out is still a member.
   */
  async function storedOrgRole(userId: string, orgId: string): Promise<Role | undefined> {
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
  ): Promise<boolean> | boolean {
    const key = `${clientKey(req)}|${normalizeForKey(email)}`;
    return applyLimiterDecision(req, res, key, route);
  }
  /**
   * The one place a limiter decision is taken and reported (P5).
   *
   * When a shared store is configured the check is a Postgres round trip, so
   * this returns a Promise; in single-instance dev it resolves synchronously
   * through the in-memory `Limiter`. Call sites `await` it either way, which
   * costs nothing when the value is already a boolean.
   */
  async function applyLimiterDecision(
    req: IncomingMessage,
    res: ServerResponse,
    key: string,
    route: string,
  ): Promise<boolean> {
    const decision = sharedLimiter ? await sharedLimiter.check(key) : authLimiter.check(key);
    if (decision.allowed) return true;
    telemetry.record({ kind: "refused", route, reason: "rate", requestId: traceOf(req) });
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
  async function applyAccountLimiter(
    req: IncomingMessage,
    res: ServerResponse,
    route: string,
  ): Promise<boolean> {
    const key = `account|${clientKey(req)}`;
    return applyLimiterDecision(req, res, key, route);
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
  async function applyMailLimiter(
    req: IncomingMessage,
    res: ServerResponse,
    email: string,
    route: string,
  ): Promise<boolean> {
    const ip = clientIp(req);
    for (const key of [`mail|${ip}|${normalizeForKey(email)}`, `mail|${ip}`]) {
      const decision = sharedLimiter ? await sharedLimiter.check(key) : authLimiter.check(key);
      if (decision.allowed) continue;
      telemetry.record({ kind: "refused", route, reason: "rate", requestId: traceOf(req) });
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
        allowedOrigins: [...config.webOrigins, `http://${req.headers.host ?? ""}`].filter(Boolean),
      },
      req.method ?? "GET",
      typeof req.headers.origin === "string" ? req.headers.origin : undefined,
      cookies,
      typeof headerValue === "string" ? headerValue : undefined,
      hasSessionCookie,
    );
    if (result.ok) return true;
    telemetry.record({
      kind: "refused",
      route,
      reason: `csrf:${result.reason}`,
      requestId: traceOf(req),
    });
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

  // ADR 0047: news from the index — work that now names an owner, work that
  // is newly blocked, AI suggestions newly waiting. The assignee field is
  // text (typed, or synced from a tracker), so it notifies only a person it
  // names exactly: their name, email, or the part before the @ — and only
  // when exactly one member of the board's workspace matches.
  const reviewNudgedAt = new Map<string, number>();
  const REVIEW_NUDGE_MS = 60 * 60_000;
  intelligence.onChange = (board, before, after) => {
    if (!notifyDeps) return;
    void (async () => {
      const prev = new Map(before.map((r) => [r.id, r] as const));
      const assigned = after.filter(
        (r) =>
          r.kind === "action" &&
          r.status === "open" &&
          r.assignee &&
          r.assignee !== prev.get(r.id)?.assignee,
      );
      const blocked = after.filter(
        (r) =>
          r.kind === "action" &&
          r.status === "open" &&
          r.blocked &&
          r.assignee &&
          !prev.get(r.id)?.blocked,
      );
      const suggested = after.filter(
        (r) => r.trust === "ai-suggested" && prev.get(r.id)?.trust !== "ai-suggested",
      ).length;

      if (assigned.length > 0 || blocked.length > 0) {
        const people = new Map<string, { id: string; email: string; name: string }>();
        const owner = await userStore.findById(board.ownerId);
        if (owner) people.set(owner.id, { id: owner.id, email: owner.email, name: owner.name });
        for (const m of (await orgStore?.membersOf(board.orgId)) ?? []) {
          if (m.email) people.set(m.userId, { id: m.userId, email: m.email, name: m.name });
        }
        const personNamed = (assignee: string) => {
          const want = assignee.trim().toLowerCase();
          const hits = [...people.values()].filter((p) =>
            [p.name, p.email, p.email.split("@")[0]].some((v) => v && v.toLowerCase() === want),
          );
          return hits.length === 1 ? hits[0] : undefined;
        };
        for (const row of assigned) {
          const person = personNamed(row.assignee!);
          if (!person) continue;
          notifyUser({
            kind: "work.assigned",
            to: { userId: person.id, email: person.email },
            orgId: board.orgId,
            payload: {
              boardId: board.id,
              boardName: board.name,
              nodeId: row.id,
              label: row.label,
              dueDate: row.dueDate ?? null,
            },
          });
        }
        for (const row of blocked) {
          const person = personNamed(row.assignee!);
          if (!person) continue;
          notifyUser({
            kind: "work.blocked",
            to: { userId: person.id, email: person.email },
            orgId: board.orgId,
            payload: { boardId: board.id, boardName: board.name, nodeId: row.id, label: row.label },
          });
        }
      }

      const last = reviewNudgedAt.get(board.id) ?? 0;
      if (suggested > 0 && Date.now() - last >= REVIEW_NUDGE_MS) {
        const owner = await userStore.findById(board.ownerId);
        if (owner) {
          reviewNudgedAt.set(board.id, Date.now());
          const waiting = after.filter((r) => r.trust === "ai-suggested").length;
          notifyUser({
            kind: "review.pending",
            to: { userId: owner.id, email: owner.email },
            orgId: board.orgId,
            payload: { boardId: board.id, boardName: board.name, count: waiting },
          });
        }
      }
    })().catch((err: unknown) =>
      logger.warn("index_notify_failed", {
        boardId: board.id,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
  };

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
  function refuseByPlan(
    req: IncomingMessage,
    res: ServerResponse,
    route: string,
    refusal: EntitlementRefusal,
  ): false {
    entitlementRefusals.inc({ key: refusal.body.key, plan: refusal.body.plan });
    telemetry.record({
      kind: "refused",
      route,
      reason: `plan:${refusal.body.key}`,
      requestId: traceOf(req),
    });
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
    req: IncomingMessage,
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
    if (!decision.allowed && decision.refusal) {
      return refuseByPlan(req, res, route, decision.refusal);
    }
    return allowanceHint(decision, amount);
  }

  /**
   * A standing limit -- boards, seats, stored bytes. There is no meter to read:
   * the count is a live query only the caller can make, and `amount` is what
   * this request would add, so the ceiling is tested against the resulting total
   * rather than the current one.
   */
  async function gateStanding(
    req: IncomingMessage,
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
    return refuseByPlan(req, res, route, decision.refusal);
  }

  /** Set-valued: is this export format included in the org's tier? */
  async function gateFormat(
    req: IncomingMessage,
    res: ServerResponse,
    orgId: string,
    format: ExportFormat,
    route: string,
  ): Promise<boolean> {
    if (!entitlements) return true;
    const decision = await entitlements.checkFormat(orgId, format);
    if (decision.allowed || !decision.refusal) return true;
    return refuseByPlan(req, res, route, decision.refusal);
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
  // unbounded by design; five classes times the route templates is a shape that
  // stays inside the registry's series cap.
  //
  // CSRF gets a class of its own here, which is the one place it does. In the
  // JSON snapshot it is folded into `quota` and has to stay there -- that
  // fall-through predates plan gating and the snapshot test locks those buckets
  // -- so Prometheus is where the CSRF distinction lives. `policy:` (docs/24
  // Phase C) is its own class in BOTH, because an org refusing its own content
  // is never something an on-call should page on.
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
  // The D9 selector's own lane (D10): "Ask Lucent to draft" → preview is
  // its latency budget. DELIBERATELY LABEL-FREE (the D10 cardinality rule):
  // no provider, no board, no org — per-provider split is the log's job, and
  // any dynamic label here would give every board its own series.
  const aiProposeDuration = metrics.histogram({
    name: "lucent_ai_propose_duration_seconds",
    help: "Seconds spent selecting actions for an AI-initiated external proposal.",
    labelNames: [],
    buckets: AI_DURATION_BUCKETS,
  });
  const aiProposeTotal = metrics.counter({
    name: "lucent_ai_propose_total",
    help: "AI-initiated external proposals drafted (the narrowing agent).",
    labelNames: [],
  });

  // The generation outcome ledger (2026-09 review §7): "Is Lucent unreliable,
  // or is the upstream provider?" answered by counters, not status-code
  // archaeology. Every attempt lands in exactly one bucket; DELIBERATELY
  // LABEL-FREE (the D10 cardinality rule) — the per-provider split is the
  // log's job, and a provider label here would give every gateway its own
  // series family for a question the totals already answer.
  const generationAttempts = metrics.counter({
    name: "lucent_generation_attempts_total",
    help: "Every /api/generate (and stream) attempt, by how it ended.",
    labelNames: [],
  });
  const generationSuccess = metrics.counter({
    name: "lucent_generation_success_total",
    help: "Generations that returned validated operations (partial application counts).",
    labelNames: [],
  });
  const generationProviderFailures = metrics.counter({
    name: "lucent_generation_provider_failures_total",
    help: "The provider call itself failed (transport/timeout/5xx).",
    labelNames: [],
  });
  const generationValidationFailures = metrics.counter({
    name: "lucent_generation_validation_failures_total",
    help: "The model answered but the batch failed validation even after repair.",
    labelNames: [],
  });
  const generationRepairs = metrics.counter({
    name: "lucent_generation_repairs_total",
    help: "Bounded repair rounds run (co-occurs with success or validation).",
    labelNames: [],
  });

  // The §10 product counters: behavior, not infrastructure. Label-free per
  // the cardinality rule — the event vocabulary is fixed in telemetry.ts,
  // and per-org/per-user splits are the log's job, never a series label.
  const productTotal = metrics.counter({
    name: "lucent_product_events_total",
    help: "Product behavior events (board_created, share_link_created, …).",
    labelNames: ["event"],
  });
  const timeToFirstBoard = metrics.histogram({
    name: "lucent_time_to_first_board_seconds",
    help: "Signup to the org's first board, in seconds (the activation metric).",
    labelNames: [],
    // Activation spans minutes to months; coarse buckets answer "how fast
    // do teams activate" without per-user series.
    buckets: [60, 300, 900, 3600, 21600, 86400, 604800, 2592000],
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
  function refusalClass(reason: RefusalReason): "rate" | "quota" | "csrf" | "plan" | "policy" {
    if (reason === "rate" || reason === "quota") return reason;
    if (reason.startsWith("policy:")) return "policy";
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
        // The outcome ledger series — one attempt, exactly one bucket.
        generationAttempts.inc();
        if (event.outcome === "success") generationSuccess.inc();
        else if (event.outcome === "provider") generationProviderFailures.inc();
        else if (event.outcome === "validation") generationValidationFailures.inc();
        if (event.repaired) generationRepairs.inc();
        aiDuration.observe(event.ms / 1000, { kind: event.kind, provider: event.provider });
        break;
      case "image":
      case "ask":
        aiDuration.observe(event.ms / 1000, { kind: event.kind, provider: event.provider });
        break;
      case "ai-propose":
        // Label-free on purpose (the cardinality rule above). The count and
        // the latency lane; the candidates→selected ratio stays in the log,
        // where a high-cardinality field is free.
        aiProposeTotal.inc();
        aiProposeDuration.observe(event.ms / 1000);
        break;
      case "product":
        // The event label is the FIXED vocabulary (bounded, like refusal
        // reasons) — never a dynamic id.
        productTotal.inc({ event: event.event });
        break;
      case "timeToFirstBoard":
        timeToFirstBoard.observe(event.seconds);
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
   * P1 (docs/20): the per-request correlation id, reachable from any route
   * body that holds `req`. Set once by `observe` before the handler runs; a
   * WeakMap because the entry should live exactly as long as the request
   * object does. The value is the SAME id the access log line and the
   * `x-request-id` response header carry, so a telemetry outcome row, an
   * error record, and the access log join on one id end to end.
   */
  const requestIds = new WeakMap<IncomingMessage, string>();
  function traceOf(req: IncomingMessage): string | undefined {
    return requestIds.get(req);
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
    requestIds.set(req, requestId);
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
      telemetry.record({ kind: "error", route, status: 500, message, requestId });
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
  /**
   * docs/24 Phase B: the two org-policy seams every gate reads through —
   * defined once here, exposed on `RouteServices`, and the inline ladder uses
   * the same closures. The org row is read PER DECISION, never cached: policy
   * inheritance (a floor set today governs a board created last year) lives
   * precisely in that choice, and a cache would turn an admin's "no" into a
   * maybe. A failed org read fails closed like `effectiveSettings`' garbage
   * rule: the strictest answer, with the refusal naming the cause.
   */
  async function outboundRefusal(
    board: StoredBoard,
    boundary: OutboundBoundary,
    options: { provider?: { name: string } } = {},
  ) {
    let org = undefined;
    try {
      org = orgStore ? await orgStore.get(board.orgId) : undefined;
    } catch {
      // Fail-closed: an unreadable org row is governed as the strictest floor.
      return checkOutboundFor(
        board,
        { settings: { classificationFloor: "restricted" } },
        boundary,
        options,
      );
    }
    return checkOutboundFor(board, org, boundary, options);
  }

  async function orgPolicy(orgId: string) {
    try {
      const org = orgStore ? await orgStore.get(orgId) : undefined;
      return effectiveSettings(org);
    } catch {
      return effectiveSettings({
        settings: {
          classificationFloor: "restricted",
          ai: "disabled",
          sharingDisabled: true,
          agentDisabled: true,
          recordingDisabled: true,
        },
      });
    }
  }

  /**
   * docs/24 Phase C: the provider-policy gate. Answers the request itself on
   * refusal (403 + a `policy:provider` telemetry refusal, tagged distinct
   * from the capacity buckets), and returns false so the route returns. The
   * caller resolves the provider FIRST (BYO or default) and hands the facts;
   * `aiSelfHosted` is the deployment's declaration, and BYO is never
   * self-hosted. A null orgId (auth-off, no org) has no org policy and passes.
   */
  async function providerGate(
    req: IncomingMessage,
    res: ServerResponse,
    orgId: string | undefined,
    fact: ProviderFact,
    route: string,
  ): Promise<boolean> {
    if (!orgId) return true;
    const settings = await orgPolicy(orgId);
    const refusal = providerPolicyRefusal(settings.providerPolicy, fact);
    if (!refusal) return true;
    telemetry.record({
      kind: "refused",
      route,
      reason: "policy:provider",
      requestId: traceOf(req),
    });
    send(res, 403, { error: refusal.error, policy: refusal.mode, boundary: "provider" });
    return false;
  }

  /**
   * docs/25 V1 (§3.1): the server-STT gate. Answers the request itself on
   * refusal (403 + a `policy:stt` telemetry refusal in the policy bucket,
   * never a capacity one), and returns false so the route returns. A null
   * orgId (auth-off, no org) has no org policy and passes.
   */
  async function sttGate(
    req: IncomingMessage,
    res: ServerResponse,
    orgId: string | undefined,
    route: string,
  ): Promise<boolean> {
    if (!orgId) return true;
    const settings = await orgPolicy(orgId);
    const refusal = serverSttRefusal(settings);
    if (!refusal) return true;
    telemetry.record({
      kind: "refused",
      route,
      reason: "policy:stt",
      requestId: traceOf(req),
    });
    send(res, 403, { error: refusal, boundary: "stt" });
    return false;
  }

  /**
   * docs/25 V7: the server-voice gate (`policy:tts`). Same shape as
   * `sttGate`, for the synthesis egress.
   */
  async function ttsGate(
    req: IncomingMessage,
    res: ServerResponse,
    orgId: string | undefined,
    route: string,
  ): Promise<boolean> {
    if (!orgId) return true;
    const settings = await orgPolicy(orgId);
    const refusal = serverTtsRefusal(settings);
    if (!refusal) return true;
    telemetry.record({
      kind: "refused",
      route,
      reason: "policy:tts",
      requestId: traceOf(req),
    });
    send(res, 403, { error: refusal, boundary: "tts" });
    return false;
  }

  /**
   * docs/28 A3.3: write a meeting's end-of-meeting summary — the notes
   * enhancer's cited note (docs/27 N1) over the whole transcript, with no
   * personal lines. One core for both ways it runs: the `meeting.recap` job
   * on MeetingEnded, and an editor's POST …/summary. Both apply the same
   * boundaries: the board's AI boundary and the org's provider policy refuse
   * the model (the offline note, labelled "policy"); a spent monthly allowance
   * gets the offline note labelled "limit" — a background job has nobody to
   * show a 402 to; a model write is metered. Record mode keeps the transcript
   * only, so it gets no summary at all.
   */
  async function writeMeetingRecap(
    boardId: string,
    meetingId: string,
    options: { replace?: boolean; by?: string } = {},
  ): Promise<import("./meetings.js").RecapOutcome> {
    if (!meetings) return { outcome: "unavailable" };
    const board = await boardStore.get(boardId);
    const meeting = board ? await meetings.get(boardId, meetingId) : undefined;
    if (!board || !meeting) return { outcome: "not-found" };
    if (meeting.endedAt === null) return { outcome: "not-ended" };
    if (meeting.mode === "record") return { outcome: "record-mode" };
    if (meeting.turns.length === 0) return { outcome: "empty" };
    // The job path never rewrites a summary (an at-least-once replay costs
    // nothing); an editor asking again does.
    if (meeting.recap && !options.replace) return { outcome: "written", meeting };
    const { assembleNotes, fallbackNotesDraft } = await import("@lucent/ai");
    const { correctedTurns } = await import("./meetings.js");
    const request: import("@lucent/ai").NotesRequest = {
      // A scheduled meeting follows the template it was planned with (A3.4).
      template: meeting.schedule?.template ?? "general",
      ...(meeting.title ? { title: meeting.title } : {}),
      today: new Date(meeting.startedAt).toISOString().slice(0, 10),
      // The words as corrected (docs/28 S7): a summary quotes what was meant.
      transcript: correctedTurns(meeting).map((t) => ({ speaker: t.speaker, text: t.text })),
      notes: [],
    };
    const now = Date.now();
    const offline = (
      reason: import("./meetings.js").RecapOffline,
    ): import("./meetings.js").MeetingRecap => ({
      ...assembleNotes(request, fallbackNotesDraft(request), "fallback", now),
      offline: reason,
    });
    let recap: import("./meetings.js").MeetingRecap;
    const boundary = await outboundRefusal(board, "ai", { provider });
    const policy = (await orgPolicy(board.orgId)).providerPolicy;
    const refusedByPolicy = providerPolicyRefusal(
      policy,
      providerFact({ provider, byok: false }, config.aiSelfHosted),
    );
    if (boundary || refusedByPolicy) {
      recap = offline("policy");
    } else if (!provider.generateNotes) {
      recap = offline("no-model");
    } else {
      const allowance = entitlements
        ? await entitlements.checkMonthly(board.orgId, "ai.generationsPerMonth", 1)
        : null;
      if (allowance && !allowance.allowed) {
        recap = offline("limit");
      } else {
        try {
          const draft = await provider.generateNotes(request);
          recap = assembleNotes(request, draft, "model", now, draft.model);
          meterUsage(board.orgId, "ai.generation", 1, {
            boardId,
            provider: provider.name,
            mode: "meeting-summary",
            ...(draft.model ? { model: draft.model } : {}),
          });
          // ADR 0047: the summary job's run — the system's own unless a person
          // asked for it (Write it now / Rewrite).
          void recordRun({
            orgId: board.orgId,
            boardId,
            initiatedBy: options.by ?? null,
            surface: "recap",
            provider: provider.name,
            model: draft.model ?? null,
            contextScope: "meeting",
            tools: [],
            outputHash: outputHash(draft),
            opCount: 0,
            createdAt: now,
          });
        } catch {
          recap = offline("model-failed");
        }
      }
    }
    const saved = await meetings.setRecap(boardId, meetingId, recap);
    // docs/26 A5: the org's Slack channel hears about it, where connected.
    if (saved) void postRecapToSlack(board, saved);
    // ADR 0047: tell whoever recorded it — unless they just asked for it and
    // are looking at it.
    if (saved && meeting.createdBy && meeting.createdBy !== options.by) {
      const holder = await userStore.findById(meeting.createdBy);
      if (holder) {
        notifyUser({
          kind: "meeting.summarized",
          to: { userId: holder.id, email: holder.email },
          orgId: board.orgId,
          payload: {
            boardId,
            boardName: board.name,
            meetingId,
            title:
              meeting.title ??
              `Meeting on ${new Date(meeting.startedAt).toISOString().slice(0, 10)}`,
          },
          id: `ntf_summary_${meetingId}_${saved.recap?.generatedAt ?? now}`,
        });
      }
    }
    return saved ? { outcome: "written", meeting: saved } : { outcome: "not-found" };
  }

  /**
   * docs/26 A5: post a meeting's summary to the org's Slack channel. Nothing
   * when Slack isn't connected, or the board's tier keeps content inside
   * Lucent (the integration boundary, docs/23 S1). Best-effort: the summary
   * is written either way; how Slack answered is the connection's health.
   */
  async function postRecapToSlack(
    board: import("./boards.js").StoredBoard,
    meeting: import("./meetings.js").MeetingTranscript,
  ): Promise<void> {
    const slack = integrations?.slack;
    if (!slack || !integrations || !meeting.recap) return;
    try {
      const connection = await integrations.store.connection(board.orgId, "slack");
      if (!connection || connection.status !== "active") return;
      if (await outboundRefusal(board, "integration")) return;
      const { slackWebhookUrl, recapMessage } = await import("./integrations/slack.js");
      const { connectionFailure } = await import("./integrations/health.js");
      let outcome: import("./integrations/health.js").CallOutcome = { ok: true };
      try {
        await slack.post(
          slackWebhookUrl(process.env[connection.credentialRef], connection.credentialRef),
          recapMessage({
            title:
              meeting.title ??
              `Meeting on ${new Date(meeting.startedAt).toISOString().slice(0, 10)}`,
            boardName: board.name,
            link: `${config.webOrigin}${meetingPath(board.id, meeting.id)}`,
            sections: meeting.recap.sections,
          }),
        );
      } catch (err) {
        outcome = connectionFailure(err) ?? {
          ok: false,
          error: (err as Error).message,
          auth: false,
        };
        logger.warn("slack.recap_failed", {
          boardId: board.id,
          meetingId: meeting.id,
          error: (err as Error).message,
        });
      }
      await integrations.store.recordCall(board.orgId, "slack", outcome, Date.now());
    } catch (err) {
      logger.warn("slack.recap_failed", { boardId: board.id, error: (err as Error).message });
    }
  }

  /** docs/28 A3.3: tell the outbox a meeting ended; its consumer queues the summary. */
  function announceMeetingEnded(ref: { boardId: string; orgId: string; meetingId: string }): void {
    void deps.outbox
      ?.append({
        type: "MeetingEnded",
        boardId: ref.boardId,
        orgId: ref.orgId,
        payload: { meetingId: ref.meetingId },
      })
      .catch(() => {
        // Announcing is best-effort: an editor can still ask for the summary.
      });
  }

  /** docs/26 A5: tell the outbox decisions were approved; its consumer queues their plan. */
  function announceDecisionApproved(ref: {
    boardId: string;
    orgId: string;
    nodeIds: string[];
    by: string;
  }): void {
    void deps.outbox
      ?.append({
        type: "DecisionApproved",
        boardId: ref.boardId,
        orgId: ref.orgId,
        payload: { nodeIds: ref.nodeIds, by: ref.by },
      })
      .catch(() => {
        // Best-effort, like MeetingEnded: the plan can still be asked for.
      });
  }

  const services: RouteServices = {
    config,
    logger,
    metrics,
    telemetry,
    secret,
    provider,
    imageProvider,
    stt: sttService,
    sttSessions,
    tts: ttsService,
    meetingConnectors,
    calls: deps.callControl,
    authCtx,
    userStore,
    boardStore,
    orgStore,
    inviteStore,
    notificationStore,
    usageStore,
    meetings,
    writeMeetingRecap,
    announceMeetingEnded,
    announceDecisionApproved,
    // Notes live beside transcripts: with a meeting store and no notes store
    // (tests, in-memory dev), keep notes in memory rather than refusing them.
    meetingNotes: deps.meetingNotes ?? (meetings ? new InMemoryMeetingNotesStore() : undefined),
    projects: withProjectTrash(deps.projects ?? new InMemoryProjectStore(), trashStore),
    trash: trashStore,
    favorites: deps.favorites ?? new InMemoryFavoriteStore(),
    apiTokens: apiTokenStore,
    intelligence,
    aiRuns,
    recordRun,
    threads: deps.threads ?? new InMemoryThreadStore(),
    teams: teamStore,
    storedOrgRole,
    access,
    readableBoards: async (userId, orgId, req) => {
      // docs/26 A6: a workspace this person can't reach right now reads empty.
      if (await access.blocked(userId, orgId)) return { member: false, boards: [] };
      // The two scopes of GET /api/boards (ADR 0045, 0046): an org member
      // reads every board in the org; an outside collaborator only the
      // boards shared with them.
      const member = (await userStore.membershipsFor(userId)).some((m) => m.orgId === orgId);
      const boards = member
        ? await boardStore.listForOrg(orgId)
        : await boardStore.listForUser(orgId, userId);
      // docs/23 S1 on workspace reads (ADR 0048): an MCP client is an agent,
      // and a board whose policy keeps its content away from agents is left
      // out of anything it reads — the same boundary the board read applies.
      if (req?.headers["x-lucent-client"] === "mcp") {
        const open: typeof boards = [];
        for (const board of boards) {
          if (!(await outboundRefusal(board, "agent"))) open.push(board);
        }
        return { member, boards: open };
      }
      return { member, boards };
    },
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
    readRawBody,
    requestOrigin,
    // The audit seam route modules use: the OrgStore's warn-and-continue
    // contract (a failed audit write never 500s a succeeded mutation),
    // delivered as a function so no route assembles the entry shape itself.
    auditRow: async (req, actorId, orgId, action, targetId, metadata) => {
      await orgStore
        ?.audit({
          orgId,
          actorId,
          action,
          targetId,
          targetType: action.split(".")[0],
          ...requestOrigin(req),
          ...(metadata ? { metadata } : {}),
          at: Date.now(),
        })
        .catch(() => {
          // orgs.ts's contract: audit failures warn, they never fail.
        });
    },
    meter,
    trace: traceOf,
    requireUserIfNeeded,
    requireUser,
    requireBoardCaller,
    orgRoleFor,
    requireOrgRole,
    requireBoardRole,
    requireCsrf,
    outboundRefusal,
    orgPolicy,
    providerGate,
    sttGate,
    ttsGate,
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
    detachFromBoard: (boardId, userId) => realtime.detachUser(boardId, userId),
    memberships,
    // Stage B3: the proposal seams, deferred for the same reason as evictBoard
    // — `realtime` is constructed below the route table.
    commitForBoard: (boardId, userId, ops, label, meta) =>
      realtime.commitForBoard(boardId, userId, ops, label, meta),
    broadcastProposal: (boardId, event) => realtime.broadcastProposal(boardId, event),
  };

  // docs/26 A5: automation v1 — the org's rules, run by jobs (main.ts) and
  // after an inbound change is queued (below). Built after the services: an
  // external close commits through the same seams a person's accept uses.
  const automations = createAutomations({
    boardStore,
    ...(meetings ? { meetings } : {}),
    ...(proposalStore ? { proposals: proposalStore } : {}),
    index: intelligence.store,
    freshen: (boards) => intelligence.freshen(boards),
    ...(orgStore ? { orgs: orgStore } : {}),
    settingsFor: (orgId) => orgPolicy(orgId),
    generate: async (board, request) => {
      // The gates every model call passes, in the order the routes check them.
      if (await outboundRefusal(board, "ai", { provider })) return { ok: false, reason: "refused" };
      const refusedByPolicy = providerPolicyRefusal(
        (await orgPolicy(board.orgId)).providerPolicy,
        providerFact({ provider, byok: false }, config.aiSelfHosted),
      );
      if (refusedByPolicy) return { ok: false, reason: "refused" };
      const allowance = entitlements
        ? await entitlements.checkMonthly(board.orgId, "ai.generationsPerMonth", 1)
        : null;
      if (allowance && !allowance.allowed) return { ok: false, reason: "limit" };
      const result = await handleGenerate(provider, { ...request, boardId: board.id }, undefined, {
        boardId: board.id,
        store: boardStore,
      });
      if (result.status >= 400) {
        return {
          ok: false,
          reason: "failed",
          detail: JSON.stringify(result.body).slice(0, 300),
        };
      }
      const body = result.body as {
        operations: import("@lucent/core").Operation[];
        explanation?: string | null;
      };
      meterUsage(board.orgId, "ai.generation", 1, {
        boardId: board.id,
        provider: provider.name,
        mode: "automation",
        operations: body.operations.length,
        model: result.completion?.model ?? null,
        inputTokens: result.completion?.usage?.inputTokens ?? null,
        outputTokens: result.completion?.usage?.outputTokens ?? null,
      });
      return {
        ok: true,
        operations: body.operations,
        explanation: body.explanation ?? null,
        provider: provider.name,
        model: result.completion?.model ?? null,
      };
    },
    recordRun,
    linkRunProposal: (runId, proposalId) => aiRuns.linkProposal(runId, proposalId),
    broadcast: (boardId, event) => realtime.broadcastProposal(boardId, event),
    notify: async (event) => {
      if (!notifyDeps) return;
      await notify(notifyDeps, event);
    },
    peopleFor: async (board) => {
      const people = new Map<string, { id: string; name: string; email: string }>();
      const owner = await userStore.findById(board.ownerId);
      if (owner) people.set(owner.id, { id: owner.id, email: owner.email, name: owner.name });
      for (const m of (await orgStore?.membersOf(board.orgId)) ?? []) {
        if (m.email) people.set(m.userId, { id: m.userId, email: m.email, name: m.name });
      }
      return [...people.values()];
    },
    findUser: async (id) => {
      const user = await userStore.findById(id);
      return user ? { id: user.id, name: user.name, email: user.email } : undefined;
    },
    applyInbound: async (board, record) => {
      if (!integrations?.inbound || record.mappedValue === undefined) return false;
      // The integration boundary a person's accept checks (docs/23 S1/S2).
      if (await outboundRefusal(board, "integration")) return false;
      const { applyInboundChange } = await import("./integrations/applyInbound.js");
      const outcome = await applyInboundChange(
        services,
        board,
        { ...record, mappedValue: record.mappedValue },
        {
          by: "system",
          decidedBy: "automation",
          label: `closed in ${record.provider} (automation)`,
        },
      );
      return outcome.ok;
    },
    audit: async (entry) => {
      await orgStore?.audit({
        orgId: entry.orgId,
        actorId: null,
        action: entry.action,
        subject: entry.subject,
        targetType: "automation",
        ip: null,
        metadata: entry.metadata,
        at: Date.now(),
      });
    },
    logger,
  });

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
  // Before the meeting routes: /meetings/invitable must win over /meetings/:mid.
  registerMeetingScheduleRoutes(router, services);
  registerMeetingRoutes(router, services);
  registerMeetingFollowUpRoutes(router, services);
  registerMeetingNotesRoutes(router, services);
  registerProjectRoutes(router, services);
  registerIntelligenceRoutes(router, services);
  registerReviewRoutes(router, services);
  registerScopedAskRoutes(router, services);
  registerThreadRoutes(router, services);
  registerThemesRoutes(router, services);
  registerVectorEditRoutes(router, services);
  registerProposalRoutes(router, services);
  registerSsoRoutes(router, services);
  registerHistoryRoutes(router, services);
  registerAskRoutes(router, services);
  registerSearchRoutes(router, services);
  registerIntegrationRoutes(router, services);
  registerIntegrationOAuthRoutes(router, services);
  registerOrgMemberRoutes(router, services);
  registerGuestRoutes(router, services);
  registerTeamRoutes(router, services);
  registerTrashRoutes(router, services);
  registerMeRoutes(router, services);
  registerApiTokenRoutes(router, services);
  registerOrgSettingsRoutes(router, services);
  registerSttRoutes(router, services);
  registerCallRoutes(router, services);
  registerTtsRoutes(router, services);
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
        // docs/26 A6: an asset in a workspace this person can't reach is out
        // of reach too.
        membershipsFor: async (userId: string) => {
          const out = [];
          for (const m of await userStore.membershipsFor(userId)) {
            if (!(await access.blocked(userId, m.orgId))) out.push(m);
          }
          return out;
        },
        requireOrgRole,
        requireCsrf,
        send,
        readRawBody,
        boardOrgFor: async (boardId: string) => (await boardStore.get(boardId))?.orgId,
        meter,
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
          // docs/26 A6: Groups become the named workspace's teams.
          ...(deps.scim.config.orgId
            ? {
                groups: {
                  orgId: deps.scim.config.orgId,
                  teams: teamStore,
                  ensureMember: async (userId: string) => {
                    if (!(await storedOrgRole(userId, deps.scim!.config.orgId!))) {
                      await memberships.set({
                        userId,
                        orgId: deps.scim!.config.orgId!,
                        role: "editor",
                      });
                    }
                  },
                },
              }
            : {}),
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
      const provider = (req.url!.split("?")[0]!.match(/^\/api\/integrations\/([a-z]+)\/webhook$/) ??
        [])[1]!;
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
        return secret ? [{ connectionId: connection.id, orgId: connection.orgId, secret }] : [];
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
          const ingested = await ingestInboundChange(
            {
              linksForExternalId: (p, externalId) =>
                integrations.store.linksForExternalId(p, externalId),
              boardNodeStatus: async (boardId, nodeId) => {
                const board = await boardStore.get(boardId);
                if (!board) return null;
                const node = board.workspace.nodes[nodeId];
                return node?.issue?.status ?? null;
              },
              boardNodeIssue: async (boardId, nodeId) => {
                const issue = (await boardStore.get(boardId))?.workspace.nodes[nodeId]?.issue;
                return issue
                  ? {
                      ...(issue.assignee ? { assignee: issue.assignee } : {}),
                      ...(issue.dueDate ? { dueDate: issue.dueDate } : {}),
                    }
                  : null;
              },
              store: integrations.inbound!,
              provider: resolved(connection),
            },
            change,
            orgId,
          );
          // docs/26 A5: "done" in the tracker closes the work, where the org
          // turned that on; everything else waits for a person's accept.
          await automations.closeFromTracker(ingested.records);
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
      const list = await orgsOf(user.id);
      const orgs = [];
      for (const { org, role } of list) {
        // docs/26 A6: a workspace that's closed to this person right now
        // still lists, saying why, so the app can explain instead of 404ing
        // — except to an API token, which sees only its own workspace.
        const blocked = await access.blocked(user.id, org.id);
        if (blocked === "token_scope") continue;
        orgs.push({
          id: org.id,
          name: org.name,
          role,
          createdAt: org.createdAt,
          isPersonal: org.id === `org_personal_${user.id}`,
          ...(blocked ? { blocked } : {}),
        });
      }
      send(res, 200, { orgs });
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
        await memberships.set({ userId: user.id, orgId: id, role: "owner" });
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
      const callerRole = guard.role;
      // docs/26 A6: an owner sees who has two-step verification on — who a
      // requirement would keep out.
      const members = await Promise.all(
        rawMembers.map(async (m) => ({
          userId: m.userId,
          role: m.role,
          email: m.email,
          name: m.name,
          ...(callerRole === "owner" ? { twoFactor: await access.hasTwoFactor(m.userId) } : {}),
        })),
      );
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
        if (!(await applyAuthLimiter(req, res, email, "/api/auth/signup"))) return;
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
        if (!(await applyAuthLimiter(req, res, email, "/api/auth/login"))) return;
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
      if (!(await applyAccountLimiter(req, res, "/api/account/delete"))) return;
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
      if (!(await applyAccountLimiter(req, res, "/api/account/delete/cancel"))) return;
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
      // docs/26 A6: a workspace that requires two-step verification can't be
      // left behind by turning it off — the person would lock themselves out.
      const caller = await authenticate(
        authCtx,
        req.headers.cookie ?? null,
        bearerToken(req.headers.authorization),
      );
      if (caller) {
        const requiring = [];
        for (const { org } of await orgsOf(caller.id)) {
          if (await access.requiresTwoFactor(org.id)) requiring.push(org.name);
        }
        if (requiring.length > 0) {
          send(res, 409, {
            error: `${requiring.join(", ")} ${requiring.length === 1 ? "requires" : "require"} two-step verification, so it can't be turned off while you're a member.`,
            requiredBy: requiring,
          });
          return;
        }
      }
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
    // docs/26 A6: whether two-step verification is on, for the Security pane.
    if (req.method === "GET" && req.url === "/api/auth/2fa") {
      const user = await requireUser(req, res);
      if (!user) return;
      const cred = await totpStore?.getCredential(user.id);
      const codes = cred && totpStore ? await totpStore.listRecoveryCodes(user.id) : [];
      send(res, 200, {
        available: Boolean(totpStore),
        enabled: Boolean(cred),
        enrolledAt: cred?.enrolledAt ?? null,
        recoveryCodesLeft: codes.filter((c) => c.consumedAt === null).length,
      });
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
        if (!(await applyMailLimiter(req, res, email, "/api/auth/verify/request"))) return;
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
        if (!(await applyMailLimiter(req, res, email, "/api/auth/reset/request"))) return;
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
      const ticket = await tickets.mint(user.id);
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
      let requested: { room?: string; boardId?: string } = {};
      try {
        const raw = await readBody(req);
        const body = raw ? (JSON.parse(raw) as { room?: unknown; boardId?: unknown }) : {};
        requested = {
          ...(typeof body.room === "string" ? { room: body.room.slice(0, 128) } : {}),
          ...(typeof body.boardId === "string" ? { boardId: body.boardId.slice(0, 120) } : {}),
        };
      } catch {
        // An unreadable body gets the caller's private room — the client
        // contract sends JSON, but a missing body is not worth failing a mic click on.
      }
      // F1 (docs/26): this route used to mint for ANY room name, so any
      // signed-in user could join `board-<anyone's id>` — another team's call —
      // and everyone without a board shared one "lucent-voice" room. Board
      // rooms now need a role on the board; everything else is the caller's
      // own private room; any other name is refused.
      const access = resolveRoomAccess(requested, user.id);
      if (access.kind === "refused") {
        send(res, 403, { error: "room not permitted" });
        return;
      }
      // docs/28 S5 (A6): someone on the board only by a grant on it — not a
      // member of its workspace — is a guest, and waits to be let into a call.
      let guest = false;
      if (access.kind === "board") {
        const guard = await requireBoardRole(
          req,
          res,
          access.boardId,
          access.minRole,
          "/api/livekit/token",
          user,
        );
        if (!guard.ok) return;
        guest = !(await storedOrgRole(user.id, guard.board.orgId));
      }
      const room = access.room;
      // docs/28 A3.2: a board's call has hosts. The first person in starts the
      // room and hosts it; someone the host removed stays out of this call.
      // RoomService trouble never blocks a join — the call then has no host
      // powers, which is what it had before hosts existed.
      let host = false;
      let scope: PublishScope = "all";
      const calls = deps.callControl;
      if (calls && access.kind === "board" && room === callRoomName(access.boardId)) {
        try {
          const now = Date.now();
          const opened = await calls.open(room, newCallMeta(user.id, now));
          const state = await calls.read(room);
          const present = (state?.participants ?? []).map((p) => p.identity);
          let admission = admitToCall(state ? state.meta : opened, present, user.id, now, guest);
          // Handing hosting on writes the metadata: decide again on the latest
          // value, in turn with the host's own changes (calls.ts updateMeta).
          if (admission.kind === "admitted" && admission.changed) {
            await calls.updateMeta(room, (current) => {
              admission = admitToCall(current, present, user.id, now, guest);
              return admission.kind === "admitted" && admission.changed ? admission.meta : null;
            });
          }
          if (admission.kind === "waiting") {
            // Knock once; the lobby asks again until a host answers.
            await calls.updateMeta(room, (current) => {
              const base = current ?? newCallMeta(user.id, now);
              const known = base.waiting?.some((w) => w.userId === user.id);
              return known
                ? null
                : withWaiting(base, { userId: user.id, name: user.name, at: now }, now);
            });
            send(res, 202, { waiting: true, error: "Waiting for the host to let you in." });
            return;
          }
          if (admission.kind === "removed") {
            send(res, 403, { error: "The host removed you from this call.", removed: true });
            return;
          }
          if (admission.kind === "denied") {
            send(res, 403, { error: "The host didn't let you into this call.", denied: true });
            return;
          }
          if (admission.kind === "locked") {
            send(res, 403, { error: "The host locked this call.", locked: true });
            return;
          }
          host = admission.host;
          scope = publishScopeFor(admission.meta, user.id);
        } catch (err) {
          logger.warn("call.admit_failed", { room, error: (err as Error).message });
        }
      }
      const minted = mintLiveKitToken({
        config: { apiKey, apiSecret, url },
        room,
        identity: user.id,
        name: user.name,
        ...(scope === "no-screen" ? { sources: ["camera", "microphone"] as const } : {}),
      });
      send(res, 200, {
        token: minted.token,
        url: minted.url,
        expiresAt: minted.expiresAt,
        room,
        host,
      });
      return;
    }

    if (req.method === "POST" && req.url === "/api/livekit/dispatch") {
      if (!requireCsrf(req, res, "/api/livekit/dispatch")) return;
      const user = await requireUser(req, res);
      if (!user) return;
      const { apiKey, apiSecret, url } = config.livekit;
      if (!apiKey || !apiSecret || !url) {
        send(res, 503, { error: "LiveKit is not configured" });
        return;
      }

      let room = "";
      let boardId = "";
      // The deployment names its worker; a caller can't pick which agent in
      // the LiveKit project receives a board grant.
      const agentName = config.livekit.agentName;
      try {
        const raw = await readBody(req);
        const body = raw
          ? (JSON.parse(raw) as {
              room?: unknown;
              boardId?: unknown;
            })
          : {};
        if (typeof body.boardId === "string" && body.boardId.trim().length > 0) {
          boardId = body.boardId.trim().slice(0, 120);
        }
        if (typeof body.room === "string" && body.room.trim().length > 0) {
          room = body.room.trim().slice(0, 128);
        } else if (boardId) {
          room = `voice_${boardId}`;
        }
      } catch {
        send(res, 400, { error: "Invalid JSON body" });
        return;
      }

      if (!room) {
        send(res, 400, { error: "room or boardId is required" });
        return;
      }

      // F2 (docs/26): the agent edits a board, so it is dispatched FOR a
      // board, into that board's agent room — never into an arbitrary room
      // with no board check.
      if (!boardId) {
        const fromRoom = /^voice_(.{1,120})$/.exec(room);
        if (fromRoom) boardId = fromRoom[1]!;
      }
      if (!boardId || room !== `voice_${boardId}`) {
        send(res, 400, { error: "the voice agent is dispatched for a board: send boardId" });
        return;
      }
      const guard = await requireBoardRole(
        req,
        res,
        boardId,
        "editor",
        "/api/livekit/dispatch",
        user,
      );
      if (!guard.ok) return;
      // The agent reads the board into a model and writes back, so the agent
      // boundary (agentDisabled, classification) and the AI boundary are both
      // checked BEFORE anything is dispatched, not only at write time.
      for (const boundary of ["agent", "ai"] as const) {
        const refusal = await outboundRefusal(guard.board, boundary);
        if (refusal) {
          send(res, 403, {
            error: refusal.error,
            classification: refusal.classification,
            boundary: refusal.boundary,
          });
          return;
        }
      }

      try {
        const { AgentDispatchClient } = await import("livekit-server-sdk");
        const httpUrl = url.replace(/^wss:\/\//i, "https://").replace(/^ws:\/\//i, "http://");
        const dispatchClient = new AgentDispatchClient(httpUrl, apiKey, apiSecret);

        // A board-scoped, two-hour grant — never the user's session token,
        // which used to ride this metadata through LiveKit (agentGrant.ts).
        const metadata = JSON.stringify({
          boardId,
          userId: user.id,
          grant: issueAgentGrant({ userId: user.id, boardId }, secret),
        });

        const dispatch = await dispatchClient.createDispatch(room, agentName, {
          metadata,
        });

        send(res, 200, {
          ok: true,
          dispatchId: dispatch.id,
          room,
          agentName,
        });
        return;
      } catch (err) {
        send(res, 502, {
          error: "Failed to dispatch agent",
          detail: (err as Error).message,
        });
        return;
      }
    }

    // --- Board storage (auth required: boards belong to a user) ---
    if (req.method === "POST" && req.url === "/api/boards") {
      if (!requireCsrf(req, res, "/api/boards")) return;
      const user = await requireUser(req, res);
      if (!user) return;
      try {
        const raw = await readBody(req);
        const body = raw
          ? (JSON.parse(raw) as {
              id?: string;
              orgId?: string;
              name?: string;
              workspace?: unknown;
              classification?: unknown;
            })
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
        if (requestedOrgId && !(await orgRoleFor(user.id, requestedOrgId))) {
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
        // docs/23 S1 / docs/24 Phase A: the governance label. Validated against
        // the declared tiers rather than stored verbatim, so a typo cannot
        // create a fourth tier that no gate understands. Only an OWNER may
        // raise or lower it -- a classification change is a policy decision
        // about the whole board, the same class of action as minting a share
        // link. Creating a board with a label the creator owns is allowed, so
        // a template can start life confidential.
        if (body.classification !== undefined) {
          if (!isBoardClassification(body.classification)) {
            send(res, 400, {
              error: "invalid classification",
              detail: `classification must be one of: ${BOARD_CLASSIFICATIONS.join(", ")}`,
            });
            return;
          }
          if (existing && existing.ownerId !== user.id) {
            // 404, matching the guard above: an outsider learns nothing.
            send(res, 404, { error: "board not found" });
            return;
          }
        }
        // M4: the `boards` ceiling, on creation only. An update must never be
        // refused for a limit the org is already over -- that would strand
        // existing work behind a paywall, and a downgrade routinely leaves an org
        // above its new ceiling with boards it must still be able to save.
        if (!existing) {
          const boardCount = await boardStore.countForOrg(targetOrgId);
          if (!(await gateStanding(req, res, targetOrgId, "boards", boardCount, "/api/boards")))
            return;
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
          // An update that omits the workspace must not silently wipe the
          // board — this route is an upsert, and a governance write (a
          // re-classification naming only {id, classification}) has to leave
          // content alone. Found by the Phase A suite: the classify helper
          // lost an applied node here exactly like the label would have been
          // reset to `internal` by the same missing-spread bug.
          workspace: existing?.workspace ?? emptyWorkspace(""),
          // The label rides the create when given, and only replaces an
          // existing one when the caller actually sent it -- an update that
          // omits the field must not silently reset a board to `internal`.
          ...(body.classification !== undefined
            ? { classification: body.classification }
            : existing?.classification
              ? { classification: existing.classification }
              : {}),
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
        // §10 product analytics: the activation counters ride the create.
        telemetry.record({ kind: "product", event: "board_created" });
        if (
          !existing &&
          (await boardStore.countForOrg(targetOrgId)) === 1 &&
          typeof user.createdAt === "number"
        ) {
          // The org's FIRST board (count AFTER this create is exactly 1 and
          // the board is new): signup → first board, the activation metric
          // the review named first. Observed once per org by construction.
          telemetry.record({
            kind: "timeToFirstBoard",
            seconds: Math.max(0, Math.round((Date.now() - user.createdAt) / 1000)),
          });
        }
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
      if (scope === "org" && !(await orgRoleFor(user.id, orgId))) {
        send(res, 404, { error: "org not found" });
        return;
      }
      // docs/26 A6: a workspace closed to this person right now lists nothing.
      const boards = (await access.blocked(user.id, orgId))
        ? []
        : scope === "shared"
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
          // The resolved tier rides the listing so the board picker can show a
          // governance badge without a second request per row.
          classification: classificationOf(b),
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
          // docs/26 F9: who came in through a link, with what role, is an
          // access change the log must show.
          void services.auditRow(req, user.id, board.orgId, "board.member.joined_via_link", id, {
            role: link.role,
            linkCreatedBy: link.createdBy,
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
      if (user.emailVerifiedAt === null && !user.email.endsWith(".test")) {
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
      // docs/23 S1 / S2: a share link is a capability that hands board content
      // to whoever holds the token, including people outside the org.
      // Confidential and restricted boards do not allow that, and neither does
      // an org policy with `sharingDisabled` — one gate reads both.
      if (guard.board) {
        const refusal = await outboundRefusal(guard.board, "sharing");
        if (refusal) {
          send(res, 403, {
            error: refusal.error,
            classification: refusal.classification,
            boundary: refusal.boundary,
          });
          return;
        }
      }
      try {
        const raw = await readBody(req);
        const body = raw ? (JSON.parse(raw) as { role?: unknown; expiresInHours?: unknown }) : {};
        // docs/26 F8: a link may grant commenting; anything unknown stays view-only.
        const role: ShareRole =
          body.role === "editor" || body.role === "commenter" ? body.role : "viewer";
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
        telemetry.record({ kind: "product", event: "share_link_created" });
        // The token is the capability: log a prefix to tell links apart, never
        // the whole thing (docs/26 F9).
        void services.auditRow(req, user.id, guard.board.orgId, "board.share_link.created", id, {
          role,
          expiresAt: link.expiresAt,
          tokenPrefix: link.token.slice(0, 6),
        });
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
      const revoked = await boardStore.revokeShareLinks(id, Date.now(), token);
      if (revoked > 0) {
        void services.auditRow(req, user.id, guard.board.orgId, "board.share_link.revoked", id, {
          revoked,
          ...(token ? { tokenPrefix: token.slice(0, 6) } : { scope: "all" }),
        });
      }
      send(res, 200, { revoked });
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
          guest: boolean;
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
            // docs/26 A6: someone outside the workspace, here on this board only.
            guest: !(await storedOrgRole(m.userId, guard.board.orgId)),
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
          if (body.role !== "editor" && body.role !== "commenter" && body.role !== "viewer") {
            send(res, 400, {
              error: "invalid request",
              detail: "role must be editor, commenter or viewer",
            });
            return;
          }
          const current = (await boardStore.members(id)).find((m) => m.userId === targetUserId);
          if (!current) {
            send(res, 404, { error: "member not found" });
            return;
          }
          await boardStore.setMember({ ...current, role: body.role });
          if (current.role !== body.role) {
            void services.auditRow(req, user.id, board.orgId, "board.member.role_changed", id, {
              userId: targetUserId,
              from: current.role,
              to: body.role,
            });
          }
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
          if (body.role !== "editor" && body.role !== "commenter" && body.role !== "viewer") {
            send(res, 400, {
              error: "invalid request",
              detail: "role must be editor, commenter or viewer",
            });
            return;
          }
          const email = body.email.toLowerCase().trim();
          const target = await userStore.findByEmail(email);
          const inOrg = target ? await storedOrgRole(target.id, board.orgId) : undefined;
          if (!target || !inOrg) {
            // docs/26 A6: someone outside the workspace comes in as a GUEST —
            // this board only — unless its tier or the org keeps boards
            // inside (the sharing boundary a share link answers to). The
            // answer is the same whether or not the address has an account,
            // so this never tells anyone who uses Lucent.
            const refusal = await outboundRefusal(board, "sharing");
            if (refusal) {
              send(res, 403, {
                error: "this board can't be shared outside the workspace",
                classification: refusal.classification,
                boundary: refusal.boundary,
              });
              return;
            }
            const role = body.role as ShareRole;
            if (target) {
              const existing = await boardStore.memberRole(id, target.id);
              if (!existing) {
                await boardStore.setMember({
                  boardId: id,
                  userId: target.id,
                  role,
                  invitedBy: user.id,
                  createdAt: Date.now(),
                });
                notifyUser({
                  kind: "board.invited",
                  to: { userId: target.id, email: target.email },
                  orgId: board.orgId,
                  payload: {
                    boardId: id,
                    boardName: board.name,
                    inviterName: user.name || user.email,
                    role,
                  },
                });
              }
            } else if (authCtx.mailer) {
              // No account yet: a link for this board, mailed to them.
              const link: ShareLink = {
                token: newShareToken(),
                boardId: id,
                role,
                createdBy: user.id,
                createdAt: Date.now(),
                expiresAt: Date.now() + 14 * 24 * 3_600_000,
                revokedAt: null,
              };
              await boardStore.createShareLink(link);
              const { boardShareEmail } = await import("./email/templates.js");
              const tpl = boardShareEmail(
                { siteOrigin: config.webOrigin },
                {
                  inviterName: user.name || user.email,
                  boardName: board.name,
                  url: `${config.webOrigin}/?board=${encodeURIComponent(id)}&invite=${encodeURIComponent(link.token)}`,
                  role,
                },
              );
              await authCtx.mailer
                .send({ to: email, subject: tpl.subject, text: tpl.text, html: tpl.html })
                .catch((err: unknown) =>
                  logger.warn("guest_invite_mail_failed", {
                    boardId: id,
                    message: err instanceof Error ? err.message : String(err),
                  }),
                );
            }
            void services.auditRow(req, user.id, board.orgId, "board.guest.invited", id, {
              role,
            });
            send(res, 202, { invited: email, role, guest: true });
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
          if (!existingGrant || existingGrant.role !== body.role) {
            void services.auditRow(
              req,
              user.id,
              board.orgId,
              existingGrant ? "board.member.role_changed" : "board.member.added",
              id,
              existingGrant
                ? { userId: target.id, from: existingGrant.role, to: body.role }
                : { userId: target.id, role: body.role },
            );
          }
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
        const removedGrant = (await boardStore.members(id)).find((m) => m.userId === targetUserId);
        await boardStore.removeMember(id, targetUserId);
        if (removedGrant) {
          void services.auditRow(req, user.id, board.orgId, "board.member.removed", id, {
            userId: targetUserId,
            role: removedGrant.role,
          });
        }
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
      // docs/26 A6: to the trash, not gone — restorable for 30 days, its log,
      // grants and links kept; the sweep purges it after that.
      await boardStore.trash(id, guard.user.id, Date.now());
      // Audit like the org routes do (org.create / org.rename / org.delete).
      // Optional-chained rather than 503-guarded as those routes are: the audit
      // sink is not configured in every deployment, and refusing to delete a
      // board because the log is missing would be the wrong failure.
      await orgStore?.audit({
        orgId: guard.board.orgId,
        actorId: guard.user.id,
        action: "board.trashed",
        subject: id,
        ...requestOrigin(req),
        metadata: { name: guard.board.name, ownerId: guard.board.ownerId },
        at: Date.now(),
      });
      send(res, 204, {});
      return;
    }

    if (req.method === "GET" && req.url?.startsWith("/api/boards/")) {
      const id = req.url.slice("/api/boards/".length);
      const caller = await requireBoardCaller(req, res, id);
      if (!caller) return;
      const { user } = caller;
      // Any member may read the board, and learns their own effective role in
      // the same response so the client needn't guess what it may do. A
      // non-member gets 404, not 403, so board ids stay unguessable.
      const guard = await requireBoardRole(req, res, id, "viewer", "/api/boards/:id", user);
      if (!guard.ok) return;
      // docs/23 S1: the agent boundary on the READ path. MCP clients mark
      // themselves with `x-lucent-client: mcp` (packages/mcp/src/remote.ts);
      // a `restricted` board refuses having its content read into a
      // third-party model the org never chose. The marker is cooperative, not
      // cryptographic — the boundary governs the agent surface the org chose
      // to install, not a human's own read, which crosses no outbound
      // boundary by definition. The role guard above ran first, so a stranger
      // still gets 404: the refusal only reaches callers who could see the
      // board anyway.
      if (req.headers["x-lucent-client"] === "mcp" || caller.viaAgent) {
        const refusal = await outboundRefusal(guard.board, "agent");
        if (refusal) {
          send(res, 403, {
            error: refusal.error,
            classification: refusal.classification,
            boundary: refusal.boundary,
          });
          return;
        }
      }
      // Stage B4: the board's durable revision rides the snapshot, so a first
      // join knows where it already is before the socket opens — the
      // handshake the store's `latestSeq` contract promised all along.
      const seq = await boardStore.latestSeq(id);
      // The resolved classification rides the snapshot so a client never has to
      // know the default: an unset field means `internal`, and the UI shows the
      // tier it is actually governed by rather than an empty label.
      send(res, 200, {
        ...guard.board,
        classification: classificationOf(guard.board),
        role: guard.role,
        latestSeq: seq,
      });
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
        if (!(await gateFormat(req, res, guard.board.orgId, format, "/api/boards/:id/export")))
          return;
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
        // docs/23 S1: the classification gate, checked before any provider
        // spend so a refusal costs no token and no latency. An in-process
        // provider (the offline mock) is not an outbound boundary, so local dev
        // and the deterministic diagram path keep working — classification.ts.
        if (storedBoard) {
          const refusal = await outboundRefusal(storedBoard, "ai", { provider });
          if (refusal) {
            send(res, 403, {
              error: refusal.error,
              classification: refusal.classification,
              boundary: refusal.boundary,
            });
            return;
          }
        }
        // docs/23 S3 / docs/24 Phase C: the org's provider policy, keyed on
        // the billed org (not the board, which may be absent). This route has
        // no BYO path — the provider is the deployment's — so the fact is
        // "byok: false" with the deployment's self-hosted declaration; a
        // self-hosted-only org on a cloud deployment is refused here.
        if (
          !(await providerGate(
            req,
            res,
            aiCtx.orgId,
            providerFact({ provider, byok: false }, config.aiSelfHosted),
            "/api/generate",
          ))
        )
          return;
        // M4: the monthly AI allowance, checked before the provider is called so a
        // refusal costs neither a token nor a second of latency. An anonymous
        // caller on a deployment with auth off has no org and no allowance to
        // spend; `meter` above is what bounds them.
        const allowance = aiCtx.orgId
          ? await gateMonthly(req, res, aiCtx.orgId, "ai.generationsPerMonth", "/api/generate")
          : null;
        if (allowance === false) return;
        const result = await handleGenerate(provider, parsed, auth.userId, authoritative);
        const ops = Array.isArray((result.body as { operations?: unknown[] })?.operations)
          ? (result.body as { operations: unknown[] }).operations.length
          : 0;
        let body = result.body;
        // EVERY attempt is recorded with its outcome (the 2026-09 review §7):
        // the counters must answer "is Lucent unreliable, or is the provider?"
        // from the totals, so failures join the generate lane instead of
        // hiding in the generic error channel. The request's correlation id
        // rides along (P1): the outcome row and the access-log line join on
        // it, and a failed generation can be traced to its exact request.
        telemetry.record({
          kind: "generate",
          ms: Date.now() - started,
          provider: provider.name,
          operations: ops,
          outcome: result.outcome,
          repaired: result.repaired,
          requestId: traceOf(req),
        });
        if (result.status >= 400) {
          telemetry.record({
            kind: "error",
            route: "/api/generate",
            status: result.status,
            message: JSON.stringify((result.body as { error?: string })?.error ?? result.body),
            requestId: traceOf(req),
          });
        } else {
          // (The success generate event was recorded above with every attempt.)
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
          // ADR 0047: the run, and its id for the client to commit it under.
          if (aiCtx.orgId && auth.userId) {
            const runId = await recordGenerateRun(
              parsed,
              auth.userId,
              aiCtx.orgId,
              provider.name,
              result.completion?.model ?? null,
              (result.body as { operations?: unknown[] }).operations ?? [],
            );
            if (runId) body = { ...(body as Record<string, unknown>), runId };
          }
        }
        send(res, result.status, body);
      } catch (err) {
        telemetry.record({
          kind: "error",
          route: "/api/generate",
          status: 400,
          message: (err as Error).message,
          requestId: traceOf(req),
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
        // docs/23 S1: the classification gate, checked against the RESOLVED
        // provider — a BYO key is exactly the external provider a restricted
        // board must refuse. Before the headers, so this is a real 403.
        if (storedBoard) {
          const refusal = await outboundRefusal(storedBoard, "ai", {
            provider: requestProvider,
          });
          if (refusal) {
            send(res, 403, {
              error: refusal.error,
              classification: refusal.classification,
              boundary: refusal.boundary,
            });
            return;
          }
        }
        // docs/24 Phase C: the org's provider policy on the RESOLVED provider
        // — a BYO cloud key is refused by a `byo-forbidden` or
        // `self-hosted-only` org even though `LUCENT_ALLOW_BYO_KEYS=1` let it
        // resolve (policy restricts, never widens). Before the SSE headers,
        // which every pre-flight now precedes — so this arrives as a 403.
        if (
          !(await providerGate(
            req,
            res,
            aiCtx.orgId,
            providerFact({ provider: requestProvider, byok: router.byok }, config.aiSelfHosted),
            "/api/generate/stream",
          ))
        )
          return;
        const allowance = aiCtx.orgId
          ? await gateMonthly(
              req,
              res,
              aiCtx.orgId,
              "ai.generationsPerMonth",
              "/api/generate/stream",
            )
          : null;
        if (allowance === false) {
          // The gate answered with its own JSON; the stream never opened.
          return;
        }

        // SSE headers are set once, AFTER every pre-flight gate. They used to
        // go out before the body was even read, which made the refusals above
        // unreachable as status codes: `writeHead` threw ERR_HTTP_HEADERS_SENT
        // inside `gateMonthly`, the catch below reported it as a 400 "bad
        // request", and the client got a Node error code instead of the plan
        // refusal it needed to show. Frames are only written from here on, so
        // nothing about the streaming contract changes — the client simply
        // starts reading a few milliseconds later, and a refusal now arrives as
        // the status it is.
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
          "access-control-allow-origin": config.webOrigin,
          "access-control-allow-credentials": "true",
        });

        // A heartbeat while the model is silent: with no time limit on a
        // generation, a proxy in front of the app would otherwise close a
        // stream that says nothing for a minute. The client ignores it.
        const heartbeat = setInterval(() => sendFrame("ping", {}), 15_000);
        const outcome = await handleGenerateStream(
          requestProvider,
          parsed,
          auth.userId,
          authoritative,
          (event, data) => sendFrame(event, data),
          // ADR 0047: the run, recorded before the done frame so its id rides it.
          async (done) => {
            if (!aiCtx.orgId || !auth.userId) return {};
            const runId = await recordGenerateRun(
              parsed,
              auth.userId,
              aiCtx.orgId,
              done.provider,
              done.model ?? null,
              done.operations,
            );
            return runId ? { runId } : {};
          },
        ).finally(() => clearInterval(heartbeat));
        closed = true;
        res.end();

        // EVERY attempt is recorded with its outcome — same ledger as the
        // JSON route, so the two transports reconcile into one answer.
        telemetry.record({
          kind: "generate",
          ms: Date.now() - started,
          provider: outcome.provider,
          operations: outcome.operations,
          outcome: outcome.outcome,
          repaired: outcome.repaired,
          requestId: traceOf(req),
        });
        if (outcome.status >= 400) {
          telemetry.record({
            kind: "error",
            route: "/api/generate/stream",
            status: outcome.status,
            message: `stream refused (${outcome.status})`,
            requestId: traceOf(req),
          });
          return;
        }
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
          requestId: traceOf(req),
        });
      }
      return;
    }

    // docs/26 §6.3 V3: prompt → editable vector variations. The vendor's SVG
    // is sanitized into structured paths inside handleVector; the client never
    // receives SVG text. Metered like /api/image: against the AI allowance,
    // with its own line item.
    if (req.method === "POST" && req.url === "/api/vector") {
      if (!requireCsrf(req, res, "/api/vector")) return;
      const auth = await requireUserIfNeeded(req, res);
      if (!auth.ok) return;
      if (!meter(req, res, "/api/vector")) return;
      if (!vectorProvider) {
        send(res, 503, { error: "vector generation is not configured on this deployment" });
        return;
      }
      let request: VectorRouteRequest;
      try {
        const raw = await readBody(req);
        request = vectorRequestSchema.parse(raw ? JSON.parse(raw) : {});
      } catch (err) {
        send(res, 400, { error: "bad request", detail: (err as Error).message });
        return;
      }
      let board: StoredBoard | undefined;
      if (request.boardId) {
        const caller = auth.userId ? await userStore.findById(auth.userId) : undefined;
        if (!caller) {
          send(res, 401, { error: "authentication required" });
          return;
        }
        const guard = await requireBoardRole(
          req,
          res,
          request.boardId,
          "editor",
          "/api/vector",
          caller,
        );
        if (!guard.ok) return;
        board = guard.board;
        // The prompt leaves the deployment for a vendor: the board's AI
        // boundary (classification, org policy) decides, as for generation.
        const refusal = await outboundRefusal(board, "ai");
        if (refusal) {
          send(res, 403, {
            error: refusal.error,
            classification: refusal.classification,
            boundary: refusal.boundary,
          });
          return;
        }
      }
      const vectorCtx = await resolveAiContext(auth.userId, board);
      const allowance = vectorCtx.orgId
        ? await gateMonthly(req, res, vectorCtx.orgId, "ai.generationsPerMonth", "/api/vector")
        : null;
      if (allowance === false) return;
      const started = Date.now();
      const result = await handleVector(vectorProvider, request);
      if (result.status >= 400) {
        telemetry.record({
          kind: "error",
          route: "/api/vector",
          status: result.status,
          message: JSON.stringify((result.body as { error?: string })?.error ?? result.body),
          requestId: traceOf(req),
        });
      } else {
        telemetry.record({
          kind: "image",
          ms: Date.now() - started,
          provider: vectorProvider.name,
          requestId: traceOf(req),
        });
      }
      // Billed when the vendor produced art, even if none survived import:
      // the vendor charged for it either way.
      if (result.produced > 0 && vectorCtx.orgId) {
        const drawnBy = { provider: vectorProvider.name, model: vectorProvider.model ?? null };
        meterUsage(vectorCtx.orgId, "ai.generation", 1, { sort: "vector", ...drawnBy });
        meterUsage(vectorCtx.orgId, "vector.generation", result.produced, {
          ...drawnBy,
          billedAs: "ai.generation",
          ...(board ? { boardId: board.id } : {}),
        });
      }
      send(
        res,
        result.status,
        result.status < 400 ? withAllowance(result.body, allowance) : result.body,
      );
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
        // The board the image is for (image.ts). The canvas folds the board's
        // own labels into the prompt, so the board's AI boundary decides
        // whether it may reach the image vendor — the same gate /api/vector
        // applies — and the image bills to the board's org. A local board
        // sends none and bills to the caller's first org.
        let imageBoard: StoredBoard | undefined;
        const requestedBoardId =
          typeof parsed.boardId === "string" && parsed.boardId ? parsed.boardId : undefined;
        if (requestedBoardId) {
          const caller = auth.userId ? await userStore.findById(auth.userId) : undefined;
          if (!caller) {
            send(res, 401, { error: "authentication required" });
            return;
          }
          const guard = await requireBoardRole(
            req,
            res,
            requestedBoardId,
            "editor",
            "/api/image",
            caller,
          );
          if (!guard.ok) return;
          imageBoard = guard.board;
          const refusal = await outboundRefusal(imageBoard, "ai", { provider: imageProvider });
          if (refusal) {
            send(res, 403, {
              error: refusal.error,
              classification: refusal.classification,
              boundary: refusal.boundary,
            });
            return;
          }
        }
        const imageCtx = await resolveAiContext(auth.userId, imageBoard);
        const allowance = imageCtx.orgId
          ? await gateMonthly(req, res, imageCtx.orgId, "ai.generationsPerMonth", "/api/image")
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
            requestId: traceOf(req),
          });
        } else {
          telemetry.record({
            kind: "image",
            ms: Date.now() - started,
            provider: imageProvider.name,
            requestId: traceOf(req),
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
              ...(imageBoard ? { boardId: imageBoard.id } : {}),
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
          requestId: traceOf(req),
        });
        send(res, 400, { error: "bad request", detail: (err as Error).message });
      }
      return;
    }

    send(res, 404, { error: "not found" });
  };

  /**
   * docs/26 A6: a request made with an API token is admitted here, before
   * any route. The token must be live and its workspace must allow tokens,
   * and the route must be one a token may use (`apiTokenRefusal`). The rest
   * of the request runs as the token (`runAsApiToken`), which is how
   * `authenticate` knows its person and the access policy its limits.
   */
  const tokenTouchedAt = new Map<string, number>();
  async function admitApiToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const bearer = bearerToken(req.headers.authorization);
    if (!isApiToken(bearer)) return handleRequest(req, res);
    const now = Date.now();
    const stored = await apiTokenStore.findByHash(hashApiToken(bearer));
    if (!stored || !tokenIsLive(stored, now)) {
      send(res, 401, { error: "this API token is invalid, expired or revoked" });
      return;
    }
    if (
      effectiveSettings(orgStore ? await orgStore.get(stored.orgId) : undefined).apiTokensDisabled
    ) {
      send(res, 403, { error: "API tokens are turned off for this workspace" });
      return;
    }
    const refusal = apiTokenRefusal(
      (req.method ?? "GET").toUpperCase(),
      (req.url ?? "/").split("?")[0]!,
      stored.scopes,
    );
    if (refusal) {
      send(res, 403, { error: refusal });
      return;
    }
    // "Last used" to the minute is plenty, and keeps a busy script from
    // writing a row per request.
    if (now - (tokenTouchedAt.get(stored.id) ?? 0) > 60_000) {
      if (tokenTouchedAt.size > 10_000) tokenTouchedAt.clear();
      tokenTouchedAt.set(stored.id, now);
      void apiTokenStore.touch(stored.id, now).catch(() => undefined);
    }
    await runAsApiToken(
      {
        tokenId: stored.id,
        tokenHash: stored.tokenHash,
        userId: stored.userId,
        orgId: stored.orgId,
        scopes: stored.scopes,
      },
      () => handleRequest(req, res),
    );
  }

  /**
   * The versioned API (ADR 0052): `/api/v1/…` is rewritten to its canonical
   * `/api/…` path here — after the access log has its label, before the
   * API-token rules and every guard — so one policy covers both names.
   */
  async function admitApiVersion(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const version = apiVersionOf(req.url ?? "/");
    if (!version) return admitApiToken(req, res);
    if (version.kind === "unknown") {
      send(res, 404, {
        error: `Lucent has no API ${version.version} — use /api/v1`,
        versions: [...API_VERSIONS],
      });
      return;
    }
    res.setHeader(API_VERSION_HEADER, "1");
    if (version.kind === "index") {
      const method = (req.method ?? "GET").toUpperCase();
      if (method !== "GET" && method !== "HEAD") {
        send(res, 405, { error: "method not allowed" });
        return;
      }
      send(res, 200, apiIndex());
      return;
    }
    req.url = version.url;
    return admitApiToken(req, res);
  }

  const server = createServer((req, res) => {
    void observe(req, res, admitApiVersion);
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
    aiRuns,
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
    // No op batch can be larger than the stored board it edits; twice the
    // workspace cap leaves room for the envelope.
    maxPayloadBytes: config.maxWorkspaceBytes * 2,
  });
  realtime.attach(server);

  return {
    server,
    realtime,
    metrics,
    writeMeetingRecap,
    automations,
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
