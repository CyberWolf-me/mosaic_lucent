import type { IncomingMessage, ServerResponse } from "node:http";
import type { ImageProvider, LLMProvider } from "@lucent/ai";
import type { AuthContext, HandleResult, UserStore } from "../accounts.js";
import type { BoardStore, StoredBoard } from "../boards.js";
import type { Config } from "../config.js";
import type { AllowanceHint, Entitlements, MeteredEntitlementKey } from "../entitlements.js";
import type { EmptyState, Router } from "../http/router.js";
import type { Role, StoredUser } from "../identity.js";
import type { OrgInviteStore } from "../invites.js";
import type { NotificationKind, NotificationStore, NotifyEvent } from "../notifications.js";
import type { Logger } from "../obs/logger.js";
import type { MetricsRegistry } from "../obs/metrics.js";
import type { OrgStore } from "../orgs.js";
import type { ExportFormat, NumericEntitlementKey } from "../plans.js";
import type { MeetingStore } from "../meetings.js";
import type { Operation } from "@lucent/core";
import type { TicketStore } from "../realtimeTicket.js";
import type { SttService, SttSessionRegistry } from "../stt.js";
import type { TtsService } from "../tts.js";
import type { Telemetry } from "../telemetry.js";
import type { UsageLimits, UsageTracker } from "../usage.js";
import type { UsageKind, UsageStore } from "../usageStore.js";

/**
 * What a route module is handed.
 *
 * The routes used to be one 1700-line `if`-ladder inside `createApp`, where
 * every handler simply closed over the guards and stores declared above it.
 * Splitting them into files means that closure has to become a value, and this
 * interface is it -- deliberately as a record of functions rather than the raw
 * `AppDeps`, because the guards are the load-bearing part. `requireBoardRole`
 * is not `boardStore.memberRole`: it resolves the org grant, answers 404 rather
 * than 403 so ids stay unguessable, and counts the denial. A route module that
 * received the stores instead would be free to re-derive any of that, and the
 * one time it got it subtly wrong would be a cross-tenant read.
 *
 * So: stores for the reads a route legitimately owns, and functions for every
 * decision that has already been made once, correctly, in `createApp`.
 *
 * `EmptyState` is the router's state parameter throughout. Middleware is where
 * shared state would come from, and this surface registers none: the guard
 * order per route is the security contract (CSRF before body read, verified
 * email before authorisation on `/share`), and middleware runs *around* every
 * match uniformly, which is exactly the wrong shape for that.
 */
export type AppRouter = Router<EmptyState>;

/** Signature every `routes/<domain>.ts` module exports as `register*`. */
export type RegisterRoutes = (router: AppRouter, s: RouteServices) => void;

export interface RouteServices {
  readonly config: Config;
  readonly logger: Logger;
  readonly metrics: MetricsRegistry;
  readonly telemetry: Telemetry;
  readonly secret: string;
  /** The configured web origin — the redirect target SAML's ACS ends at. */
  readonly webOrigin: string;
  /**
   * The session store, for the SSO ACS to mint a session cookie alongside
   * the bearer token (the browser flow needs the cookie; the API flow needs
   * the token — login returns both, so the ACS does too).
   */
  readonly sessionStore: import("../sessions.js").SessionStore | undefined;

  readonly provider: LLMProvider;
  readonly imageProvider: ImageProvider;
  /**
   * docs/25 V1: server-hosted diarizing STT. Always present — unconfigured
   * deployments get the standby mock and the routes answer 503 (never a
   * silent void), tests inject a seeded mock.
   */
  readonly stt: SttService;
  /**
   * The process-local STT session table (ephemeral like presence — audio
   * never reaches Postgres). Owned by `createApp`, shared by the STT
   * routes only.
   */
  readonly sttSessions: SttSessionRegistry;
  /**
   * docs/25 V7: server voice synthesis. Always present — unconfigured
   * deployments get the standby mock and the route answers 503.
   */
  readonly tts: TtsService;

