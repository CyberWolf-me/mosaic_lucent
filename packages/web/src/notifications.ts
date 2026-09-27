import { apiFetch } from "./http.js";
import { hasSession } from "./session.js";

/**
 * The notification tray's client: the four calls it makes and the unread poller
 * behind its badge.
 *
 * The server half of M2.6 already shipped — `packages/server/src/notifications.ts`
 * owns the kind catalogue and the store, and `packages/server/src/app.ts` serves
 * six routes under `/api/notifications` — but nothing in the browser called any
 * of it, so a user was never told they had been invited to a board or mentioned
 * in a comment. This module is the missing half.
 *
 * Three decisions shape it.
 *
 * 1. THE WIRE CONTRACT IS COPIED, NOT IMPORTED. The browser bundle does not
 *    depend on the server package, so the shapes below are duplicated on
 *    purpose and pinned by the reference above — the same trade `api.ts` makes
 *    for the refusal contract.
 *
 * 2. FAILURE IS A VALUE. `boards.ts` answers `null` for "didn't ask, or the
 *    server said no", which is right for a call a user triggered and wrong for a
 *    background poller: the poller has to give up for good on a dead session but
 *    keep its last known count through a hiccup, and one `null` cannot tell
 *    those apart. Hence `NotificationResult`.
 *
 * 3. THE SERVER'S COUNT WINS. Every response that touches read state carries the
 *    unread count, and callers take the badge from there rather than deriving
 *    one from whatever rows they happen to be holding. A badge that disagrees
 *    with the list under it is the one failure this feature really has.
 */

/* ---------------------------------------------------------------- wire types */

/**
 * Kinds this build knows how to dress up, mirroring `NOTIFICATION_KINDS` in
 * `packages/server/src/notifications.ts`. Kept as a value (not just a type) so
 * the presentation table below can be checked exhaustively against it.
 */
