import { randomBytes } from "node:crypto";
import { escapeHtml } from "./email/templates.js";
import type { Role } from "./identity.js";

/**
 * Notifications (M2.6).
 *
 * `notifications` and `notification_prefs` have been in `db/schema.ts` (435-478)
 * and shipped in `migrations/0008_platform_tables.sql` since M2.6 with no code on
 * either side of them: nothing wrote a row and nothing read one, so a user was
 * never told they had been invited to a board, mentioned in a comment, or added
 * to an org. This module is the missing half — the kind catalogue, the store
 * contract with its two implementations, and `notify()`.
 *
 * Four decisions shape everything below.
 *
 * 1. THE CATALOGUE IS THE SOURCE OF TRUTH. A kind is not a string a call site
 *    invents; it is an entry in `NOTIFICATION_CATALOGUE` that carries its own
 *    delivery defaults and its own text. `kind` stays free text in the column —
 *    a migration to widen an enum for every new notification would be absurd —
 *    but it is `NotificationKind` at every API boundary, so a route cannot
 *    record into a bucket nothing reads. Same reasoning as `USAGE_KINDS` in
 *    usageStore.ts.
 *
 * 2. ABSENCE MEANS DEFAULT. `notification_prefs` holds a row only once the user
 *    changes something (schema.ts:456-460). That is honoured rather than
 *    replaced by a defaults row per user, so a new kind is a change to this file
 *    and nothing else: no backfill, no migration. `resolvePreference` is the one
 *    place absence becomes a value, and both stores call it.
 *
 * 3. THE ROW STORES WHAT IT SAID. `title`/`body`/`link` are composed at write
 *    time and stored, never recomposed on read. A notification is a record of
 *    something that happened, so it has to keep reading correctly after the
 *    board is renamed, the inviter deletes their account, or the kind is retired
 *    by a later deploy. `metadata` keeps the payload that produced the text,
 *    which is what lets a client render a richer card without a second lookup.
 *
 * 4. READS ARE PER USER. The table's only index is
 *    `notifications_user_idx (user_id, created_at)`, so every read is keyed on
 *    the recipient and ordered by time; `orgId` is an attribute of a row, not a
 *    filter. That is also the right product answer — a tray that hid a
 *    notification because you had switched org would be a tray you cannot trust.
 */

/* ─────────────────────────────── kinds ──────────────────────────────────── */

/**
 * Every notification the product can actually emit today, with the data its
 * text is built from. This map is the source of truth: `NotificationKind` is its
 * keys, so adding an entry here is what adds a kind, and `NOTIFICATION_CATALOGUE`
 * will not compile until the new kind has defaults and a `compose`.
 *
 * Derived from the paths that exist, not from a wishlist. The plan's M2 bullet
 * asks for "in-app + email for invites, comment mentions, and share events;
 * per-user preferences", and each entry names where it comes from:
 *
 *   org.invited          POST /api/orgs/:id/invites            (app.ts:457)
 *   org.member_joined    POST /api/invites/accept              (app.ts:525)
 *   board.invited        POST /api/boards/:id/share            (app.ts:1083),
 *                        or any direct `boardStore.setMember` grant
 *   board.member_joined  POST /api/boards/:id/join             (app.ts:1025)
 *   board.role_changed   PATCH /api/boards/:id/members/:userId (app.ts:1175)
 *   comment.mention      ADD_COMMENT / REPLY_COMMENT whose body @-names a
 *                        member (core's `parseMentions`, committed through
 *                        `Room.commit`, room.ts:119)
 *   comment.reply        REPLY_COMMENT on a thread someone else started
 *
 * Deliberately absent: verification and password-reset mail (email/templates.ts)
 * is security mail, not notification — a preference must never be able to switch
 * it off, so it stays in accounts.ts and never acquires a kind. `receiptEmail`
 * belongs to billing, which is in flight; it gets a kind when a webhook exists
 * to emit one, and needs no migration then (decision 2).
 */
