import { colorForUser } from "./room.js";
import type { Presence } from "./room.js";

/**
 * Presence storage (M3, docs/adr/0004-postgres-fanout-over-redis.md).
 *
 * Presence lives in a `Map` inside each Room today (room.ts:75), which breaks in
 * two ways the moment a second instance exists: a peer list shows only the
 * editors whose sockets landed on this instance, and `Room.isEmpty()`
 * (room.ts:195) evicts a room on *local* emptiness — dropping a room that
 * another instance still has editors in. Both are the same mistake, that
 * presence is board state and was being kept as process state.
 *
 * So it moves behind this interface: in-memory for a single instance and for
 * tests, a Postgres table with a TTL sweep for multi-instance (Redis later,
 * same shape). Presence is the one piece of realtime state that is deliberately
 * not in the op log — it is ephemeral by nature, which is why it needs a TTL
 * rather than durability, and why a lost presence row costs a cursor for a few
 * seconds rather than an edit.
 */

/** A cursor in content coordinates, as the client reports it. */
export interface PresenceCursor {
  x: number;
  y: number;
}

/**
 * One participant as their peers see them.
 *
 * This is the wire format already in use, not a parallel one: it is identical to
 * `Presence` in room.ts, which realtime.ts broadcasts as `{type: "presence",
 * presence}` (realtime.ts:219) and as `peers` inside the welcome
 * (realtime.ts:180), and which the client reads as `Peer`
 * (packages/web/src/boardSync.ts:16-22 — same fields, minus `updatedAt`, which
 * it ignores). Inventing a store-shaped record instead would buy a translation
 * step in the hot path and a second definition to keep in sync, so `_WireFormat`
 * below makes the compiler enforce that this stays assignable to what the
 * transport already sends.
 */
export interface PresencePeer {
  userId: string;
  name: string;
  /** Cursor in content coordinates; null when off-canvas. */
  cursor: PresenceCursor | null;
  /** Object ids the participant currently has selected. */
  selection: string[];
  /** Stable per-user colour, so a participant looks the same to everyone. */
  color: string;
  /** Epoch ms of the last touch. The TTL clock; the client ignores it. */
  updatedAt: number;
}

type Assignable<Narrow extends Wide, Wide> = Narrow;
/** Compile-time guard; see `PresencePeer`. Fails the build if the shapes drift. */
type _WireFormat = Assignable<PresencePeer, Presence>;

/**
 * A stored row: a peer, plus which instance is holding their socket.
 *
 * `instanceId` never crosses the wire — a client has no use for the topology, and
 * naming a deployment's processes to every board member is a detail worth not
 * leaking — which is why `peers()` returns `PresencePeer` and only `rows()` shows
 * this. It earns its place server-side twice over: it says which instance owes a
 * row its liveness touches, so a leave arriving from a stale socket cannot evict
 * a row a *different* instance is keeping alive (see `remove`), and an operator
 * staring at a ghost peer can tell whose process died.
 */
export interface PresenceRecord extends PresencePeer {
  boardId: string;
  instanceId: string;
}

/**
 * A presence update from one socket.
 *
 * `cursor` and `selection` are optional and *merge*: the client sends whichever
 * changed (boardSync.ts:156-163 coalesces them independently), so an absent field
 * must keep the stored value rather than clear it — the same merge
 * `Room.updatePresence` (room.ts:167-183) does today. An explicit `null` cursor
 * is different from an absent one: it means "off-canvas" and does clear.
 *
 * An update with neither field is therefore a liveness touch, and that is how the
 * instance holding a socket keeps a participant who is merely sitting still from
 * being swept.
 */
export interface PresenceUpsert {
  boardId: string;
  userId: string;
  name: string;
  /** Which instance holds this participant's socket. */
  instanceId: string;
  cursor?: PresenceCursor | null;
  selection?: string[];
}

/**
 * Default liveness window: a row not touched within this long is treated as gone,
 * excluded from `peers()` and reclaimed by `sweep()`.
 *
 * It has to be comfortably longer than the interval at which the owning instance
 * touches its live sockets, because the cost of being too short is evicting an
 * editor who is only sitting still — the client sends presence when the cursor or
 * selection changes (boardSync.ts:156), so silence is not absence. Roughly three
 * times a 15-second touch leaves room for a GC pause or a slow sweep without a
 * live editor flickering out of the presence bar.
 */
export const DEFAULT_PRESENCE_TTL_MS = 45_000;

export interface PresenceStore {
  /**
   * Record a participant, merged with their stored row (see `PresenceUpsert`),
   * and return them as peers see them — same contract as `Room.updatePresence`,
   * so the transport keeps broadcasting the value it gets back.
   *
   * Keyed on (boardId, userId), not per socket, because the client's peer map is
   * keyed on userId (boardSync.ts:118) and `peer-left` removes by userId
   * (realtime.ts:229): two tabs are one presence and the last touch wins.
   * Ownership follows that touch, so a user who reconnects onto another instance
   * re-homes their row.
   */
  upsert(update: PresenceUpsert): Promise<PresencePeer>;

  /**
   * Drop a participant's row on leave.
   *
   * Pass `instanceId` to make it a compare-and-delete: the row goes only if that
   * instance still owns it, so a socket closing on instance A cannot evict the
   * same user's live row on instance B. Omit it to remove unconditionally, which
   * is for an admin path or a test rather than a leaving socket.
   */
  remove(boardId: string, userId: string, instanceId?: string): Promise<void>;

