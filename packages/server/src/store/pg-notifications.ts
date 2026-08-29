import { and, desc, eq, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  notificationPrefs,
  notifications,
  type DbNotification,
  type DbNotificationPref,
} from "../db/schema.js";
import {
  clampNotificationLimit,
  isNotificationKind,
  normalizeNotification,
  resolvePreference,
  resolvePreferences,
  type NewNotification,
  type NotificationCursor,
  type NotificationKind,
  type NotificationStore,
  type ResolvedPreference,
  type StoredNotification,
  type StoredNotificationPref,
} from "../notifications.js";

/**
 * Postgres-backed NotificationStore (M2.6). Same contract as
 * `InMemoryNotificationStore`, verified by the same test file, so the request
 * path cannot tell which one it has.
 *
 * This parity is the deliverable rather than a nicety. The audit trail shipped
 * with a Postgres writer that was `void _entry;` and a reader that returned `[]`
 * while its in-memory sibling passed every assertion — a green suite over a
 * feature that did nothing in production. So the write shape is built by
 * `normalizeNotification` and the preference default by `resolvePreference`, both
 * shared with the in-memory store: the two implementations here are the SQL, not
 * a second opinion about what a row means.
 *
 * Three things the SQL does not say on its own:
 *   - every read leads with `user_id` because that is the leading column of
 *     `notifications_user_idx (user_id, created_at)`, the table's only index;
 *     each method below names the index it rides and the plan it produces;
 *   - `count()` arrives as int8, which node-postgres hands over as a string to
 *     avoid losing precision, so the badge count is coerced explicitly;
 *   - `kind` is text in the column on purpose (adding a notification must not
 *     need a migration), so it is narrowed on the way out, not trusted.
 */
export class PostgresNotificationStore implements NotificationStore {
  constructor(private readonly target: Db) {}

  /**
   * INDEX USE: none needed — the insert maintains the primary key on `id` and
   * `notifications_user_idx`. No `ON CONFLICT`: `id` is a primary key and a
   * notification is a record of something that happened, so a duplicate id
   * raises rather than overwriting, exactly as the in-memory store does.
   * `RETURNING` is what makes the returned row the stored row — including the
   * JSONB round trip, so a caller cannot be handed metadata Postgres would not
   * have kept.
   */
  async create(entry: NewNotification): Promise<StoredNotification> {
    const row = normalizeNotification(entry);
    const written = await this.target.db.insert(notifications).values(row).returning();
    // `RETURNING` on a single-row insert cannot come back empty; the fallback
    // keeps the type honest rather than asserting non-null.
    return written[0] ? rowToNotification(written[0]) : row;
  }

  /**
   * One page for one user, newest first.
   *
   * INDEX USE. Both branches ride `notifications_user_idx (user_id, created_at)`
   * — the same shape as `audit_log_org_at_idx`, so the same plan: `user_id` is an
   * equality on the leading key and `created_at` is the second, so the planner
   * walks the index backwards and `LIMIT` stops the walk at the page boundary
   * instead of sorting the user's whole history. The `id DESC` tiebreak is
   * settled by an Incremental Sort over each equal-`created_at` group
   * (`Presorted Key: created_at`), never by re-sorting the result.
   *
   * The paginated branch adds `created_at <= cursor.createdAt`, which is the
   * range bound that lets the walk START at the cursor. The OR term cannot be a
   * bound, but it only rechecks the rows sharing the boundary millisecond, so it
   * cannot cost more than that one group. Keying on `(createdAt, id)` rather
   * than `createdAt` alone is what makes the boundary exact, and here that is not
   * a theoretical case: one comment that @-mentions three people writes three
   * rows in the same millisecond, and a `createdAt`-only cursor would repeat or
   * skip them.
   *
   * Measured on 30k rows / 600 in this user's tray, `EXPLAIN (ANALYZE, BUFFERS)`
   * for a 50-row page: `Index Scan Backward using notifications_user_idx`, 39-40
   * shared buffer hits, 51 index rows touched, `Incremental Sort` with
   * `Presorted Key: created_at`. The paginated branch shows the cursor inside the
   * index condition — `Index Cond: (user_id = … AND created_at <= …)` — with the
   * OR term as a `Filter`, which is the shape this comment claims: a range bound
   * plus a recheck confined to the boundary group. No seq scan, no full sort.
   */
  async list(
    userId: string,
    limit: number,
    cursor?: NotificationCursor,
  ): Promise<StoredNotification[]> {
    const max = clampNotificationLimit(limit);
    if (max === 0) return [];
    const rows = await this.target.db
      .select()
      .from(notifications)
      .where(
        cursor === undefined
          ? eq(notifications.userId, userId)
          : and(
              eq(notifications.userId, userId),
              lte(notifications.createdAt, cursor.createdAt),
              or(lt(notifications.createdAt, cursor.createdAt), lt(notifications.id, cursor.id)),
            ),
      )
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(max);
    return rows.map(rowToNotification);
  }