export interface NotificationPayloads {
  /** An org owner invited this address to their workspace. */
  "org.invited": {
    orgName: string;
    inviterName: string;
    role: Role;
    /**
     * Relative accept path, e.g. `/invite?token=…`, already URL-encoded by the
     * caller. Optional: pass it and the tray card accepts in one click, because
     * the token is the same capability the invite mail already carries and the
     * row is readable only by the user it belongs to. Omit it and the card is
     * informational — which is what a caller should do if it ever writes this
     * notification to anyone but the invitee.
     */
    acceptPath?: string;
  };
  /** An invite you sent was accepted. Goes to the inviter, not the joiner. */
  "org.member_joined": { orgName: string; memberName: string; orgId: string };
  /** You were given access to a board. */
  "board.invited": { boardId: string; boardName: string; inviterName: string; role: Role };
  /** Someone redeemed a link to your board. Goes to the board owner. */
  "board.member_joined": { boardId: string; boardName: string; memberName: string };
  /** Your role on a board was changed by an owner. */
  "board.role_changed": { boardId: string; boardName: string; role: Role; byName: string };
  /** A comment body @-named you. */
  "comment.mention": {
    boardId: string;
    boardName: string;
    authorName: string;
    /** The comment's body. Truncated for display; kept whole in `metadata`. */
    body: string;
    commentId: string;
  };
  /** Someone replied in a thread you started. */
  "comment.reply": {
    boardId: string;
    boardName: string;
    authorName: string;
    body: string;
    commentId: string;
  };
  /** You were invited to a scheduled meeting, or its plan changed (docs/28 A3.4). */
  "meeting.invited": {
    boardId: string;
    boardName: string;
    meetingId: string;
    title: string;
    scheduledFor: number;
    durationMin: number;
    hostName: string;
    /** True when this is a change to a meeting you were already invited to. */
    updated: boolean;
  };
  /** A meeting you were invited to was called off. */
  "meeting.cancelled": {
    boardId: string;
    boardName: string;
    meetingId: string;
    title: string;
    scheduledFor: number;
    durationMin: number;
    byName: string;
  };
}

export type NotificationKind = keyof NotificationPayloads;

/**
 * The same kinds at runtime, in the order a settings screen should list them.
 * The two guards below make the array and the type one thing: adding a kind to
 * `NotificationPayloads` without listing it here fails the build, and so does
 * listing a kind that does not exist.
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
] as const;

type ListedKind = (typeof NOTIFICATION_KINDS)[number];
/** Compile-time guard; mirrors the `Assignable` trick in presence.ts:54. */
type Assignable<Narrow extends Wide, Wide> = Narrow;
type _EveryKindIsListed = Assignable<Exclude<NotificationKind, ListedKind>, never>;
type _NoKindIsInvented = Assignable<Exclude<ListedKind, NotificationKind>, never>;

const KIND_SET: ReadonlySet<string> = new Set<string>(NOTIFICATION_KINDS);

/**
 * Narrow a string from the wire. The column is free text and a prefs request
 * body is untrusted input, so this is the gate between the two: a route rejects
 * an unknown kind rather than writing a preference nothing will ever read.
 */
export function isNotificationKind(value: string): value is NotificationKind {
  return KIND_SET.has(value);
}

/* ───────────────────────── text and delivery defaults ───────────────────── */

/** What a notification says. Composed once, at write time (decision 3). */
export interface NotificationContent {
  title: string;
  /** Secondary line. Null when the title says everything. */
  body: string | null;
  /** Relative app path, e.g. `/?board=b_1`. Null when there is nowhere to go. */
  link: string | null;
}

/** The column's enum, verbatim (`schema.ts:466-471`). */
export type Toggle = "on" | "off";

export interface NotificationDefaults {
  inApp: Toggle;
  email: Toggle;
}

interface NotificationSpec<Payload> {
  /** Label for the settings list. */
  label: string;
  /** One line of help under that label. */
  description: string;
  defaults: NotificationDefaults;
  compose: (payload: Payload) => NotificationContent;
}

/**
 * Deep-link shape the SPA understands: the board id is a query param on the
 * workspace route (`ui/Chrome.tsx:126`), not a path segment. Kept here so the
 * catalogue has one way to point at a board.
 */
function boardPath(boardId: string): string {
  return `/?board=${encodeURIComponent(boardId)}`;
}

/** A meeting's own page (docs/28 S3) on its board. */
export function meetingPath(boardId: string, meetingId: string): string {
  return `/?board=${encodeURIComponent(boardId)}&view=meeting&meeting=${encodeURIComponent(meetingId)}`;
}

