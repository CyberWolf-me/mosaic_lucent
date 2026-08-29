import { describe, expect, it, beforeEach } from "vitest";
import { InMemoryPresenceStore } from "../src/presence.js";
import type { PresenceUpsert } from "../src/presence.js";
import { colorForUser } from "../src/room.js";

/**
 * PresenceStore unit tests (M3, ADR 0004). Presence is the state that has to
 * survive being spread across instances, so these pin the two properties the
 * Room's `Map` could not give: a peer list that spans instances, and a row that
 * expires on its own when the instance holding it dies. The TTL is tested at the
 * boundary, because an off-by-one there either evicts a live editor or keeps a
 * ghost forever.
 */

const BOARD = "brd_1";
const OTHER = "brd_2";
const A = "srv_a";
const B = "srv_b";
const TTL = 1_000;
const T0 = 1_000_000;

let now = T0;

beforeEach(() => {
  now = T0;
});

function store(ttlMs = TTL): InMemoryPresenceStore {
  return new InMemoryPresenceStore(ttlMs, () => now);
}

/** A presence update with the boring fields filled in. */
function update(over: Partial<PresenceUpsert> & { userId: string }): PresenceUpsert {
  return { boardId: BOARD, instanceId: A, name: "Ana", ...over };
}

describe("upsert then read", () => {
  it("returns the participant in exactly the shape the transport broadcasts", async () => {
    const s = store();
    const peer = await s.upsert(
      update({ userId: "usr_1", cursor: { x: 10, y: 20 }, selection: ["a"] }),
    );

    // The wire format, no wider: `instanceId` and `boardId` are server-side
    // detail and must not reach a client through the presence broadcast.
    expect(Object.keys(peer).sort()).toEqual([
      "color",
      "cursor",
      "name",
      "selection",
      "updatedAt",
      "userId",
    ]);
    expect(peer).toEqual({
      userId: "usr_1",
      name: "Ana",
      cursor: { x: 10, y: 20 },
      selection: ["a"],
      color: colorForUser("usr_1"),
      updatedAt: T0,
    });
    expect(await s.peers(BOARD)).toEqual([peer]);
  });

  it("defaults a new participant to no cursor and nothing selected", async () => {
    const s = store();
    const peer = await s.upsert(update({ userId: "usr_1" }));
    expect(peer.cursor).toBeNull();
    expect(peer.selection).toEqual([]);
  });
});

describe("merge semantics", () => {
  it("keeps the field the client did not send", async () => {
    const s = store();
    await s.upsert(update({ userId: "usr_1", cursor: { x: 1, y: 2 } }));
    // The client coalesces cursor and selection independently, so a
    // selection-only update must not clear the cursor it never mentioned.
    const peer = await s.upsert(update({ userId: "usr_1", selection: ["a", "b"] }));

    expect(peer.cursor).toEqual({ x: 1, y: 2 });
    expect(peer.selection).toEqual(["a", "b"]);
  });

  it("clears the cursor on an explicit null, which means off-canvas", async () => {
    const s = store();
    await s.upsert(update({ userId: "usr_1", cursor: { x: 1, y: 2 } }));
    const peer = await s.upsert(update({ userId: "usr_1", cursor: null }));
    expect(peer.cursor).toBeNull();
  });

  it("replaces the selection rather than accumulating it", async () => {
    const s = store();
    await s.upsert(update({ userId: "usr_1", selection: ["a", "b"] }));
    const peer = await s.upsert(update({ userId: "usr_1", selection: ["c"] }));
    expect(peer.selection).toEqual(["c"]);
  });

  it("keeps the colour stable and advances updatedAt on every touch", async () => {
    const s = store();
    const first = await s.upsert(update({ userId: "usr_1" }));
    now += 10;
    const second = await s.upsert(update({ userId: "usr_1", name: "Ana Renamed" }));

    expect(second.color).toBe(first.color);
    expect(second.name).toBe("Ana Renamed");
    expect(second.updatedAt).toBe(T0 + 10);
  });
});

