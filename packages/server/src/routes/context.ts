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