export const NOTIFICATION_KINDS = [
  "org.invited",
  "org.member_joined",
  "board.invited",
  "board.member_joined",
  "board.role_changed",
  "comment.mention",
  "comment.reply",
  "meeting.invited",
  "meeting.cancelled",
  "meeting.summarized",
  "meeting.followup",
  "work.assigned",
  "work.blocked",
  "work.overdue",
  "review.pending",
  "automation.proposed",
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

const KNOWN_KINDS: ReadonlySet<string> = new Set<string>(NOTIFICATION_KINDS);

export function isNotificationKind(value: string): value is NotificationKind {
  return KNOWN_KINDS.has(value);
}

/**
 * One row as the server sends it. `userId` is on the stored row but not read
 * here: every route is scoped to the session, so the field can only ever be the
 * signed-in user and using it would invite code that pretends otherwise.
 */
export interface NotificationRow {
  id: string;
  orgId: string | null;
  /**
   * Typed as a plain string rather than `NotificationKind`: the column is text,
   * and a deploy can start writing a kind that this bundle — sitting in a tab
   * that has been open since yesterday — has never heard of. Narrowed with
   * `isNotificationKind` at the one point where it decides presentation, so an
   * unknown kind still renders from the title and body the server stored.
   */
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  metadata: Record<string, unknown>;
  createdAt: number;
  readAt: number | null;
}

export interface NotificationPage {
  notifications: NotificationRow[];
  /** Opaque `<createdAt>.<id>`; hand it back to read the next page. */
  nextCursor: string | null;
  /** The badge, from the same response as the rows. */
  unread: number;
}

export interface MarkReadOutcome {
  /**
   * False when the row was already read, is gone, or is not the caller's. Not
   * an error: two clicks on one card land here, and so does a tab acting on a
   * row another tab already read.
   */
  changed: boolean;
  /** Unread count after the write — the badge's new value. */
  count: number;
}

/** The server's own ceiling on `limit` (`NOTIFICATION_PAGE_MAX`). */
export const NOTIFICATION_PAGE_MAX = 100;

/* -------------------------------------------------------------------- results */

/**
 * Why a call did not produce a value. The split exists so a caller can tell a
 * permanent "stop asking" from a temporary "ask again later":
 * - `signed-out` — no session, or the server said 401. Nothing will improve
 *   until the user signs in again, so the poller stops.
 * - `unavailable` — 503: this deployment has no notification store configured.
 *   Also permanent for the life of the page; the tray hides itself.
 * - `offline` — `fetch` itself rejected. The server or the network is down, and
 *   neither says anything about the session.
 * - `error` — a 4xx/5xx or a body that would not parse. Transient by default,
 *   because the alternative is a tray that disables itself over one bad reply.
 */
export type NotificationFailure = "signed-out" | "unavailable" | "offline" | "error";

export type NotificationResult<T> =
  | { ok: true; value: T }
  | { ok: false; failure: NotificationFailure };

function failureFor(status: number): NotificationFailure {
  if (status === 401) return "signed-out";
  if (status === 503) return "unavailable";
  // A 403 lands here rather than in `signed-out`: on these routes it can only be
  // a CSRF rejection, which `apiFetch` has already retried once with a fresh
  // token, and which says nothing about whether the session is still good.
  return "error";
}

/**
 * One request, with the session gate, the status mapping and the JSON parse in
 * one place, so no route can grow its own idea of what a 401 means.
 */
async function request(path: string, init?: RequestInit): Promise<NotificationResult<unknown>> {
  // Same gate as `boards.ts`: a user without a session has no notifications, and
  // asking anyway would put a 401 in the console every minute.
  if (!hasSession()) return { ok: false, failure: "signed-out" };
  let res: Response;
  try {
    res = await apiFetch(path, init ?? {});
  } catch {
    return { ok: false, failure: "offline" };
  }
  if (!res.ok) return { ok: false, failure: failureFor(res.status) };
  try {
    return { ok: true, value: (await res.json()) as unknown };
  } catch {
    // 200 with a body that is not JSON is a proxy's error page, not an answer.
    return { ok: false, failure: "error" };
  }
}

/** A count we are willing to render: a whole number of things, never negative. */
function readCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Validate a row instead of casting one. Anything that reaches an `href` or a
 * `key` has to be the shape it claims to be, and a half-shaped row is dropped
 * rather than rendered as a card that cannot be clicked or dismissed — the same
 * call `session.ts` makes about a cached user.
 */
function readRow(value: unknown): NotificationRow | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const id = readString(raw.id);
  const kind = readString(raw.kind);
  const title = readString(raw.title);
  const createdAt = readCount(raw.createdAt);
  if (id === null || kind === null || title === null || createdAt === null) return null;
  const metadata =
    typeof raw.metadata === "object" && raw.metadata !== null && !Array.isArray(raw.metadata)
      ? (raw.metadata as Record<string, unknown>)
      : {};
  return {
    id,
    orgId: typeof raw.orgId === "string" ? raw.orgId : null,
    kind,
    title,
    body: typeof raw.body === "string" ? raw.body : null,
    link: typeof raw.link === "string" ? raw.link : null,
    metadata,
    createdAt,
    readAt: readCount(raw.readAt),
  };
}

/* ---------------------------------------------------------------------- calls */

/** `GET /api/notifications/unread-count` -> `{ count }`. */
export async function fetchUnreadCount(): Promise<NotificationResult<number>> {
  const res = await request("/api/notifications/unread-count");
  if (!res.ok) return res;
  const count = readCount((res.value as { count?: unknown }).count);
  return count === null ? { ok: false, failure: "error" } : { ok: true, value: count };
}

export interface FetchNotificationsOptions {
  /** Rows to ask for. The server defaults to 30 and clamps to 100. */
  limit?: number;
  /** `nextCursor` from the previous page. */
  cursor?: string;
}

/** `GET /api/notifications` -> `{ notifications, nextCursor, unread }`. */
export async function fetchNotifications(
  options: FetchNotificationsOptions = {},
): Promise<NotificationResult<NotificationPage>> {
  const params = new URLSearchParams();
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  if (options.cursor !== undefined) params.set("cursor", options.cursor);
  const query = params.toString();
  const res = await request(`/api/notifications${query ? `?${query}` : ""}`);
  if (!res.ok) return res;
  const body = res.value as { notifications?: unknown; nextCursor?: unknown; unread?: unknown };
  if (!Array.isArray(body.notifications)) return { ok: false, failure: "error" };
  const rows: NotificationRow[] = [];
  for (const entry of body.notifications) {
    const row = readRow(entry);
    if (row !== null) rows.push(row);
  }
  return {
    ok: true,
    value: {
      notifications: rows,
      nextCursor: readString(body.nextCursor),
      // The list route always sends the count; a missing one is a contract
      // break, and falling back to `rows.length` would invent a badge.
      unread: readCount(body.unread) ?? 0,
    },
  };
}