  /**
   * INDEX USE: `notifications_user_idx`, leading column only — the equality on
   * `user_id` bounds the scan to one user's rows and `read_at IS NULL` is a
   * filter over them. That is the right cost today (a tray is capped by what a
   * human generates) and the follow-up when it stops being is a partial index,
   * `(user_id) WHERE read_at IS NULL`, which turns this into a count of exactly
   * the rows it wants. That needs a migration, which this step does not own.
   *
   * Measured on the same 30k rows: `Bitmap Index Scan on notifications_user_idx`
   * then `Filter: (read_at IS NULL)`, `Rows Removed by Filter: 600` — the whole
   * tray read to answer a badge. Fine at the volume one human generates, and
   * exactly the cost the partial index would delete.
   *
   * `count()` is int8: node-postgres returns it as a string rather than lose
   * precision, so it goes through `toNumber` instead of being trusted.
   */
  async unreadCount(userId: string): Promise<number> {
    const rows = await this.target.db
      .select({ count: sql<string>`count(*)` })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
    return toNumber(rows[0]?.count);
  }

  /**
   * INDEX USE: the primary key on `id` finds the row; `user_id` is a predicate on
   * the UPDATE, not a lookup. That is deliberate and it is the tenancy boundary —
   * a request that guesses another user's notification id updates zero rows and
   * gets `false`, so no route can leak or mutate someone else's tray even if it
   * forgets to check. `read_at IS NULL` makes the answer mean "this call changed
   * it", which is what keeps a double-click from reporting two reads.
   *
   * Measured: `Index Scan using notifications_pkey`, `Filter: ((read_at IS NULL)
   * AND (user_id = …))`, 4 shared buffer hits.
   */
  async markRead(userId: string, id: string, at: number): Promise<boolean> {
    const updated = await this.target.db
      .update(notifications)
      .set({ readAt: at })
      .where(
        and(
          eq(notifications.id, id),
          eq(notifications.userId, userId),
          isNull(notifications.readAt),
        ),
      )
      .returning({ id: notifications.id });
    return updated.length > 0;
  }

  /**
   * INDEX USE: `notifications_user_idx` on its leading column again, with
   * `read_at IS NULL` as the filter — and the same partial-index follow-up as
   * `unreadCount`. `RETURNING` gives the affected-row count without a second
   * statement, the idiom `pg-usage.ts` uses for the same purpose.
   */
  async markAllRead(userId: string, at: number): Promise<number> {
    const updated = await this.target.db
      .update(notifications)
      .set({ readAt: at })
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
      .returning({ id: notifications.id });
    return updated.length;
  }

  /**
   * INDEX USE: the composite primary key `(user_id, kind)` — a single-row lookup.
   *
   * A missing row is not a missing preference: absence means the shipped default
   * (schema.ts:456-460), and `resolvePreference` is where that becomes a value,
   * shared with the in-memory store so "no row" cannot mean two things.
   */
  async preference(userId: string, kind: NotificationKind): Promise<ResolvedPreference> {
    const rows = await this.target.db
      .select()
      .from(notificationPrefs)
      .where(and(eq(notificationPrefs.userId, userId), eq(notificationPrefs.kind, kind)))
      .limit(1);
    const row = rows[0];
    return resolvePreference(kind, row ? rowToPref(row) : undefined);
  }

