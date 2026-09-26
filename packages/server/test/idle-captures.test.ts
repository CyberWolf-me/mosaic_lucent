import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  InMemoryMeetingStore,
  lastActivity,
  type MeetingStore,
  type MeetingTurn,
} from "../src/meetings.js";
import { PostgresMeetingStore } from "../src/store/pg-meetings.js";
import { PostgresOrgStore } from "../src/orgs.js";
import { buildSweepHandlers, IDLE_CAPTURE_MS, sweepIdleCaptures } from "../src/sweeps.js";
import { closeDb, createDb, type Db } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import type { Job } from "../src/jobs.js";

/**
 * docs/28 F14: a capture whose tab closed, crashed or was left never sends
 * its end, and its record said "in progress" forever. The idle sweep ends
 * it — at its LAST ACTIVITY, so the minutes say when the talking stopped —
 * and never touches a capture still being heard from, or an ended record.
 */

const HOUR = 60 * 60 * 1000;
const turnAt = (at: number, text = "x"): MeetingTurn => ({ speaker: "A", at, text });

async function seed(
  store: MeetingStore,
  input: { startedAt: number; endedAt?: number | null; turns?: MeetingTurn[] },
  boardId = "b",
  orgId = "o",
  createdBy = "usr_test",
) {
  return store.insert({
    boardId,
    orgId,
    startedAt: input.startedAt,
    endedAt: input.endedAt ?? null,
    turns: input.turns ?? [turnAt(input.startedAt)],
    createdBy,
    createdAt: input.startedAt,
  });
}

describe("lastActivity", () => {
  it("is the last turn, or the start when nobody spoke", () => {
    expect(lastActivity({ startedAt: 100, turns: [turnAt(150), turnAt(900)] })).toBe(900);
    expect(lastActivity({ startedAt: 100, turns: [] })).toBe(100);
    // A clock-skewed turn never moves the activity before the start.
    expect(lastActivity({ startedAt: 100, turns: [turnAt(50)] })).toBe(100);
  });
});

describe("MeetingStore.endIdle", () => {
  it("ends only open captures idle past the cutoff, at their last activity", async () => {
    const store = new InMemoryMeetingStore();
    const now = 100 * HOUR;
    const idle = await seed(store, {
      startedAt: now - 30 * HOUR,
      turns: [turnAt(now - 30 * HOUR), turnAt(now - 20 * HOUR)],
    });
    const silent = await seed(store, { startedAt: now - 15 * HOUR, turns: [] });
    const live = await seed(store, {
      startedAt: now - 30 * HOUR,
      turns: [turnAt(now - 30 * HOUR), turnAt(now - HOUR)],
    });
    const ended = await seed(store, { startedAt: now - 40 * HOUR, endedAt: now - 39 * HOUR });

    expect(await store.endIdle(now - 12 * HOUR, 10)).toBe(2);
    expect((await store.get("b", idle.id))?.endedAt).toBe(now - 20 * HOUR);
    expect((await store.get("b", silent.id))?.endedAt).toBe(now - 15 * HOUR);
    // Still being heard from: a long meeting is not an abandoned one.
    expect((await store.get("b", live.id))?.endedAt).toBeNull();
    // An ended record keeps its own end.
    expect((await store.get("b", ended.id))?.endedAt).toBe(now - 39 * HOUR);
    // A second pass has nothing left to do.
    expect(await store.endIdle(now - 12 * HOUR, 10)).toBe(0);
  });

  it("is bounded, longest-idle first", async () => {
    const store = new InMemoryMeetingStore();
    const a = await seed(store, { startedAt: 3_000 });
    const b = await seed(store, { startedAt: 1_000 });
    const c = await seed(store, { startedAt: 2_000 });
    expect(await store.endIdle(10_000, 2)).toBe(2);
    expect((await store.get("b", b.id))?.endedAt).toBe(1_000);
    expect((await store.get("b", c.id))?.endedAt).toBe(2_000);
    expect((await store.get("b", a.id))?.endedAt).toBeNull();
    expect(await store.endIdle(10_000, 0)).toBe(0);
  });

  it("an idle-ended capture refuses late appends, like any ended record", async () => {
    const store = new InMemoryMeetingStore();
    const row = await seed(store, { startedAt: 1_000 });
    await store.endIdle(10_000, 10);
    expect(await store.appendTo("b", row.id, [turnAt(20_000)])).toBeUndefined();
  });
});