/**
 * A meeting's time in words for a tray line or a mail. The server can't know
 * the reader's time zone, so it says UTC; the attached invite carries the
 * exact instant and every calendar shows it in local time.
 */
export function meetingWhen(scheduledFor: number, durationMin: number): string {
  const when = new Date(scheduledFor).toLocaleString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
  return `${when} UTC · ${durationMin} min`;
}

/** Comment bodies run to 2 000 characters; a tray line does not. */
const EXCERPT_MAX = 140;

function excerpt(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length <= EXCERPT_MAX ? flat : `${flat.slice(0, EXCERPT_MAX - 1)}…`;
}

/**
 * Per-kind text and delivery defaults.
 *
 * IN-APP defaults to on for every kind: the tray is the cheap channel, it is
 * pull rather than push, and a notification the user never asked to see costs
 * them one row.
 *
 * EMAIL is on only where one of two things is true, because email is the channel
 * users abandon a product over:
 *   - the notification carries something the recipient cannot get by opening the
 *     app later (an invite they have no other route to; a permission change that
 *     may have *removed* their access), or
 *   - it is a direct address to a person (an @mention).
 * Everything whose volume scales with team activity — someone joined, someone
 * replied — is in-app only. A user who wants those can switch them on; a user
 * who never opens settings gets a mailbox that stays usable, which is the
 * default that keeps the mails above out of a spam folder.
 */
export const NOTIFICATION_CATALOGUE: {
  readonly [K in NotificationKind]: NotificationSpec<NotificationPayloads[K]>;
} = {
  "org.invited": {
    label: "Workspace invitations",
    description: "When someone invites you to their workspace.",
    // The invite is the only route in, and the invitee may have no account yet.
    defaults: { inApp: "on", email: "on" },
    compose: (p) => ({
      title: `${p.inviterName} invited you to ${p.orgName}`,
      body: `You have been invited as ${roleWord(p.role)}.`,
      link: p.acceptPath ?? null,
    }),
  },
  "org.member_joined": {
    label: "Workspace members joining",
    description: "When someone accepts an invitation you sent.",
    // Scales with headcount, and the member list already shows it.
    defaults: { inApp: "on", email: "off" },
    compose: (p) => ({
      title: `${p.memberName} joined ${p.orgName}`,
      body: null,
      link: null,
    }),
  },
  "board.invited": {
    label: "Board invitations",
    description: "When you are given access to a board.",
    // Without the link the recipient cannot find the board at all.
    defaults: { inApp: "on", email: "on" },
    compose: (p) => ({
      title: `${p.inviterName} shared "${p.boardName}" with you`,
      body: `You can ${roleVerb(p.role)} this board.`,
      link: boardPath(p.boardId),
    }),
  },
  "board.member_joined": {
    label: "Board members joining",
    description: "When someone opens a board through a link you shared.",
    defaults: { inApp: "on", email: "off" },
    compose: (p) => ({
      title: `${p.memberName} joined "${p.boardName}"`,
      body: null,
      link: boardPath(p.boardId),
    }),
  },
  "board.role_changed": {
    label: "Board role changes",
    description: "When your role on a board changes.",
    // A permission change can take away what the user could do a minute ago;
    // finding that out by hitting a 403 is the worst way to learn it.
    defaults: { inApp: "on", email: "on" },
    compose: (p) => ({
      title: `Your role on "${p.boardName}" is now ${roleWord(p.role)}`,
      body: `Changed by ${p.byName}. You can ${roleVerb(p.role)} this board.`,
      link: boardPath(p.boardId),
    }),
  },
  "comment.mention": {
    label: "Mentions",
    description: "When someone @-mentions you in a comment.",
    // Addressed to this person by name; the whole point is that it reaches them.
    defaults: { inApp: "on", email: "on" },
    compose: (p) => ({
      title: `${p.authorName} mentioned you in "${p.boardName}"`,
      body: excerpt(p.body),
      link: boardPath(p.boardId),
    }),
  },
  "comment.reply": {
    label: "Comment replies",
    description: "When someone replies in a thread you started.",
    // Volume scales with how lively the thread is.
    defaults: { inApp: "on", email: "off" },
    compose: (p) => ({
      title: `${p.authorName} replied in "${p.boardName}"`,
      body: excerpt(p.body),
      link: boardPath(p.boardId),
    }),
  },
  "meeting.invited": {
    label: "Meeting invitations",
    description: "When you are invited to a meeting, or its time changes.",
    // An invite nobody sees is a meeting nobody comes to; the mail carries
    // the calendar invite.
    defaults: { inApp: "on", email: "on" },
    compose: (p) => ({
      title: p.updated
        ? `"${p.title}" changed — ${meetingWhen(p.scheduledFor, p.durationMin)}`
        : `${p.hostName} invited you to "${p.title}"`,
      body: `${meetingWhen(p.scheduledFor, p.durationMin)} · on "${p.boardName}"`,
      link: meetingPath(p.boardId, p.meetingId),
    }),
  },
  "meeting.cancelled": {
    label: "Cancelled meetings",
    description: "When a meeting you were invited to is called off.",
    defaults: { inApp: "on", email: "on" },
    compose: (p) => ({
      title: `${p.byName} cancelled "${p.title}"`,
      body: `It was set for ${meetingWhen(p.scheduledFor, p.durationMin)}.`,
      link: meetingPath(p.boardId, p.meetingId),
    }),
  },
};