describe("across instances", () => {
  it("lists editors from every instance in one peer list", async () => {
    const s = store();
    await s.upsert(update({ userId: "usr_1", instanceId: A }));
    await s.upsert(update({ userId: "usr_2", instanceId: B }));

    expect((await s.peers(BOARD)).map((p) => p.userId)).toEqual(["usr_1", "usr_2"]);
  });

  it("attributes each row to the instance holding that socket", async () => {
    const s = store();
    await s.upsert(update({ userId: "usr_1", instanceId: A }));
    await s.upsert(update({ userId: "usr_2", instanceId: B }));

    expect((await s.rows(BOARD)).map((r) => [r.userId, r.instanceId])).toEqual([
      ["usr_1", A],
      ["usr_2", B],
    ]);
  });

  it("re-homes a row when the same user reconnects onto another instance", async () => {
    const s = store();
    const first = await s.upsert(update({ userId: "usr_1", instanceId: A, selection: ["a"] }));
    now += 5;
    await s.upsert(update({ userId: "usr_1", instanceId: B }));

    const [row] = await s.rows(BOARD);
    expect(row?.instanceId).toBe(B);
    // One presence per user, so the peer list does not double up — and the
    // participant keeps the colour their peers already associate with them.
    expect(await s.peers(BOARD)).toHaveLength(1);
    expect(row?.color).toBe(first.color);
    expect(row?.selection).toEqual(["a"]);
  });

  it("keeps a board populated while any instance still has an editor", async () => {
    const s = store();
    await s.upsert(update({ userId: "usr_1", instanceId: A }));
    await s.upsert(update({ userId: "usr_2", instanceId: B }));

    // The room.ts:195 bug in one assertion: instance A losing its only socket
    // must not make the board look empty and evict a room B is still serving.
    await s.remove(BOARD, "usr_1", A);
    expect(await s.peers(BOARD)).toHaveLength(1);
    await s.remove(BOARD, "usr_2", B);
    expect(await s.peers(BOARD)).toHaveLength(0);
  });

  it("does not mix boards", async () => {
    const s = store();
    await s.upsert(update({ userId: "usr_1" }));
    await s.upsert(update({ userId: "usr_2", boardId: OTHER }));

    expect((await s.peers(BOARD)).map((p) => p.userId)).toEqual(["usr_1"]);
    expect((await s.peers(OTHER)).map((p) => p.userId)).toEqual(["usr_2"]);
  });
});

describe("the exceptUserId filter", () => {
  it("excludes the caller, as the welcome payload needs", async () => {
    const s = store();
    await s.upsert(update({ userId: "usr_1" }));
    await s.upsert(update({ userId: "usr_2" }));

    expect((await s.peers(BOARD, "usr_1")).map((p) => p.userId)).toEqual(["usr_2"]);
  });

  it("excludes nobody when it is omitted", async () => {
    const s = store();
    await s.upsert(update({ userId: "usr_1" }));
    expect(await s.peers(BOARD)).toHaveLength(1);
  });

  it("excludes only that user, and only on that board", async () => {
    const s = store();
    await s.upsert(update({ userId: "usr_1" }));
    await s.upsert(update({ userId: "usr_1", boardId: OTHER }));

    expect(await s.peers(BOARD, "usr_1")).toEqual([]);
    expect(await s.peers(OTHER)).toHaveLength(1);
  });
});