/** `POST /api/notifications/read` -> `{ changed, count }`. Mutating: CSRF-signed. */
export async function markNotificationRead(
  id: string,
): Promise<NotificationResult<MarkReadOutcome>> {
  const res = await request("/api/notifications/read", {
    method: "POST",
    body: JSON.stringify({ id }),
  });
  return readOutcome(res);
}

/**
 * `POST /api/notifications/read-all` -> `{ changed, count }`. Mutating.
 *
 * `count` is read back from the store by the route rather than assumed to be
 * zero, so a notification written between the update and the response is in the
 * number the badge renders. The caller takes it as given either way: computing
 * one here from `rows.length` would be a guess made with less information.
 */
export async function markAllNotificationsRead(): Promise<NotificationResult<MarkReadOutcome>> {
  const res = await request("/api/notifications/read-all", { method: "POST" });
  return readOutcome(res);
}

function readOutcome(res: NotificationResult<unknown>): NotificationResult<MarkReadOutcome> {
  if (!res.ok) return res;
  const body = res.value as { changed?: unknown; count?: unknown };
  const count = readCount(body.count);
  if (count === null) return { ok: false, failure: "error" };
  return { ok: true, value: { changed: body.changed === true, count } };
}

/* --------------------------------------------------------------- presentation */

/**
 * Icon slot for a card. Names rather than components: this module has no JSX in
 * it and is the half of the feature that tests can reach without a DOM.
 */
export type NotificationIcon =
  | "invite"
  | "member"
  | "role"
  | "comment"
  | "meeting"
  | "work"
  | "review"
  | "bell";

export interface NotificationView {
  id: string;
  /** The narrowed kind, or null for one this build does not know. */
  kind: NotificationKind | null;
  /**
   * Short category, rendered as text beside the card. The icon and the unread
   * dot are decoration; this is the same information in a form a screen reader
   * can read out.
   */
  category: string;
  icon: NotificationIcon;
  title: string;
  body: string | null;
  /** A vetted in-app path, or null when the card is informational. */
  href: string | null;
  createdAt: number;
  read: boolean;
}

/**
 * Copy for each kind. A mapped type over `NotificationKind`, so adding a kind to
 * `NOTIFICATION_KINDS` fails the build until it has human words to show —
 * mirroring the exhaustive catalogue the server keeps for the same reason.
 */
const KIND_COPY: {
  readonly [K in NotificationKind]: { category: string; icon: NotificationIcon };
} = {
  "org.invited": { category: "Workspace invite", icon: "invite" },
  "org.member_joined": { category: "New teammate", icon: "member" },
  "board.invited": { category: "Board invite", icon: "invite" },
  "board.member_joined": { category: "Board", icon: "member" },
  "board.role_changed": { category: "Access changed", icon: "role" },
  "comment.mention": { category: "Mention", icon: "comment" },
  "comment.reply": { category: "Reply", icon: "comment" },
  "meeting.invited": { category: "Meeting", icon: "invite" },
  "meeting.cancelled": { category: "Meeting cancelled", icon: "invite" },
  "meeting.summarized": { category: "Meeting summary", icon: "meeting" },
  "meeting.followup": { category: "Your actions", icon: "work" },
  "work.assigned": { category: "Assigned to you", icon: "work" },
  "work.blocked": { category: "Blocked", icon: "work" },
  "work.overdue": { category: "Overdue", icon: "work" },
  "review.pending": { category: "To review", icon: "review" },
  "automation.proposed": { category: "Proposed for review", icon: "review" },
};

/**
 * What an unrecognised kind gets. Not an error state: the server stores the
 * words it composed at write time precisely so a row outlives the code that
 * wrote it, and a card with a generic label still tells the user what happened.
 */