  /**
   * INDEX USE: the primary key's leading column `(user_id)` — one scan of at most
   * `NOTIFICATION_KINDS.length` rows, never one query per kind.
   *
   * `resolvePreferences` fills in every kind the build knows about, so a row for
   * a kind this build does not know (written by a newer deploy, then rolled back)
   * is dropped rather than shown as a setting for something that no longer exists.
   */
  async preferences(userId: string): Promise<ResolvedPreference[]> {
    const rows = await this.target.db
      .select()
      .from(notificationPrefs)
      .where(eq(notificationPrefs.userId, userId));
    const known: StoredNotificationPref[] = [];
    for (const row of rows) {
      if (isNotificationKind(row.kind)) known.push(rowToPref(row));
    }
    return resolvePreferences(known);
  }

  /**
   * INDEX USE: the composite primary key is the conflict target, so this is one
   * statement whether or not the user has touched this kind before — which is the
   * whole reason the table has no defaults row per user.
   */
  async setPreference(pref: StoredNotificationPref): Promise<void> {
    await this.target.db
      .insert(notificationPrefs)
      .values({
        userId: pref.userId,
        kind: pref.kind,
        inApp: pref.inApp,
        email: pref.email,
        updatedAt: pref.updatedAt,
      })
      .onConflictDoUpdate({
        target: [notificationPrefs.userId, notificationPrefs.kind],
        set: { inApp: pref.inApp, email: pref.email, updatedAt: pref.updatedAt },
      });
  }

  /**
   * INDEX USE: the composite primary key again. Deleting the row is how a kind
   * goes back to its shipped default — storing "the default" as an explicit row
   * would freeze today's default into the user's account, so that a later change
   * to the catalogue would not reach the users who never disagreed with it.
   */
  async clearPreference(userId: string, kind: NotificationKind): Promise<boolean> {
    const deleted = await this.target.db
      .delete(notificationPrefs)
      .where(and(eq(notificationPrefs.userId, userId), eq(notificationPrefs.kind, kind)))
      .returning({ kind: notificationPrefs.kind });
    return deleted.length > 0;
  }
}

/**
 * Row → read shape.
 *
 * `kind` is cast rather than dropped when this build does not know it. A
 * notification stores the text it was written with (title, body, link), so a row
 * from a newer deploy still renders correctly after a rollback; dropping it would
 * silently lose something the user was told. The cast is confined here, writes go
 * through `NotificationKind`, and the value only ever chooses an icon — so the
 * failure mode of being wrong is a generic icon, not a broken tray. Compare
 * `rowToStoredPlan` in pg-usage.ts, which does drop a bad row: there the parsed
 * value decides entitlements, and a wrong one would fail open.
 */
function rowToNotification(row: DbNotification): StoredNotification {
  return {
    id: row.id,
    userId: row.userId,
    orgId: row.orgId,
    kind: row.kind as NotificationKind,
    title: row.title,
    body: row.body,
    link: row.link,
    // The column is nullable; the read shape is not, so "no metadata" is `{}` in
    // both stores rather than null in one and `{}` in the other.
    metadata: asMetadata(row.metadata),
    createdAt: row.createdAt,
    readAt: row.readAt,
  };
}

/** Row → preference. Callers narrow `kind` before this; see `preferences`. */
function rowToPref(row: DbNotificationPref): StoredNotificationPref {
  return {
    userId: row.userId,
    kind: row.kind as NotificationKind,
    inApp: row.inApp,
    email: row.email,
    updatedAt: row.updatedAt,
  };
}

/** JSONB is `unknown` at the type level and anything at all in the column. */
function asMetadata(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

/**
 * Postgres returns `count()` as int8, which node-postgres hands over as a string
 * rather than silently lose precision. Same helper, same reason, as `toNumber` in
 * pg-usage.ts — private there, so this is a local copy rather than an import edge
 * between two stores.
 */
function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}