describe("remove", () => {
  it("drops the row unconditionally when no instance is named", async () => {
    const s = store();
    await s.upsert(update({ userId: "usr_1", instanceId: A }));
    await s.remove(BOARD, "usr_1");
    expect(await s.rows(BOARD)).toEqual([]);
  });

  it("ignores a leave from an instance that no longer owns the row", async () => {
    const s = store();
    await s.upsert(update({ userId: "usr_1", instanceId: A }));
    await s.upsert(update({ userId: "usr_1", instanceId: B }));

    // A's socket closing after the user moved to B must not evict the live row.
    await s.remove(BOARD, "usr_1", A);
    expect(await s.peers(BOARD)).toHaveLength(1);
    await s.remove(BOARD, "usr_1", B);
    expect(await s.peers(BOARD)).toHaveLength(0);
  });

  it("is a no-op on a row that is not there", async () => {
    const s = store();
    await expect(s.remove(BOARD, "usr_nobody")).resolves.toBeUndefined();
    await expect(s.remove(BOARD, "usr_nobody", A)).resolves.toBeUndefined();
  });
});

describe("the TTL boundary on reads", () => {
  it("keeps a row that is one tick inside the window", async () => {
    const s = store();
    await s.upsert(update({ userId: "usr_1" }));

    now = T0 + TTL - 1;
    expect(await s.peers(BOARD)).toHaveLength(1);
  });

  it("drops a row that has been idle exactly the TTL, with no sweep involved", async () => {
    const s = store();
    await s.upsert(update({ userId: "usr_1" }));

    // Read-time expiry is the load-bearing half: a crashed instance leaves rows
    // nobody will remove, and its editors must leave the presence bar at once
    // rather than when a timer next happens to fire.
    now = T0 + TTL;
    expect(await s.peers(BOARD)).toEqual([]);
    // ...even though the row itself is still there, unreclaimed.
    expect(await s.rows(BOARD)).toHaveLength(1);
    expect(s.size()).toBe(1);
  });

  it("keeps an idle participant alive across a liveness touch", async () => {
    const s = store();
    await s.upsert(update({ userId: "usr_1" }));

    // An upsert with neither cursor nor selection is the touch the owning
    // instance sends for a participant who is merely sitting still.
    const touchedAt = T0 + TTL - 1;
    now = touchedAt;
    await s.upsert(update({ userId: "usr_1" }));

    // Past the original deadline, alive on the strength of the touch alone.
    now = T0 + TTL;
    expect(await s.peers(BOARD)).toHaveLength(1);
    now = touchedAt + TTL - 1;
    expect(await s.peers(BOARD)).toHaveLength(1);
    // And expiring a full TTL after the touch, not after the first upsert.
    now = touchedAt + TTL;
    expect(await s.peers(BOARD)).toEqual([]);
  });

  it("expires each row on its own last touch, not the board's", async () => {
    const s = store();
    await s.upsert(update({ userId: "usr_stale" }));
    now = T0 + 500;
    await s.upsert(update({ userId: "usr_fresh" }));

    now = T0 + TTL;
    expect((await s.peers(BOARD)).map((p) => p.userId)).toEqual(["usr_fresh"]);
  });
});