const UNKNOWN_COPY = { category: "Notification", icon: "bell" } as const;

/**
 * The board deep link this SPA understands, mirroring `boardPath` in the
 * server's notification module.
 */
function boardPath(boardId: string): string {
  return `/?board=${encodeURIComponent(boardId)}`;
}

/**
 * Accept only a path that stays inside this app.
 *
 * Both `link` and `metadata` arrive as stored JSON, and `org.invited` composes
 * its link from an `acceptPath` its caller passed in — so by the time a value
 * reaches an `href` it is data, and "our own server sent it" is not a reason to
 * trust it. `javascript:` is the obvious one to refuse; `//evil.example` is the
 * one that looks relative and is not, and `/\evil.example` is the same trick
 * spelled with the separator browsers normalise.
 */
export function safeRelativePath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const path = value.trim();
  if (!path.startsWith("/") || path.startsWith("//")) return null;
  if (path.includes("\\")) return null;
  return path;
}

/**
 * Where a card goes. The stored `link` first — the server composed it at write
 * time and it is what any email about the same event pointed at — then a
 * fallback derived from the payload, which is what keeps an older row clickable
 * after a composer changed. Null means "render as text".
 */
function linkFor(kind: NotificationKind | null, row: NotificationRow): string | null {
  const stored = safeRelativePath(row.link);
  if (stored !== null) return stored;
  if (kind === "org.invited") return safeRelativePath(row.metadata.acceptPath);
  // Every board-scoped kind carries `boardId` in its payload.
  const boardId = row.metadata.boardId;
  return typeof boardId === "string" && boardId.length > 0 ? boardPath(boardId) : null;
}

/** Everything the tray needs to render one row, and nothing it has to decide. */
export function describeNotification(row: NotificationRow): NotificationView {
  const kind = isNotificationKind(row.kind) ? row.kind : null;
  const copy = kind !== null ? KIND_COPY[kind] : UNKNOWN_COPY;
  return {
    id: row.id,
    kind,
    category: copy.category,
    icon: copy.icon,
    title: row.title,
    body: row.body,
    href: linkFor(kind, row),
    createdAt: row.createdAt,
    read: row.readAt !== null,
  };
}

/**
 * Compact age for a card: the same ladder as the comment panel's `timeLabel`,
 * duplicated rather than shared because that one is private to a view and this
 * module must not reach into one. `now` is a parameter so the ladder is testable
 * without freezing the clock.
 */