  /**
   * Everyone live on a board across every instance, optionally excluding the
   * caller — the cross-instance answer to `Room.peers()` (room.ts:190), and
   * `(await peers(boardId)).length === 0` is the correct replacement for
   * `Room.isEmpty()` (room.ts:195) when deciding whether a room may be evicted.
   *
   * Rows past the TTL are excluded from the read, not merely from the sweep, so a
   * crashed instance's editors stop appearing at once instead of lingering until a
   * timer next fires: correctness must not depend on a sweep's cadence. `sweep`
   * only reclaims the space.
   */
  peers(boardId: string, exceptUserId?: string): Promise<PresencePeer[]>;

  /**
   * Delete every row whose `updatedAt` is at or before `olderThan`, returning how
   * many went. The caller passes `now - ttlMs`; a row touched exactly at the
   * cutoff has been idle exactly the TTL and is expired, matching how
   * `InMemoryTicketStore` treats `expiresAt <= now`.
   *
   * TTL expiry covers the case nothing else can: an instance that crashed or was
   * killed leaves rows behind with no owner to call `remove`, and without a sweep
   * those ghosts would sit in the presence bar of every board it served — and, on
   * the eviction check above, keep rooms alive forever.
   */
  sweep(olderThan: number): Promise<number>;

  /**
   * Every row on a board, including instance attribution and rows past the TTL
   * that the sweep has not reclaimed yet: the operator, metrics and test view.
   * `peers()` is what goes on the wire.
   */
  rows(boardId: string): Promise<PresenceRecord[]>;
}

/**
 * Presence for a single-instance deployment, and the one the tests use.
 *
 * Honest about what it is rather than a simplification: rows still carry an
 * `instanceId` and the TTL still applies to reads, so the semantics the Postgres
 * table has to satisfy are the ones pinned here.
 */
export class InMemoryPresenceStore implements PresenceStore {
  /** Keyed by board id and user id joined by a space, as in boards.ts. */
  private readonly records = new Map<string, PresenceRecord>();

  constructor(
    private readonly ttlMs: number = DEFAULT_PRESENCE_TTL_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async upsert(update: PresenceUpsert): Promise<PresencePeer> {
    const key = presenceKey(update.boardId, update.userId);
    const existing = this.records.get(key);
    // `!== undefined` rather than `??`: an explicit null means off-canvas and
    // must clear the stored cursor, while an absent field must keep it.
    const merged = update.cursor !== undefined ? update.cursor : (existing?.cursor ?? null);
    const next: PresenceRecord = {
      boardId: update.boardId,
      instanceId: update.instanceId,
      userId: update.userId,
      name: update.name,
      // Copied on the way in, not only on the way out (see `toPeer`): the caller's
      // cursor and selection stay theirs to reuse, and a store that aliased them
      // would let a later mutation rewrite board state from outside — which the
      // Postgres implementation, writing real columns, could not do by accident.
      cursor: merged ? { ...merged } : null,
      selection:
        update.selection !== undefined ? [...update.selection] : (existing?.selection ?? []),
      // Derived once and then kept, so a participant looks the same to everyone
      // for as long as they hold a row — including across a re-home onto another
      // instance. Same function the Room used, not a second palette.
      color: existing?.color ?? colorForUser(update.userId),
      updatedAt: this.now(),
    };
    this.records.set(key, next);
    return toPeer(next);
  }

  async remove(boardId: string, userId: string, instanceId?: string): Promise<void> {
    const key = presenceKey(boardId, userId);
    if (instanceId !== undefined && this.records.get(key)?.instanceId !== instanceId) return;
    this.records.delete(key);
  }

  async peers(boardId: string, exceptUserId?: string): Promise<PresencePeer[]> {
    const cutoff = this.now() - this.ttlMs;
    return (
      [...this.records.values()]
        .filter((r) => r.boardId === boardId && r.userId !== exceptUserId && r.updatedAt > cutoff)
        // By userId, so the presence bar's order is stable no matter which instance
        // answered or in what order rows were last touched.
        .sort((a, b) => a.userId.localeCompare(b.userId))
        .map(toPeer)
    );
  }

  async sweep(olderThan: number): Promise<number> {
    let removed = 0;
    for (const [key, record] of this.records) {
      if (record.updatedAt <= olderThan) {
        this.records.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  async rows(boardId: string): Promise<PresenceRecord[]> {
    return [...this.records.values()]
      .filter((r) => r.boardId === boardId)
      .sort((a, b) => a.userId.localeCompare(b.userId))
      .map((r) => ({ ...r, ...toPeer(r) }));
  }

  /** Rows across every board, expired ones included. For tests and /metrics. */
  size(): number {
    return this.records.size;
  }
}

/** The wire view of a row: everything a peer needs, nothing about topology. */
function toPeer(record: PresenceRecord): PresencePeer {
  return {
    userId: record.userId,
    name: record.name,
    cursor: record.cursor ? { ...record.cursor } : null,
    // Copied, not aliased. The in-memory store would otherwise hand a caller a
    // reference into its own state, which the Postgres implementation cannot do —
    // and a bug that only reproduces on one of the two is the worst kind.
    selection: [...record.selection],
    color: record.color,
    updatedAt: record.updatedAt,
  };
}

function presenceKey(boardId: string, userId: string): string {
  return `${boardId} ${userId}`;
}