describe("sweep", () => {
  it("reclaims rows at or before the cutoff and reports the count", async () => {
    const s = store();
    await s.upsert(update({ userId: "usr_at" }));
    now = T0 + 1;
    await s.upsert(update({ userId: "usr_after" }));

    // At the cutoff means expired — idle exactly the TTL — matching how the
    // ticket store treats `expiresAt <= now`.
    expect(await s.sweep(T0)).toBe(1);
    expect((await s.rows(BOARD)).map((r) => r.userId)).toEqual(["usr_after"]);
  });

  it("takes rows from every board and instance in one pass", async () => {
    const s = store();
    await s.upsert(update({ userId: "usr_1", instanceId: A }));
    await s.upsert(update({ userId: "usr_2", instanceId: B, boardId: OTHER }));

    expect(await s.sweep(T0)).toBe(2);
    expect(s.size()).toBe(0);
  });

  it("removes nothing when every row is fresher than the cutoff", async () => {
    const s = store();
    await s.upsert(update({ userId: "usr_1" }));
    expect(await s.sweep(T0 - 1)).toBe(0);
    expect(s.size()).toBe(1);
  });

  it("is idempotent, so a slow or doubled timer costs nothing", async () => {
    const s = store();
    await s.upsert(update({ userId: "usr_1" }));
    now = T0 + TTL;
    expect(await s.sweep(now - TTL)).toBe(1);
    expect(await s.sweep(now - TTL)).toBe(0);
  });

  it("reclaims the ghosts a crashed instance leaves behind", async () => {
    const s = store();
    await s.upsert(update({ userId: "usr_1", instanceId: A }));
    now = T0 + TTL - 1;
    // B keeps touching its socket; A died and will never call remove.
    await s.upsert(update({ userId: "usr_2", instanceId: B }));

    now = T0 + TTL;
    expect(await s.sweep(now - TTL)).toBe(1);
    expect((await s.rows(BOARD)).map((r) => r.instanceId)).toEqual([B]);
    expect(await s.peers(BOARD)).toHaveLength(1);
  });

  it("empties a board so a room may be evicted", async () => {
    const s = store();
    await s.upsert(update({ userId: "usr_1" }));
    now = T0 + TTL;
    await s.sweep(now - TTL);
    expect(await s.peers(BOARD)).toEqual([]);
    expect(await s.rows(BOARD)).toEqual([]);
  });
});

describe("returned values are copies", () => {
  it("does not hand a caller a reference into its own state", async () => {
    const s = store();
    const selection = ["a"];
    const peer = await s.upsert(update({ userId: "usr_1", selection, cursor: { x: 1, y: 2 } }));

    // The Postgres implementation physically cannot alias its rows, so the
    // in-memory one must not either: a bug that reproduces on only one of the
    // two is the worst kind.
    selection.push("mutated-after-the-fact");
    peer.selection.push("mutated-by-the-caller");
    peer.cursor!.x = 999;

    const [stored] = await s.peers(BOARD);
    expect(stored?.selection).toEqual(["a"]);
    expect(stored?.cursor).toEqual({ x: 1, y: 2 });
  });

  it("copies rows() too, cursor included", async () => {
    const s = store();
    await s.upsert(update({ userId: "usr_1", selection: ["a"], cursor: { x: 1, y: 2 } }));

    const [row] = await s.rows(BOARD);
    row?.selection.push("mutated");
    if (row?.cursor) row.cursor.y = 999;

    const [again] = await s.rows(BOARD);
    expect(again?.selection).toEqual(["a"]);
    expect(again?.cursor).toEqual({ x: 1, y: 2 });
    // The row view still carries the attribution the wire view drops.
    expect(again?.instanceId).toBe(A);
    expect(again?.boardId).toBe(BOARD);
  });
});

/* ─────────────────────── Postgres parity (M3, ADR 0004) ──────────────────── */

/**
 * Parity tests for `PostgresPresenceStore`. Same matrix as the in-memory suite
 * above, so any drift between the two implementations shows up as a test failure
 * here rather than at runtime. Gated on `LUCENT_TEST_DATABASE_URL` per the
 * Postgres-test convention.
 */
const URL = process.env.LUCENT_TEST_DATABASE_URL;

const describePg = URL ? describe : describe.skip;

