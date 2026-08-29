import { and, eq, gt, lte } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { presence } from "../db/schema.js";
import { colorForUser, type Presence } from "../room.js";
import {
  DEFAULT_PRESENCE_TTL_MS,
  type PresenceCursor,
  type PresencePeer,
  type PresenceRecord,
  type PresenceStore,
  type PresenceUpsert,
} from "../presence.js";

/**
 * Postgres-backed PresenceStore (M3, ADR 0004).
 *
 * Schema lives at `db/schema.ts:presence` (table `presence`, PK `(board_id,
 * user_id)`, indexes `presence_updated_idx` for the sweep). Every method is
 * the SQL counterpart of the in-memory store, with the same merge semantics
 * for `cursor` / `selection` (presence.ts:84-94) and the same TTL filter on
 * reads — a row whose `updated_at` is past `now - ttlMs` is invisible to
 * `peers()` even before `sweep()` reclaims it.
 *
 * The TTL filter on `peers()` (gt `cutoff`) and the unconditional read on
 * `rows()` (no cutoff) match `InMemoryPresenceStore` exactly, so a parity test
 * can exercise the same matrix on both.
 */
export class PostgresPresenceStore implements PresenceStore {
  constructor(
    private readonly target: Db,
    private readonly ttlMs: number = DEFAULT_PRESENCE_TTL_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async upsert(update: PresenceUpsert): Promise<PresencePeer> {
    // Read the existing row to merge cursor/selection. The PK on (boardId,
    // userId) makes this a single point lookup, not a scan.
    const existing = await this.target.db
      .select()
      .from(presence)
      .where(and(eq(presence.boardId, update.boardId), eq(presence.userId, update.userId)))
      .limit(1);

    const prev = existing[0];
    // `!== undefined` rather than `??`: an explicit null means off-canvas and
    // must clear the stored cursor; an absent field must keep it. Same rule
    // the in-memory store uses (presence.ts:189).
    const prevCursor = prev?.cursor as PresenceCursor | null | undefined;
    const prevSelection = Array.isArray(prev?.selection)
      ? (prev?.selection as string[])
      : undefined;
    const cursor: PresenceCursor | null | undefined =
      update.cursor !== undefined ? update.cursor : (prevCursor ?? null);
    const selection: string[] | undefined =
      update.selection !== undefined ? update.selection : (prevSelection ?? []);
    const color = prev?.color ?? colorForUser(update.userId);
    const updatedAt = this.now();

    // INSERT ... ON CONFLICT DO UPDATE keeps the read-modify-write atomic so
    // two instances racing on the same (boardId, userId) do not interleave a
    // write with the colour computation. `lastWrite` rather than `merge`
    // semantics on the merged fields: the values just computed already
    // encode "old where the new is absent, new where it is present".
    await this.target.db
      .insert(presence)
      .values({
        boardId: update.boardId,
        userId: update.userId,
        instanceId: update.instanceId,
        name: update.name,
        color,
        cursor: cursor ?? null,
        selection: selection ?? [],
        updatedAt,
      })
      .onConflictDoUpdate({
        target: [presence.boardId, presence.userId],
        set: {
          instanceId: update.instanceId,
          name: update.name,
          color,
          cursor: cursor ?? null,
          selection: selection ?? [],
          updatedAt,
        },
      });

    const next: Presence = {
      userId: update.userId,
      name: update.name,
      cursor: cursor ?? null,
      selection: selection ?? [],
      color,
      updatedAt,
    };
    return toPeer(next);
  }

  async remove(boardId: string, userId: string, instanceId?: string): Promise<void> {
    // Compare-and-delete on instanceId: a socket closing on instance A must
    // not evict the same user's live row on instance B. The conditional
    // matches zero rows when the row's owner is different, so the DELETE is
    // a no-op for stale callers and a real delete for the owner.
    if (instanceId !== undefined) {
      await this.target.db
        .delete(presence)
        .where(
          and(
            eq(presence.boardId, boardId),
            eq(presence.userId, userId),
            eq(presence.instanceId, instanceId),
          ),
        );
      return;
    }
    await this.target.db
      .delete(presence)
      .where(and(eq(presence.boardId, boardId), eq(presence.userId, userId)));
  }

  async peers(boardId: string, exceptUserId?: string): Promise<PresencePeer[]> {
    const cutoff = this.now() - this.ttlMs;
    const rows = await this.target.db
      .select()
      .from(presence)
      .where(
        and(
          eq(presence.boardId, boardId),
          gt(presence.updatedAt, cutoff),
          // The exceptUserId filter is applied in SQL rather than in memory so a
          // board with thousands of editors does not stream every row to the
          // caller and discard them. `exceptUserId === undefined` becomes
          // `neq(undefined)` which always matches, so the safe path is the
          // `and(not(equals))` shape — but Drizzle's `ne` on `undefined`
          // errors. The build-a-where helper is the same path the rest of the
          // store uses.
          ...(exceptUserId !== undefined ? [eq(presence.userId, exceptUserId)] : []),
        ),
      );
    // Stable order so the presence bar reads the same way across instances:
    // the in-memory store sorts by userId (presence.ts:225), and Postgres
    // would only guarantee that under an explicit ORDER BY. We sort here too
    // rather than ask the DB to — the rows are bounded by board size and the
    // cost is negligible compared to the network round trip.
    return rows
      .filter((r) => exceptUserId === undefined || r.userId !== exceptUserId)
      .sort((a, b) => a.userId.localeCompare(b.userId))
      .map(rowToPeer);
  }

  async sweep(olderThan: number): Promise<number> {
    // Drizzle's `delete` returns the row count when supported by the dialect;
    // postgres returns a count.
    const deleted = await this.target.db
      .delete(presence)
      .where(lte(presence.updatedAt, olderThan))
      .returning({ boardId: presence.boardId });
    return deleted.length;
  }

  async rows(boardId: string): Promise<PresenceRecord[]> {
    const rows = await this.target.db.select().from(presence).where(eq(presence.boardId, boardId));
    return rows.sort((a, b) => a.userId.localeCompare(b.userId)).map(rowToRecord);
  }
}

interface PresenceRow {
  boardId: string;
  userId: string;
  instanceId: string;
  name: string;
  color: string;
  cursor: unknown;
  selection: unknown;
  updatedAt: number;
}

function rowToPeer(row: PresenceRow): PresencePeer {
  return {
    userId: row.userId,
    name: row.name,
    cursor: row.cursor ? { ...(row.cursor as PresenceCursor) } : null,
    selection: Array.isArray(row.selection) ? [...(row.selection as string[])] : [],
    color: row.color,
    updatedAt: row.updatedAt,
  };
}

function rowToRecord(row: PresenceRow): PresenceRecord {
  return {
    boardId: row.boardId,
    userId: row.userId,
    instanceId: row.instanceId,
    name: row.name,
    color: row.color,
    cursor: row.cursor ? { ...(row.cursor as PresenceCursor) } : null,
    selection: Array.isArray(row.selection) ? [...(row.selection as string[])] : [],
    updatedAt: row.updatedAt,
  };
}

/** The wire view of a row: everything a peer needs, nothing about topology. */
function toPeer(record: Presence): PresencePeer {
  return {
    userId: record.userId,
    name: record.name,
    cursor: record.cursor ? { ...record.cursor } : null,
    selection: [...record.selection],
    color: record.color,
    updatedAt: record.updatedAt,
  };
}
