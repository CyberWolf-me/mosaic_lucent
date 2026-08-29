import type { EmptyState, Handler } from "../http/router.js";
import {
  clampNotificationLimit,
  isNotificationKind,
  type NotificationCursor,
  type NotificationKind,
  type StoredNotification,
  type Toggle,
} from "../notifications.js";
import type { AppRouter, RouteServices } from "./context.js";

/** Tray page size when the client does not ask. Well under the store's cap. */
const NOTIFICATION_PAGE_DEFAULT = 30;

/**
 * Wire form of a NotificationCursor: `<createdAt>.<id>`. Readable on purpose --
 * an opaque blob here would hide the one thing worth seeing in a bug report --
 * and unambiguous because a notification id is `ntf_` plus base36 and hex, so
 * it never contains a dot.
 */
function encodeNotificationCursor(row: StoredNotification): string {
  return `${row.createdAt}.${row.id}`;
}

/**
 * `undefined` for "no cursor asked", `null` for "asked, but malformed". The
 * caller answers 400 to the second rather than silently serving page one, which
 * is how a client ends up looping over the same page forever.
 */
function parseNotificationCursor(raw: string | null): NotificationCursor | null | undefined {
  if (raw === null || raw.length === 0) return undefined;
  const dot = raw.indexOf(".");
  if (dot <= 0) return null;
  const createdAt = Number(raw.slice(0, dot));
  const id = raw.slice(dot + 1);
  if (!Number.isSafeInteger(createdAt) || createdAt < 0 || id.length === 0) return null;
  return { createdAt, id };
}

/**
 * The notification tray (M2.6).
 *
 * Every route here is scoped to the caller. `user.id` comes from the session and
 * never from the body or the path, so there is no request shape that reads or
 * writes another user's rows -- that is why these routes need no role check and
 * why `markRead` takes the user id as a predicate.
 *
 * Registered as two patterns feeding one handler rather than six method+path
 * routes, because the three steps before the method dispatch are the contract:
 * an unauthenticated request to a misspelled subpath answers 401, and a
 * configured-store-less deployment answers 503 -- not the 404 that six separate
 * registrations would produce for the misspelling. The `*rest` tail also keeps a
 * future `/api/notifications-digest` outside this block, which is what the old
 * prefix test's explicit trailing slash was for.
 */
export function registerNotificationRoutes(router: AppRouter, s: RouteServices): void {
  const { send, requireUser, requireCsrf, readBody, notificationStore } = s;

  const handler: Handler<EmptyState> = async (ctx) => {
    const { req, res } = ctx;
    const sub = ctx.params.rest ?? "";
    const method = req.method ?? "GET";

    const user = await requireUser(req, res);
    if (!user) return;
    if (!notificationStore) return send(res, 503, { error: "notifications not configured" });

    if (method === "GET" && sub === "") {
      const params = ctx.url.searchParams;
      const asked = Number(params.get("limit") ?? NOTIFICATION_PAGE_DEFAULT);
      const limit = clampNotificationLimit(
        Number.isFinite(asked) ? asked : NOTIFICATION_PAGE_DEFAULT,
      );
      const cursor = parseNotificationCursor(params.get("cursor"));
      if (cursor === null) return send(res, 400, { error: "invalid cursor" });
      const rows = await notificationStore.list(user.id, limit, cursor);
      // A full page means "ask again from here". It can hand out one cursor that
      // turns out to lead to an empty page; the alternative -- reading limit+1
      // rows -- silently loses the last page at the store's cap, because the
      // store clamps limit+1 back down to limit.
      const last = rows[rows.length - 1];
      const nextCursor =
        rows.length === limit && limit > 0 && last ? encodeNotificationCursor(last) : null;
      // The badge rides along: a tray that opens does not need a second call.
      const unread = await notificationStore.unreadCount(user.id);
      send(res, 200, { notifications: rows, nextCursor, unread });
      return;
    }

    if (method === "GET" && sub === "unread-count") {
      send(res, 200, { count: await notificationStore.unreadCount(user.id) });
      return;
    }

    if (method === "POST" && sub === "read") {
      if (!requireCsrf(req, res, "/api/notifications/read")) return;
      try {
        const raw = await readBody(req);
        const body = raw ? (JSON.parse(raw) as { id?: unknown }) : {};
        if (typeof body.id !== "string" || body.id.length === 0) {
          return send(res, 400, { error: "id is required" });
        }
        const changed = await notificationStore.markRead(user.id, body.id, Date.now());
        const count = await notificationStore.unreadCount(user.id);
        // `changed: false` is not an error: a double-tap on the tray, or an id
        // belonging to someone else, both mean "nothing to do here".
        send(res, 200, { changed, count });
      } catch (err) {
        send(res, 400, { error: "bad request", detail: (err as Error).message });
      }
      return;
    }

    if (method === "POST" && sub === "read-all") {
      if (!requireCsrf(req, res, "/api/notifications/read-all")) return;
      const changed = await notificationStore.markAllRead(user.id, Date.now());
      // Read back rather than asserting zero. The literal happens to be right
      // for a store that marks every row in one pass, but the tray takes this
      // number as the badge: the day a notification arrives mid-request, or a
      // store marks only what it listed, a hardcoded 0 hides an unread item
      // until the next poll. Every sibling route answers with a real count.
      const count = await notificationStore.unreadCount(user.id);
      send(res, 200, { changed, count });
      return;
    }

    if (method === "GET" && sub === "prefs") {
      send(res, 200, { prefs: await notificationStore.preferences(user.id) });
      return;
    }

    if (method === "PUT" && sub === "prefs") {
      if (!requireCsrf(req, res, "/api/notifications/prefs")) return;
      try {
        const raw = await readBody(req);
        const body = raw
          ? (JSON.parse(raw) as {
              kind?: unknown;
              inApp?: unknown;
              email?: unknown;
              reset?: unknown;
            })
          : {};
        if (typeof body.kind !== "string" || !isNotificationKind(body.kind)) {
          return send(res, 400, { error: "unknown notification kind" });
        }
        const kind: NotificationKind = body.kind;
        if (body.reset === true) {
          await notificationStore.clearPreference(user.id, kind);
        } else {
          // A partial update keeps the channel it does not mention, so a
          // settings screen can send one toggle without having to echo the
          // other and race a second tab into overwriting it.
          const current = await notificationStore.preference(user.id, kind);
          const pick = (value: unknown, fallback: Toggle): Toggle =>
            value === "on" || value === true
              ? "on"
              : value === "off" || value === false
                ? "off"
                : fallback;
          await notificationStore.setPreference({
            userId: user.id,
            kind,
            inApp: pick(body.inApp, current.inApp),
            email: pick(body.email, current.email),
            updatedAt: Date.now(),
          });
        }
        send(res, 200, { prefs: await notificationStore.preferences(user.id) });
      } catch (err) {
        send(res, 400, { error: "bad request", detail: (err as Error).message });
      }
      return;
    }

    // The block's own 404, reached only by an authenticated caller whose method
    // and subpath together name nothing here.
    send(res, 404, { error: "not found" });
  };

  router.any("/api/notifications", handler);
  router.any("/api/notifications/*rest", handler);
}