/** `viewer` → "a viewer": role names read as prose in a sentence. */
function roleWord(role: Role): string {
  return role === "owner" ? "an owner" : `a ${role}`;
}

function roleVerb(role: Role): string {
  return role === "viewer" ? "view" : "edit";
}

/** Build a kind's text. The one call site for `compose`, so a caller cannot skip it. */
export function composeNotification<K extends NotificationKind>(
  kind: K,
  payload: NotificationPayloads[K],
): NotificationContent {
  return NOTIFICATION_CATALOGUE[kind].compose(payload);
}

/** The shipped defaults for a kind, used when the user has no pref row. */
export function defaultPreference(kind: NotificationKind): NotificationDefaults {
  return NOTIFICATION_CATALOGUE[kind].defaults;
}

/* ──────────────────────────── rows and cursors ──────────────────────────── */

/** One stored notification: the `notifications` row, in JS terms. */
export interface StoredNotification {
  id: string;
  userId: string;
  /**
   * The workspace the event happened in, or null for account-level events. The
   * column is nullable (`schema.ts:441`) and this is not a filter — see decision
   * 4 — it is what lets a card say which workspace it came from.
   */
  orgId: string | null;
  kind: NotificationKind;
  title: string;
  body: string | null;
  link: string | null;
  /** The payload the text was composed from. `{}` when there was none. */
  metadata: Record<string, unknown>;
  createdAt: number;
  /** When the user read it; null while unread. */
  readAt: number | null;
}

/** The write shape. Everything optional has a documented default. */
export interface NewNotification {
  /**
   * Supply it to make a retry safe: a second write of the same id is REJECTED
   * by the primary key rather than adding a second row, so a caller that retries
   * treats the rejection as "already delivered". Omitted, a fresh id is minted.
   */
  id?: string;
  userId: string;
  orgId: string | null;
  kind: NotificationKind;
  title: string;
  body?: string | null;
  link?: string | null;
  metadata?: unknown;
  createdAt: number;
  /** Pre-read, for a notification the user has already seen elsewhere. */
  readAt?: number | null;
}

/**
 * Page cursor: `(createdAt, id)`, exactly the shape and reasoning of
 * `AuditCursor` (orgs.ts) — two notifications written in the same millisecond
 * are ordinary here (one comment mentioning three people), so a `createdAt`-only
 * cursor would drop or repeat rows at a page boundary inside that millisecond.
 */
export interface NotificationCursor {
  createdAt: number;
  id: string;
}

/**
 * `ntf_` + base36 time + 3 random bytes: same construction as `newAuditId` in
 * orgs.ts, so ids sort by creation time and a cursor's `id` tiebreak is stable.
 */