describePg("presence parity — PostgresPresenceStore", () => {
  let db: import("../src/db/client.js").Db | undefined;

  beforeEach(async () => {
    if (!URL) return;
    const { createDb } = await import("../src/db/client.js");
    const { migrate: runMigrations } = await import("../src/db/migrate.js");
    db = createDb(URL);
    await runMigrations(db);
    // Wipe the table between tests; the harness creates a fresh client per
    // test file, so a TRUNCATE here keeps the run isolated without a per-test
    // schema setup.
    await db.pool.query("DELETE FROM presence");
  });

  async function pgStore(
    ttlMs = TTL,
  ): Promise<import("../src/store/pg-presence.js").PostgresPresenceStore> {
    if (!db) throw new Error("Postgres store requires LUCENT_TEST_DATABASE_URL");
    // The store gets a callable `now` so the suite's `T0` clock advances
    // without the test having to thread it through every update.
    const { PostgresPresenceStore } = await import("../src/store/pg-presence.js");
    return new PostgresPresenceStore(db, ttlMs, () => now);
  }

  it("upsert returns a peer-shaped record and round-trips on read", async () => {
    const s = await pgStore();
    const written = await s.upsert({
      boardId: BOARD,
      userId: "usr_1",
      instanceId: A,
      name: "Ana",
      cursor: { x: 1, y: 2 },
      selection: ["a", "b"],
    });
    expect(written.userId).toBe("usr_1");
    expect(written.cursor).toEqual({ x: 1, y: 2 });
    expect(written.selection).toEqual(["a", "b"]);
    expect(written.color).toBe(colorForUser("usr_1"));
    // peers() excludes expired rows; the row was just touched at T0 so it is live.
    expect((await s.peers(BOARD)).map((p) => p.userId)).toEqual(["usr_1"]);
  });

  it("keeps the stored cursor when the next update omits it, but nulls it on an explicit null", async () => {
    const s = await pgStore();
    await s.upsert({
      boardId: BOARD,
      userId: "usr_1",
      instanceId: A,
      name: "Ana",
      cursor: { x: 1, y: 2 },
    });
    // Absent: keeps the previous cursor.
    const kept = await s.upsert({
      boardId: BOARD,
      userId: "usr_1",
      instanceId: A,
      name: "Ana",
      selection: ["x"],
    });
    expect(kept.cursor).toEqual({ x: 1, y: 2 });
    // Explicit null: clears.
    const cleared = await s.upsert({
      boardId: BOARD,
      userId: "usr_1",
      instanceId: A,
      name: "Ana",
      cursor: null,
    });
    expect(cleared.cursor).toBeNull();
  });

  it("re-homes a row to a new instance when the same user reconnects", async () => {
    const s = await pgStore();
    await s.upsert({ boardId: BOARD, userId: "usr_1", instanceId: A, name: "Ana" });
    await s.upsert({ boardId: BOARD, userId: "usr_1", instanceId: B, name: "Ana" });
    const rows = await s.rows(BOARD);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.instanceId).toBe(B);
  });

  it("compare-and-delete: a stale instance's leave does not evict a live row on another instance", async () => {
    const s = await pgStore();
    await s.upsert({ boardId: BOARD, userId: "usr_1", instanceId: B, name: "Ana" });
    // Instance A never owned this row, so its leave must be a no-op.
    await s.remove(BOARD, "usr_1", A);
    expect(await s.peers(BOARD)).toHaveLength(1);
    // The owning instance's leave drops the row.
    await s.remove(BOARD, "usr_1", B);
    expect(await s.peers(BOARD)).toHaveLength(0);
  });

  it("filters expired rows out of peers() but keeps them visible to rows()", async () => {
    const s = await pgStore(TTL);
    await s.upsert({ boardId: BOARD, userId: "usr_1", instanceId: A, name: "Ana" });
    // Advance the clock past the TTL.
    now = T0 + TTL + 1;
    expect(await s.peers(BOARD)).toEqual([]);
    // rows() returns the full picture; the sweep is what reclaims space.
    expect(await s.rows(BOARD)).toHaveLength(1);
  });

  it("sweep() deletes rows past the cutoff and reports the count", async () => {
    const s = await pgStore(TTL);
    await s.upsert({ boardId: BOARD, userId: "usr_1", instanceId: A, name: "Ana" });
    await s.upsert({ boardId: BOARD, userId: "usr_2", instanceId: A, name: "Bo" });
    now = T0 + TTL + 1;
    const removed = await s.sweep(now);
    expect(removed).toBe(2);
    expect(await s.rows(BOARD)).toEqual([]);
  });
});