export function notificationAge(createdAt: number, now: number): string {
  const mins = Math.floor((now - createdAt) / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Absolute time, for the tooltip behind the compact age. */
export function notificationTimestamp(createdAt: number): string {
  return new Date(createdAt).toLocaleString();
}

/**
 * The trigger's accessible name. The count belongs *in the name*, not only in
 * the badge: a badge is a visual, and a name that says "Notifications, 3 unread"
 * is the same fact for someone who never sees it.
 */
export function unreadLabel(count: number): string {
  if (count <= 0) return "Notifications, none unread";
  return `Notifications, ${count === 1 ? "1 unread" : `${count} unread`}`;
}

/**
 * What the live region says when the count changes. Empty at zero so a quiet
 * tray announces nothing on load and nothing when the last card is read.
 */
export function unreadAnnouncement(count: number): string {
  if (count <= 0) return "";
  return count === 1 ? "1 unread notification" : `${count} unread notifications`;
}

/** Badge text. Past 99 the pill would stop being a pill. */
export function badgeText(count: number): string {
  return count > 99 ? "99+" : String(count);
}

/* ------------------------------------------------------------- unread poller */

/**
 * How often a visible tab asks for the count. A minute is slow enough that a
 * hundred open tabs are not a load problem and fast enough that a mention feels
 * like it arrived rather than like it was found later.
 */
export const UNREAD_POLL_MS = 60_000;

/**
 * Floor between two wake-driven fetches. Returning to the window fires both
 * `visibilitychange` and `focus`, and a user flicking between two windows fires
 * them repeatedly; the in-flight guard swallows the simultaneous pair, and this
 * swallows the burst.
 */
const WAKE_MIN_GAP_MS = 5_000;

export interface UnreadPollOptions {
  /** A count that came from the server. Never a guess and never a stale value. */
  onCount: (count: number) => void;
  /**
   * The poller has stopped for good: the session is gone, or this deployment has
   * no notification store. Both mean the tray should take itself off the bar
   * rather than sit there showing a number it can no longer confirm.
   */
  onStopped?: (failure: "signed-out" | "unavailable") => void;
  /** Overridable for tests; production uses `UNREAD_POLL_MS`. */
  intervalMs?: number;
}

function documentHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/**
 * Poll the unread count. Returns the stop function.
 *
 * WHY POLLING AND NOT THE REALTIME SOCKET. The workspace already holds a live
 * WebSocket, and pushing counts down it would cost nothing per update — but that
 * socket is scoped to one board (a room is keyed by board id) and it only exists
 * while a board is open. Notifications are account-scoped by design: an invite
 * to a board you cannot open yet, a mention in a board you closed an hour ago, a
 * workspace invite that lands while you are on the dashboard. A user with no
 * board open must still get them, so the tray asks its own account-scoped
 * endpoint and stays independent of whether any room is joined. Pushing these
 * over a socket is a fair optimisation later, and it needs an account-scoped
 * channel to exist first.
 *
 * A HIDDEN TAB DOES NOT POLL AT ALL. The interval is cleared when the document
 * goes hidden and one fetch fires the moment it comes back, so a tab left open
 * over a weekend costs nothing and still shows a current badge as soon as it is
 * looked at. Both `visibilitychange` and `focus` are listened to because they are
 * not the same event: switching tabs changes visibility without a focus change,
 * and switching to another application and back fires focus while the tab was
 * visible the whole time.
 *
 * NOTHING ESCAPES. A failed poll is a no-op that leaves the last known count
 * alone — zeroing the badge because one request timed out would be worse than
 * showing a count a minute old. Only the two permanent failures stop it, because
 * a poller that 401s once a minute forever is just noise in a log.
 */
export function startUnreadPoll(options: UnreadPollOptions): () => void {
  const intervalMs = options.intervalMs ?? UNREAD_POLL_MS;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  let inFlight = false;
  let lastAttemptAt = 0;

  // Declared as hoisted functions: these four refer to each other in a cycle
  // (stop -> detach -> the handlers -> refresh -> stop) that no ordering of
  // `const` arrows can satisfy.
  function clearTimer(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  function detach(): void {
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onWake);
    }
    if (typeof window !== "undefined") window.removeEventListener("focus", onWake);
  }

  function stop(): void {
    stopped = true;
    clearTimer();
    detach();
  }

  async function refresh(reason: "tick" | "wake"): Promise<void> {
    if (stopped || inFlight) return;
    const now = Date.now();
    if (reason === "wake" && now - lastAttemptAt < WAKE_MIN_GAP_MS) return;
    lastAttemptAt = now;
    inFlight = true;
    let result: NotificationResult<number>;
    try {
      // `fetchUnreadCount` resolves rather than throwing, so this is belt and
      // braces — but the contract this function advertises is "never throws",
      // and that has to hold even after someone edits the call above.
      result = await fetchUnreadCount();
    } finally {
      inFlight = false;
    }
    // The tab may have been closed, or the session dropped, while we waited.
    if (stopped) return;
    if (result.ok) {
      options.onCount(result.value);
      return;
    }
    if (result.failure === "signed-out" || result.failure === "unavailable") {
      stop();
      options.onStopped?.(result.failure);
    }
    // `offline` and `error`: keep the last known count and try the next tick.
  }

  function resume(): void {
    if (stopped) return;
    clearTimer();
    timer = setInterval(() => void refresh("tick"), intervalMs);
    void refresh("wake");
  }

  function onWake(): void {
    if (documentHidden()) clearTimer();
    else resume();
  }

  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onWake);
  if (typeof window !== "undefined") window.addEventListener("focus", onWake);
  // A tab restored into the background starts with listeners and no interval; it
  // begins polling the first time it is actually looked at.
  if (!documentHidden()) resume();

  return stop;
}