  /**
   * The shared auth context: stores, the session-cookie shape, the mailer and
   * the site origin. Route modules pass it straight to the `accounts.ts`
   * handlers, and read `mailer` / `siteOrigin` off it for the one route
   * (org invite) that sends mail of its own.
   */
  readonly authCtx: AuthContext;
  readonly userStore: UserStore;
  readonly boardStore: BoardStore;
  /** Optional stores keep their `undefined`: a route answers 503 or degrades. */
  readonly orgStore: OrgStore | undefined;
  readonly inviteStore: OrgInviteStore | undefined;
  readonly notificationStore: NotificationStore | undefined;
  readonly usageStore: UsageStore | undefined;
  /** E3/R3: meeting transcripts; undefined → the meetings routes answer 503. */
  readonly meetings: MeetingStore | undefined;
  /** docs/28 A3.3: write (or, with replace, rewrite) a meeting's summary. */
  writeMeetingRecap(
    boardId: string,
    meetingId: string,
    options?: { replace?: boolean; by?: string },
  ): Promise<import("../meetings.js").RecapOutcome>;
  /** docs/28 A3.3: announce MeetingEnded to the outbox (a no-op without one). */
  announceMeetingEnded(ref: { boardId: string; orgId: string; meetingId: string }): void;
  /** docs/26 A5: announce decisions approved in Review (a no-op without an outbox). */
  announceDecisionApproved(ref: {
    boardId: string;
    orgId: string;
    nodeIds: string[];
    by: string;
  }): void;
  /** docs/27 N1: one person's notes per meeting; undefined → the notes routes answer 503. */
  readonly meetingNotes: import("../meetingNotes.js").MeetingNotesStore | undefined;
  /** docs/26 J2 (ADR 0046): projects — org records that link boards and grant nothing. */
  readonly projects: import("../projects.js").ProjectStore;
  /** docs/26 J3 (ADR 0046): the workspace intelligence index and its maintainer. */
  readonly intelligence: import("../statementIndex.js").StatementIndexer;
  /** docs/26 J6 (ADR 0047): AI run records. */
  readonly aiRuns: import("../aiRuns.js").AiRunStore;
  /** Write a run; resolves null (and logs) rather than failing the request. */
  recordRun(run: import("../aiRuns.js").NewAiRun): Promise<string | null>;
  /** docs/26 J7 (ADR 0048): one person's conversation per scope. */
  readonly threads: import("../threads.js").ThreadStore;
  /** docs/26 A6: teams inside an org, and their board grants. */
  readonly teams: import("../teams.js").TeamStore;
  /** docs/26 A6: trashed meetings and projects. */
  readonly trash: import("../trash.js").TrashStore;
  /**
   * The boards a user can read in an org — every board for a member, only
   * the boards shared with them for an outside collaborator. Every
   * workspace-wide read (meetings, projects, intelligence) starts here, so
   * none of them can reach a board the caller couldn't open.
   */
  readableBoards(
    userId: string,
    orgId: string,
    /** The request, when it may come from an agent (MCP): agent-refusing boards drop out. */
    req?: IncomingMessage,
  ): Promise<{ member: boolean; boards: StoredBoard[] }>;
  /**
   * docs/24 Phase E: external meeting connectors (Zoom/Meet/Teams → turns).
   * The registry always carries at least the mock source; vendor adapters
   * register against the same interface with per-request credentials.
   */
  readonly meetingConnectors: import("../meetingConnectors.js").MeetingConnectorRegistry;
  /** docs/28 A3.2: the board call's host powers; undefined → the call routes answer 503. */
  readonly calls: import("../calls.js").CallControl | undefined;
  /** Stage B3: review-gate proposals; undefined → the proposal routes answer 503. */
  readonly proposals: import("../proposals.js").ProposalStore | undefined;
  /** F1: SSO connections + domain claims; undefined → the SSO routes answer 503. */
  readonly ssoStore: import("../ssoStore.js").SsoStore | undefined;
  /**
   * Stage D4: the integration platform — connection+link store and the
   * provider map, prebuilt (undefined → the integration routes answer 503,
   * fail-closed like every optional store).
   */
  readonly integrations:
    | {
        store: import("../integrations/integrations.js").IntegrationStore;
        providers: Map<string, import("../integrations/provider.js").ExecutionProviderFactory>;
        /** Stage D5: the action records + execution ledger (undefined → the D5 routes answer 503). */
        actions?: import("../integrations/integrations.js").IntegrationActionStore;
        ledger?: import("../integrations/ledger.js").ExecutionLedger;
        /** Stage D6: the executor's race timeout (default 15s). */
        executionTimeoutMs?: number;
        /** Stage D7: the inbound queue (undefined → the inbound routes answer 503). */
        inbound?: import("../integrations/inbound.js").InboundChangeStore;
        /** docs/26 A5: Slack, outbound — meeting summaries to a channel. */
        slack?: import("../integrations/slack.js").SlackPoster;
        /** docs/26 A5: OAuth connect for Linear/Jira (sealed tokens). */
        oauth?: import("../integrations/oauth.js").OAuthDeps;
      }
    | undefined;
  /**
   * Append one audit row. A function rather than the OrgStore itself: the
   * route modules never assemble the entry shape (normalizeAuditEntry owns
   * target-type defaults), and never choose whether a failed audit write is
   * fatal (it never is — warn-and-continue, orgs.ts).
   */
  auditRow(
    req: IncomingMessage,
    actorId: string,
    orgId: string,
    action: string,
    targetId: string,
    /** What changed, for the reader of the log (old and new role, …). */
    metadata?: Record<string, unknown>,
  ): Promise<void>;
  /** `null` when billing is unconfigured -- see the gate helpers below. */
  readonly entitlements: Entitlements | null;
  readonly tickets: TicketStore;
  readonly usage: UsageTracker;
  readonly limits: UsageLimits;