export function newNotificationId(): string {
  return `ntf_${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
}

/** Hard cap on a page, so a client cannot ask for the whole table. */
export const NOTIFICATION_PAGE_MAX = 100;

/** Mirrors `clampAuditLimit` (orgs.ts): NaN, Infinity and negatives read nothing. */
export function clampNotificationLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 0;
  return Math.min(Math.max(Math.floor(limit), 0), NOTIFICATION_PAGE_MAX);
}

/**
 * JSONB semantics, applied in memory too. `undefined` has no JSON
 * representation and a Date becomes a string, so a test that passed on a richer
 * object than Postgres can store would be a test lying about production. A
 * non-object round-trip (a number, a string, null) becomes `{}` rather than a
 * `Record` that is not one.
 */
function normalizeMetadata(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  const round = JSON.parse(JSON.stringify(value)) as unknown;
  if (typeof round !== "object" || round === null || Array.isArray(round)) return {};
  return round as Record<string, unknown>;
}

/**
 * The single write-shape → row mapping, called by BOTH stores.
 *
 * This exists for the same reason `normalizeAuditEntry` does: the two stores
 * cannot be allowed to disagree about what a row is. The defect this repo
 * already shipped — a Postgres audit writer that was `void _entry;` while its
 * in-memory sibling passed every assertion — is a defect of two code paths, and
 * the fix is to have one. Idempotent, so a row read out of one store replays
 * into the other unchanged.
 */
export function normalizeNotification(entry: NewNotification): StoredNotification {
  return {
    id: entry.id ?? newNotificationId(),
    userId: entry.userId,
    orgId: entry.orgId,
    kind: entry.kind,
    title: entry.title,
    body: entry.body ?? null,
    link: entry.link ?? null,
    metadata: normalizeMetadata(entry.metadata),
    createdAt: entry.createdAt,
    readAt: entry.readAt ?? null,
  };
}

/** Newest first, ties broken by descending id. The SQL `ORDER BY`, in JS. */
export function compareNotificationDesc(a: StoredNotification, b: StoredNotification): number {
  if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

/** True when `row` sorts strictly after `cursor`, i.e. belongs on a later page. */
export function afterNotificationCursor(
  row: StoredNotification,
  cursor: NotificationCursor,
): boolean {
  if (row.createdAt !== cursor.createdAt) return row.createdAt < cursor.createdAt;
  return row.id < cursor.id;
}

/* ──────────────────────────── preferences ───────────────────────────────── */

/** One `notification_prefs` row. Exists only where the user changed something. */
export interface StoredNotificationPref {
  userId: string;
  kind: NotificationKind;
  inApp: Toggle;
  email: Toggle;
  updatedAt: number;
}

/**
 * What the delivery decision actually reads: the effective setting, plus whether
 * it came from a row. `explicit` is what a settings screen needs to show a
 * "reset to default" affordance, and what tells an operator debugging a missing
 * notification whether the user turned it off or the default did.
 */
export interface ResolvedPreference {
  kind: NotificationKind;
  inApp: Toggle;
  email: Toggle;
  explicit: boolean;
}

/**
 * Absence → default (decision 2). Both stores route every preference read
 * through here, so "no row" cannot mean one thing in memory and another in SQL.
 */
export function resolvePreference(
  kind: NotificationKind,
  row: StoredNotificationPref | undefined,
): ResolvedPreference {
  if (row) return { kind, inApp: row.inApp, email: row.email, explicit: true };
  const defaults = defaultPreference(kind);
  return { kind, inApp: defaults.inApp, email: defaults.email, explicit: false };
}

/** Resolve the whole catalogue for one user, in `NOTIFICATION_KINDS` order. */
export function resolvePreferences(rows: readonly StoredNotificationPref[]): ResolvedPreference[] {
  const byKind = new Map<NotificationKind, StoredNotificationPref>();
  for (const row of rows) byKind.set(row.kind, row);
  return NOTIFICATION_KINDS.map((kind) => resolvePreference(kind, byKind.get(kind)));
}

/* ────────────────────────────── the store ───────────────────────────────── */

/**
 * Persistence for notifications and preferences. Two implementations, one
 * contract, one test file over both (`test/notifications.test.ts`).
 *
 * Every read is keyed on `userId` first, which is not only tenancy but the
 * table's only index: `notifications_user_idx (user_id, created_at)`. The
 * Postgres implementation names the index it uses on each query
 * (`store/pg-notifications.ts`); the shapes here are chosen so those queries can
 * be index-only range scans rather than filters over a user's whole history.
 */
export interface NotificationStore {
  /**
   * Write one notification. Rejects a duplicate id — the column is a primary
   * key, and a notification is a record of something that happened, so an
   * overwrite is never the right answer. Pass `id` to make a retry rejectable
   * rather than duplicating.
   */
  create(entry: NewNotification): Promise<StoredNotification>;
  /**
   * One page for one user, newest first, keyset-paginated on `(createdAt, id)`.
   * `limit` is clamped by `clampNotificationLimit`, so 0 or a negative reads
   * nothing and an absurd value reads at most `NOTIFICATION_PAGE_MAX`.
   * Uses `notifications_user_idx`.
   */
  list(userId: string, limit: number, cursor?: NotificationCursor): Promise<StoredNotification[]>;
  /** How many of this user's notifications are unread. The tray badge. */
  unreadCount(userId: string): Promise<number>;
  /**
   * Mark one notification read. Returns true only when this call changed it, so
   * a second call is false and a notification belonging to another user is false
   * rather than an error — `userId` is a predicate on the write, which is what
   * keeps one user from marking another's rows.
   */
  markRead(userId: string, id: string, at: number): Promise<boolean>;
  /** Mark every unread notification read. Returns how many changed. */
  markAllRead(userId: string, at: number): Promise<number>;
  /** The effective setting for one kind, default included (decision 2). */
  preference(userId: string, kind: NotificationKind): Promise<ResolvedPreference>;
  /** Every kind resolved, in catalogue order — the settings screen's one query. */
  preferences(userId: string): Promise<ResolvedPreference[]>;
  /** Insert or replace one preference row. */
  setPreference(pref: StoredNotificationPref): Promise<void>;
  /**
   * Delete a preference row, returning the kind to its shipped default. Returns
   * whether a row was there — "reset" and "was already default" are different
   * answers to a settings screen.
   */
  clearPreference(userId: string, kind: NotificationKind): Promise<boolean>;
}

/** Detached copy, so a caller that mutates a read cannot rewrite stored history. */
function cloneNotification(row: StoredNotification): StoredNotification {
  return { ...row, metadata: normalizeMetadata(row.metadata) };
}

function prefKey(userId: string, kind: NotificationKind): string {
  return `${userId} ${kind}`;
}

/**
 * Process-local store: the whole story for offline dev and the default in tests.
 * Sorts, clamps and resolves preferences through the same helpers the SQL store
 * calls, so a green test here is a test of the same arithmetic.
 */
export class InMemoryNotificationStore implements NotificationStore {
  private readonly rows = new Map<string, StoredNotification>();
  private readonly prefs = new Map<string, StoredNotificationPref>();

  async create(entry: NewNotification): Promise<StoredNotification> {
    const row = normalizeNotification(entry);
    // Mirrors the primary key: append-only, never an overwrite.
    if (this.rows.has(row.id)) throw new Error(`notification ${row.id} already exists`);
    this.rows.set(row.id, row);
    return cloneNotification(row);
  }

  async list(
    userId: string,
    limit: number,
    cursor?: NotificationCursor,
  ): Promise<StoredNotification[]> {
    const max = clampNotificationLimit(limit);
    if (max === 0) return [];
    return [...this.rows.values()]
      .filter((r) => r.userId === userId)
      .filter((r) => cursor === undefined || afterNotificationCursor(r, cursor))
      .sort(compareNotificationDesc)
      .slice(0, max)
      .map(cloneNotification);
  }

  async unreadCount(userId: string): Promise<number> {
    let count = 0;
    for (const row of this.rows.values()) {
      if (row.userId === userId && row.readAt === null) count += 1;
    }
    return count;
  }

  async markRead(userId: string, id: string, at: number): Promise<boolean> {
    const row = this.rows.get(id);
    // Not found, someone else's, or already read: nothing changed.
    if (!row || row.userId !== userId || row.readAt !== null) return false;
    this.rows.set(id, { ...row, readAt: at });
    return true;
  }

  async markAllRead(userId: string, at: number): Promise<number> {
    let changed = 0;
    for (const [id, row] of this.rows) {
      if (row.userId !== userId || row.readAt !== null) continue;
      this.rows.set(id, { ...row, readAt: at });
      changed += 1;
    }
    return changed;
  }

  async preference(userId: string, kind: NotificationKind): Promise<ResolvedPreference> {
    return resolvePreference(kind, this.prefs.get(prefKey(userId, kind)));
  }

  async preferences(userId: string): Promise<ResolvedPreference[]> {
    return resolvePreferences([...this.prefs.values()].filter((p) => p.userId === userId));
  }

  async setPreference(pref: StoredNotificationPref): Promise<void> {
    this.prefs.set(prefKey(pref.userId, pref.kind), { ...pref });
  }

  async clearPreference(userId: string, kind: NotificationKind): Promise<boolean> {
    return this.prefs.delete(prefKey(userId, kind));
  }
}

/* ─────────────────────────────── delivery ───────────────────────────────── */

/**
 * The mailer, structurally typed exactly as `AuthContext` takes it
 * (`accounts.ts:226`) rather than as `Mailer` from `email/mailer.ts`.
 *
 * Two reasons, both the reason accounts.ts does it: this module then has no
 * import edge to the SMTP layer, and a test can pass a two-line stub — including
 * one that throws, which is a case that has to be exercised. The real `Mailer`
 * satisfies it.
 */
export interface NotificationMailer {
  send: (msg: { to: string; subject: string; text: string; html?: string }) => Promise<void>;
}

export interface NotifyDeps {
  store: NotificationStore;
  /**
   * Optional, and its absence is not an error: a deployment with no SMTP
   * configured delivers in-app only. Same contract as `AuthContext.mailer` — a
   * missing mailer degrades the feature, never throws.
   */
  mailer?: NotificationMailer;
  /**
   * Absolute origin (`https://app.example.com`), used to turn a notification's
   * relative `link` into a URL a mail client can follow. Without it a
   * notification that has a link is delivered in-app only: a mail whose link
   * goes nowhere is worse than no mail.
   */
  siteOrigin?: string;
  /** Product name in mail copy. Defaults to "Lucent". */
  productName?: string;
  /** Clock, for tests. Defaults to `Date.now()`. */
  now?: () => number;
}

