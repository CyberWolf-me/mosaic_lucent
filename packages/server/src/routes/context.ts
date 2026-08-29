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
  applyAuthLimiter(
    req: IncomingMessage,
    res: ServerResponse,
    email: string,
    route: string,
  ): boolean;
  applyAccountLimiter(req: IncomingMessage, res: ServerResponse, route: string): boolean;
  applyMailLimiter(
    req: IncomingMessage,
    res: ServerResponse,
    email: string,
    route: string,
  ): boolean;

  // --- Seams ----------------------------------------------------------------
  notifyUser<K extends NotificationKind>(event: NotifyEvent<K>): void;
  gateMonthly(
    res: ServerResponse,
    orgId: string,
    key: MeteredEntitlementKey,
    route: string,
    amount?: number,
  ): Promise<AllowanceHint | null | false>;
  gateStanding(
    res: ServerResponse,
    orgId: string,
    key: NumericEntitlementKey,
    used: number,
    route: string,
    amount?: number,
  ): Promise<boolean>;
  gateFormat(
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
}