  // --- Response envelope ----------------------------------------------------
  //
  // Routes write through these rather than `ctx.send`, so the CORS + content
  // type block stays the single object `createApp` builds from the configured
  // web origin. `ctx.send` would produce the same headers via the router's
  // `baseHeaders`, but two writers means two things to keep in agreement.
  send(res: ServerResponse, status: number, body: unknown): void;
  sendWithHeaders(
    res: ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string>,
  ): void;
  /** Send an `accounts.ts` result, fanning `set-cookie` into an array. */
  writeHandleResult(res: ServerResponse, result: HandleResult): void;
  /**
   * Read the raw body under the app's cap. Deliberately not `ctx.text()`: the
   * router's reader rejects with `BodyTooLargeError`, this one with
   * `new Error("request body too large")`, and each route's catch turns the
   * message into the 400 body a client already sees.
   */
  readBody(req: IncomingMessage): Promise<string>;
  /**
   * Read the raw bytes under a caller-supplied cap (audio chunks, webhook
   * payloads). Rejects with `new Error("request body too large")` past it —
   * the route turns that into 413, the way the assets route already does.
   */
  readRawBody(req: IncomingMessage, maxBytes?: number): Promise<Buffer>;
  /** `{ ip, userAgent }` for an audit row or a session record. */
  requestOrigin(req: IncomingMessage): { ip: string; userAgent: string | null };