/** Who is being told. No `email` means in-app only. */
export interface NotifyRecipient {
  userId: string;
  email?: string | null;
}

export interface NotifyEvent<K extends NotificationKind> {
  kind: K;
  to: NotifyRecipient;
  /** The workspace this happened in, or null for an account-level event. */
  orgId: string | null;
  payload: NotificationPayloads[K];
  /** Row id, to make a retried caller idempotent. */
  id?: string;
  /** Overrides `deps.now`, for a route that already has a request timestamp. */
  at?: number;
  /** Files the mail carries — a meeting's calendar invite (docs/28 A3.4). */
  attachments?: import("./email/mailer.js").MailAttachment[];
}

/** Why no email went out. Diagnostic only — none of these is an error. */
export type EmailSkipReason =
  | "preference"
  | "no-mailer"
  | "no-address"
  | "no-site-origin"
  | "send-failed";

export interface NotifyOutcome {
  kind: NotificationKind;
  /** The row written, or undefined when in-app delivery is off for this kind. */
  notification?: StoredNotification;
  /** True only once the mailer has accepted the message. */
  emailed: boolean;
  emailSkipped?: EmailSkipReason;
}

export interface NotificationMail {
  subject: string;
  text: string;
  html: string;
}

/**
 * Render a notification as mail. Deliberately generic over the kinds: the
 * catalogue already decided what the notification says, and a per-kind template
 * would be a second place for that text to drift from the tray. The per-flow
 * templates in `email/templates.ts` stay where they are — those are security mail
 * with their own copy, not notifications.
 */