describe("sweepIdleCaptures", () => {
  it("ends what has been silent for the idle window, and nothing younger", async () => {
    const store = new InMemoryMeetingStore();
    const now = 100 * HOUR;
    const old = await seed(store, { startedAt: now - IDLE_CAPTURE_MS - HOUR });
    const young = await seed(store, { startedAt: now - IDLE_CAPTURE_MS + HOUR });
    expect(await sweepIdleCaptures({ meetings: store, now: () => now })).toBe(1);
    expect((await store.get("b", old.id))?.endedAt).not.toBeNull();
    expect((await store.get("b", young.id))?.endedAt).toBeNull();
  });
});

describe("the sweep-idle-captures job", () => {
  const JOB = { id: "j", type: "sweep-idle-captures" } as unknown as Job;

  it("completes as a no-op when meetings are unconfigured", async () => {
    const handlers = buildSweepHandlers({ logger: { info: () => {}, error: () => {} } });
    await expect(handlers["sweep-idle-captures"]!(JOB)).resolves.toBeUndefined();
  });

  it("logs only when it ended something", async () => {
    const logged: string[] = [];
    let ended = 2;
    const handlers = buildSweepHandlers({
      logger: { info: (e) => void logged.push(e), error: () => {} },
      captures: { endIdle: async () => ended },
    });
    await handlers["sweep-idle-captures"]!(JOB);
    ended = 0;
    await handlers["sweep-idle-captures"]!(JOB);
    expect(logged).toEqual(["meetings.ended-idle"]);
  });
});

/**
 * Parity on Postgres (gated on LUCENT_TEST_DATABASE_URL, the repo's
 * convention): the same rows end at the same instants on both stores.
 */
const PG_URL = process.env.LUCENT_TEST_DATABASE_URL;
const describeIf = PG_URL ? describe : describe.skip;

describeIf("endIdle parity on Postgres", () => {
  let db: Db;
  const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const orgId = `org_idle_${tag}`;
  const boardId = `brd_idle_${tag}`;
  const userId = `usr_idle_${tag}`;

  beforeAll(async () => {
    if (!PG_URL) return;
    db = createDb(PG_URL);
    await migrate(db);
    await new PostgresOrgStore(db).insert({ id: orgId, name: "Idle", createdAt: 1 });
    await db.pool.query(
      "INSERT INTO users (id, email, name, password_hash, created_at) VALUES ($1, $2, $3, $4, 1) ON CONFLICT (id) DO NOTHING",
      [userId, `${userId}@example.com`, "Idle", "x"],
    );
    await db.pool.query(
      "INSERT INTO boards (id, org_id, owner_id, name, workspace, created_at, updated_at) VALUES ($1, $2, $3, $4, '{}'::jsonb, 1, 1) ON CONFLICT (id) DO NOTHING",
      [boardId, orgId, userId, "Idle"],
    );
  });

  afterAll(async () => {
    if (!db) return;
    await db.pool
      .query("DELETE FROM meeting_transcripts WHERE board_id = $1", [boardId])
      .catch(() => {});
    await db.pool.query("DELETE FROM boards WHERE id = $1", [boardId]).catch(() => {});
    await db.pool.query("DELETE FROM organizations WHERE id = $1", [orgId]).catch(() => {});
    await db.pool.query("DELETE FROM users WHERE id = $1", [userId]).catch(() => {});
    await closeDb(db);
  });

  it("ends the same captures at the same instants as the in-memory twin", async () => {
    const pg = new PostgresMeetingStore(db);
    const mem = new InMemoryMeetingStore();
    // The sweep is global and the test database is shared with suites running
    // in parallel (retention keeps an ancient open capture). These rows live
    // BEFORE the epoch, where nothing else writes, and the cutoff reaches
    // only them — so this test ends its own rows and no one else's.
    const now = -1_000 * HOUR;
    const results: Array<Array<number | null | undefined>> = [];
    for (const store of [pg, mem] as const) {
      const idle = await seed(
        store,
        { startedAt: now - 30 * HOUR, turns: [turnAt(now - 30 * HOUR), turnAt(now - 20 * HOUR)] },
        boardId,
        orgId,
        userId,
      );
      const live = await seed(
        store,
        { startedAt: now - 30 * HOUR, turns: [turnAt(now - HOUR)] },
        boardId,
        orgId,
        userId,
      );
      const count = await store.endIdle(now - 12 * HOUR, 10);
      results.push([
        count,
        (await store.get(boardId, idle.id))?.endedAt,
        (await store.get(boardId, live.id))?.endedAt,
      ]);
    }
    expect(results[0]).toEqual([1, now - 20 * HOUR, null]);
    expect(results[1]).toEqual(results[0]);
  });
});