  // --- Guards ---------------------------------------------------------------
  //
  // Every one of these answers the request itself when it refuses, and reports
  // that by returning false / `{ ok: false }` / undefined. A route's only
  // correct response to a refusal is to return.
  meter(req: IncomingMessage, res: ServerResponse, route: string): boolean;
  /**
   * P1 (docs/20): the correlation id of the request a route module is
   * handling — the same id `observe` stamped into the access-log line, the
   * `x-request-id` response header, and every telemetry event the request
   * produced. Delivered as a function (not the WeakMap) so a route cannot
   * outlive the request object it names; the id is undefined only if the
   * route runs outside `observe`, which no registered route does.
   */
  trace(req: IncomingMessage): string | undefined;
  requireUserIfNeeded(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<{ ok: true; userId?: string } | { ok: false }>;
  requireUser(req: IncomingMessage, res: ServerResponse): Promise<StoredUser | undefined>;
  /**
   * The caller of a board-scoped agent route: a signed-in user, or a
   * board-scoped voice-agent grant (`Authorization: Agent <grant>`,
   * agentGrant.ts) for exactly this board. `viaAgent` marks the latter so the
   * route records the change as AI initiated by the user.
   */
  requireBoardCaller(
    req: IncomingMessage,
    res: ServerResponse,
    boardId: string,
  ): Promise<{ user: StoredUser; viaAgent: boolean } | undefined>;
  orgRoleFor(userId: string, orgId: string): Promise<Role | undefined>;
  requireOrgRole(
    req: IncomingMessage,
    res: ServerResponse,
    orgId: string | undefined,
    required: Role,
    route: string,
  ): Promise<{ ok: true; user: StoredUser; role: Role } | { ok: false }>;
  requireBoardRole(
    req: IncomingMessage,
    res: ServerResponse,
    boardId: string,
    required: Role,
    route: string,
    caller?: StoredUser,
  ): Promise<{ ok: true; user: StoredUser; role: Role; board: StoredBoard } | { ok: false }>;
  requireCsrf(req: IncomingMessage, res: ServerResponse, route: string): boolean;
  /**
   * docs/24 Phase A+B: the single outbound gate a route may use. It reads the
   * board's classification AND the org's policy (the floor via `stricterOf`,
   * the org-wide boundary denials) through one call — the routes must never
   * compose the two checks themselves, so a forgotten org lookup cannot
   * silently reopen a disabled boundary. `null` means the crossing is
   * allowed; a returned refusal is ready to send (403 + named body).
   */
  outboundRefusal(
    board: StoredBoard,
    boundary: import("../classification.js").OutboundBoundary,
    options?: { provider?: { name: string } },
  ): Promise<import("../classification.js").ClassificationRefusal | null>;
  /**
   * The org's effective policy plane for a board (docs/24 Phase B). Routes
   * that gate a non-outbound policy — meeting capture reads
   * `recordingDisabled` — call this instead of touching `orgStore.get`
   * themselves: the fail-closed defaults live in `effectiveSettings`, and
   * duplicating that read in a route is how two stores drift.
   */
  orgPolicy(orgId: string): Promise<import("../classification.js").EffectiveOrgSettings>;
  /**
   * docs/24 Phase C: the provider-policy gate. Answers the request itself
   * (403 + a `refused` telemetry event tagged `policy:provider`) and returns
   * false when the org's provider policy refuses the resolved provider —
   * the same guard shape every other refusal in this codebase uses, so the
   * refusal is one call and cannot half-wire (the BYO cloud key a
   * self-hosted-only org forbids, the unmarked operator provider that same
   * org must not be served by, the name outside an allowlist). `orgId` may
   * be undefined (auth-off deployments): no org, no org policy, allowed.
   */
  providerGate(
    req: IncomingMessage,
    res: ServerResponse,
    orgId: string | undefined,
    fact: import("../classification.js").ProviderFact,
    route: string,
  ): Promise<boolean>;
  /**
   * docs/25 V1 (§3.1): the server-STT gate. Answers the request itself
   * (403 + a `refused` telemetry event tagged `policy:stt`) and returns
   * false when the org forbids server-hosted transcription — the same guard
   * shape as `providerGate`, so the new egress path cannot half-wire.
   * `orgId` may be undefined (auth-off deployments): no org, no org policy.
   */
  sttGate(
    req: IncomingMessage,
    res: ServerResponse,
    orgId: string | undefined,
    route: string,
  ): Promise<boolean>;
  /**
   * docs/25 V7: the server-voice gate (`policy:tts`). Same shape as
   * `sttGate`, for the synthesis egress.
   */
  ttsGate(
    req: IncomingMessage,
    res: ServerResponse,
    orgId: string | undefined,
    route: string,
  ): Promise<boolean>;
  /**
   * P5: these are awaited because the limit may be enforced by a shared
   * Postgres counter rather than an in-process Map. A boolean return is
   * awaitable, so the in-memory path costs nothing for the change.
   */
  applyAuthLimiter(
    req: IncomingMessage,
    res: ServerResponse,
    email: string,
    route: string,
  ): boolean | Promise<boolean>;
  applyAccountLimiter(
    req: IncomingMessage,
    res: ServerResponse,
    route: string,
  ): boolean | Promise<boolean>;
  applyMailLimiter(
    req: IncomingMessage,
    res: ServerResponse,
    email: string,
    route: string,
  ): boolean | Promise<boolean>;

  // --- Seams ----------------------------------------------------------------
  notifyUser<K extends NotificationKind>(event: NotifyEvent<K>): void;
  gateMonthly(
    req: IncomingMessage,
    res: ServerResponse,
    orgId: string,
    key: MeteredEntitlementKey,
    route: string,
    amount?: number,
  ): Promise<AllowanceHint | null | false>;
  gateStanding(
    req: IncomingMessage,
    res: ServerResponse,
    orgId: string,
    key: NumericEntitlementKey,
    used: number,
    route: string,
    amount?: number,
  ): Promise<boolean>;
  gateFormat(
    req: IncomingMessage,
    res: ServerResponse,
    orgId: string,
    format: ExportFormat,
    route: string,
  ): Promise<boolean>;
  withAllowance(body: unknown, allowance: AllowanceHint | null): unknown;
  meterUsage(orgId: string, kind: UsageKind, quantity: number, metadata?: unknown): void;
  resolveAiContext(
    userId: string | undefined,
    board: StoredBoard | undefined,
  ): Promise<{ orgId: string | undefined; authoritative: boolean }>;
  /**
   * Drop a live room. A function rather than the `RealtimeServer` itself
   * because the server is constructed *after* the route table is built (it
   * needs the HTTP server, which needs the request handler), so this closes
   * over a `const` that is still in its TDZ at registration time and resolved
   * by the time a request can call it -- the same deferral the ladder got for
   * free from being inside the request handler.
   */
  evictBoard(boardId: string): void;
  /** docs/26 A6: detach one person from a board's live room (access removed). */
  detachFromBoard(boardId: string, userId: string): void;
  /**
   * docs/26 A6: org memberships, written to every store that keeps them (the
   * user store answers role checks; the org store lists members — one table
   * in Postgres, two in memory).
   */
  memberships: {
    set(membership: { userId: string; orgId: string; role: Role }): Promise<void>;
    remove(orgId: string, userId: string): Promise<void>;
  };
  /**
   * Stage B3: commit a proposal's ops into the board's live room, so the
   * approval broadcasts through the ordinary pipeline. Null when no room is
   * live or the user holds no role in it (the caller applies through the
   * store instead).
   */
  commitForBoard(
    boardId: string,
    userId: string,
    ops: Operation[],
    label: string,
    meta?: { requestId?: string; actor?: import("../boards.js").OperationActor },
  ): Promise<import("../room.js").CommitResult | null>;
  /**
   * Stage B3: fan a proposal event out to the board's live sockets. False
   * when nobody is connected — the store stays the durable record.
   */
  broadcastProposal(boardId: string, event: unknown): boolean;
}