export function notificationEmail(
  content: NotificationContent,
  ctx: { siteOrigin?: string; productName?: string },
): NotificationMail {
  const product = ctx.productName ?? "Lucent";
  const url = content.link && ctx.siteOrigin ? absoluteUrl(ctx.siteOrigin, content.link) : null;
  const lines = [content.title];
  if (content.body) lines.push("", content.body);
  if (url) lines.push("", `  ${url}`);
  lines.push("", `Choose which ${product} notifications reach your inbox in your settings.`);
  const parts = [`<p style="margin:0 0 12px">${escapeHtml(content.title)}</p>`];
  if (content.body) {
    parts.push(`<p style="margin:0 0 12px;color:#444">${escapeHtml(content.body)}</p>`);
  }
  if (url) {
    parts.push(
      `<p style="margin:0 0 12px"><a href="${escapeHtml(url)}">Open ${escapeHtml(product)}</a></p>`,
    );
  }
  parts.push(
    `<p style="margin:0;font-size:12px;color:#888">Choose which ${escapeHtml(product)}` +
      ` notifications reach your inbox in your settings.</p>`,
  );
  return {
    subject: content.title,
    text: `${lines.join("\n")}\n`,
    html: `<div style="font-family:system-ui,sans-serif;font-size:14px">${parts.join("")}</div>`,
  };
}

function absoluteUrl(origin: string, path: string): string {
  const base = origin.replace(/\/+$/, "");
  return path.startsWith("/") ? `${base}${path}` : `${base}/${path}`;
}

/**
 * Log a failed notification mail. Named after `logMailFailure`
 * (`accounts.ts:948-951`) and follows its rule: the user id, never the address.
 * Logs are read by more people than a mailbox is, and an address in a log line
 * outlives the incident that put it there.
 */
function logNotifyMailFailure(kind: NotificationKind, userId: string, err: unknown): void {
  console.warn(
    `[notify] ${kind} email failed for user=${userId}: ${(err as Error)?.message ?? String(err)}`,
  );
}

/**
 * Deliver one notification: resolve the user's preference for the kind, write the
 * in-app row when in-app is on, send the mail when email is on and a mailer
 * exists.
 *
 * Order matters. The row is written FIRST, so a mailer that throws — or a
 * deployment with no mailer at all — still leaves the notification in the tray.
 * The mail is the optional channel; the tray is the record.
 *
 * A send failure is logged and swallowed: nothing about telling someone their
 * role changed should be able to turn a successful role change into a 500. The
 * caller still learns about it from `emailSkipped`.
 *
 * Callers should treat the whole call as best effort (`void notify(…).catch(…)`)
 * for the same reason — a store failure here must not fail the request that
 * triggered it.
 */
export async function notify<K extends NotificationKind>(
  deps: NotifyDeps,
  event: NotifyEvent<K>,
): Promise<NotifyOutcome> {
  const at = event.at ?? (deps.now ? deps.now() : Date.now());
  const settings = await deps.store.preference(event.to.userId, event.kind);
  const content = composeNotification(event.kind, event.payload);
  const outcome: NotifyOutcome = { kind: event.kind, emailed: false };

  if (settings.inApp === "on") {
    outcome.notification = await deps.store.create({
      // Spread rather than `id: event.id`: `exactOptionalPropertyTypes` aside,
      // an explicit `undefined` would mean "no id" to the store anyway, and this
      // keeps the write shape honest about what the caller supplied.
      ...(event.id === undefined ? {} : { id: event.id }),
      userId: event.to.userId,
      orgId: event.orgId,
      kind: event.kind,
      title: content.title,
      body: content.body,
      link: content.link,
      // The payload, so a client can render a richer card than the stored text
      // and a kind retired by a later deploy still renders from what it said.
      metadata: event.payload,
      createdAt: at,
    });
  }

  if (settings.email === "off") {
    outcome.emailSkipped = "preference";
    return outcome;
  }
  if (!deps.mailer) {
    outcome.emailSkipped = "no-mailer";
    return outcome;
  }
  if (!event.to.email) {
    outcome.emailSkipped = "no-address";
    return outcome;
  }
  if (content.link !== null && !deps.siteOrigin) {
    outcome.emailSkipped = "no-site-origin";
    return outcome;
  }

  const mail = notificationEmail(content, {
    ...(deps.siteOrigin === undefined ? {} : { siteOrigin: deps.siteOrigin }),
    ...(deps.productName === undefined ? {} : { productName: deps.productName }),
  });
  try {
    await deps.mailer.send({
      to: event.to.email,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      ...(event.attachments && event.attachments.length > 0
        ? { attachments: event.attachments }
        : {}),
    });
    outcome.emailed = true;
  } catch (err) {
    logNotifyMailFailure(event.kind, event.to.userId, err);
    outcome.emailSkipped = "send-failed";
  }
  return outcome;
}
