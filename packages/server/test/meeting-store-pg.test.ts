import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InMemoryMeetingStore, type MeetingStore } from "../src/meetings.js";
import { PostgresMeetingStore } from "../src/store/pg-meetings.js";
import { PostgresOrgStore } from "../src/orgs.js";
import { closeDb, createDb, type Db } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";

/**
 * ADR 0045: the meeting's title and the workspace list, on Postgres and the
 * in-memory twin alike (gated on LUCENT_TEST_DATABASE_URL, the repo's
 * convention). Migration 0032 adds the nullable `title` column.
 */
const PG_URL = process.env.LUCENT_TEST_DATABASE_URL;
const describeIf = PG_URL ? describe : describe.skip;

describeIf("meeting store parity: titles and the workspace list", () => {
  let db: Db;
  const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const orgId = `org_mtg_${tag}`;
  const userId = `usr_mtg_${tag}`;
  const boardA = `brd_mtga_${tag}`;
  const boardB = `brd_mtgb_${tag}`;
  const boardC = `brd_mtgc_${tag}`;

  beforeAll(async () => {
    if (!PG_URL) return;
    db = createDb(PG_URL);
    await migrate(db);
    await new PostgresOrgStore(db).insert({ id: orgId, name: "Meetings", createdAt: 1 });
    await db.pool.query(
      "INSERT INTO users (id, email, name, password_hash, created_at) VALUES ($1, $2, $3, $4, 1) ON CONFLICT (id) DO NOTHING",
      [userId, `${userId}@example.com`, "Meetings", "x"],
    );
    for (const id of [boardA, boardB, boardC]) {
      await db.pool.query(
        "INSERT INTO boards (id, org_id, owner_id, name, workspace, created_at, updated_at) VALUES ($1, $2, $3, $4, '{}'::jsonb, 1, 1) ON CONFLICT (id) DO NOTHING",
        [id, orgId, userId, id],
      );
    }
  });

  afterAll(async () => {
    if (!db) return;
    await db.pool
      .query("DELETE FROM meeting_transcripts WHERE org_id = $1", [orgId])
      .catch(() => {});
    await db.pool
      .query("DELETE FROM boards WHERE id = ANY($1)", [[boardA, boardB, boardC]])
      .catch(() => {});
    await db.pool.query("DELETE FROM organizations WHERE id = $1", [orgId]).catch(() => {});
    await db.pool.query("DELETE FROM users WHERE id = $1", [userId]).catch(() => {});
    await closeDb(db);
  });

  const seed = (store: MeetingStore, boardId: string, startedAt: number, title?: string) =>
    store.insert({
      boardId,
      orgId,
      startedAt,
      endedAt: startedAt + 1,
      turns: [{ speaker: "A", at: startedAt, text: "x" }],
      createdBy: userId,
      createdAt: startedAt,
      ...(title ? { title } : {}),
    });

  it("round-trips titles and lists several boards newest first, identically", async () => {
    const results: unknown[] = [];
    for (const store of [new PostgresMeetingStore(db), new InMemoryMeetingStore()] as const) {
      const a = await seed(store, boardA, 1_000, "Kickoff");
      const b = await seed(store, boardB, 3_000);
      await seed(store, boardC, 2_000);
      const renamed = await store.setTitle(boardB, b.id, "Pricing");
      const cleared = await store.setTitle(boardA, a.id, null);
      const wrongBoard = await store.setTitle(boardC, a.id, "nope");
      const listed = await store.forBoards([boardA, boardB]);
      results.push({
        inserted: a.title,
        renamed: renamed?.title,
        cleared: cleared?.title,
        wrongBoard,
        list: listed.map((m) => [m.boardId === boardA ? "A" : "B", m.title ?? null]),
        none: await store.forBoards([]),
      });
    }
    expect(results[0]).toEqual({
      inserted: "Kickoff",
      renamed: "Pricing",
      cleared: undefined,
      wrongBoard: undefined,
      list: [
        ["B", "Pricing"],
        ["A", null],
      ],
      none: [],
    });
    expect(results[1]).toEqual(results[0]);
  });

  it("stores the end-of-meeting summary and reads it back as summarized (docs/28 A3.3)", async () => {
    const recap = {
      template: "general" as const,
      sections: [
        {
          title: "Decisions",
          items: [
            { text: "Ada: we agreed", source: "ai" as const, turns: [0, 0] as [number, number] },
          ],
        },
      ],
      generatedAt: 5,
      by: "fallback" as const,
      offline: "no-model" as const,
    };
    const results: unknown[] = [];
    for (const store of [new PostgresMeetingStore(db), new InMemoryMeetingStore()] as const) {
      const m = await seed(store, boardA, 7_000);
      const written = await store.setRecap(boardA, m.id, recap);
      const missing = await store.setRecap(boardB, m.id, recap);
      const read = await store.get(boardA, m.id);
      results.push({ written: written?.recap, missing, read: read?.recap });
    }
    expect(results[0]).toEqual({ written: recap, missing: undefined, read: recap });
    expect(results[1]).toEqual(results[0]);
  });

  it("keeps a plan, moves it, starts it once and can't cancel it after (docs/28 A3.4)", async () => {
    const results: unknown[] = [];
    for (const store of [new PostgresMeetingStore(db), new InMemoryMeetingStore()] as const) {
      const planned = await store.insert({
        boardId: boardA,
        orgId,
        startedAt: 50_000,
        endedAt: null,
        turns: [],
        createdBy: userId,
        createdAt: 1,
        title: "Plan",
        schedule: { scheduledFor: 50_000, durationMin: 30, invitees: [userId], template: "retro" },
      });
      const invitedBefore = (await store.invitedTo(userId)).some((m) => m.id === planned.id);
      const moved = await store.reschedule(
        boardA,
        planned.id,
        { scheduledFor: 60_000, durationMin: 45, invitees: [] },
        "Moved",
      );
      const earlyAppend = await store.appendTo(boardA, planned.id, [
        { speaker: "A", at: 1, text: "x" },
      ]);
      const started = await store.start(boardA, planned.id, {
        startedAt: 61_000,
        turns: [{ speaker: "A", at: 61_000, text: "go" }],
        mode: "record",
      });
      const startedAgain = await store.start(boardA, planned.id, {
        startedAt: 62_000,
        turns: [{ speaker: "B", at: 62_000, text: "no" }],
      });
      const lateCancel = await store.cancel(boardA, planned.id, userId, 63_000);

      const other = await store.insert({
        boardId: boardA,
        orgId,
        startedAt: 70_000,
        turns: [],
        createdBy: userId,
        createdAt: 1,
        schedule: { scheduledFor: 70_000, durationMin: 30, invitees: [] },
      });
      const cancelled = await store.cancel(boardA, other.id, userId, 65_000);
      const cancelledAgain = await store.cancel(boardA, other.id, userId, 66_000);
      const invitedAfter = (await store.invitedTo(userId)).some((m) => m.id === planned.id);
      results.push({
        invited: [invitedBefore, invitedAfter],
        plan: planned.schedule,
        moved: [moved?.startedAt, moved?.title, moved?.schedule],
        earlyAppend,
        started: [started?.startedAt, started?.turns.map((t) => t.text), started?.mode],
        startedAgain,
        lateCancel,
        cancelled: [cancelled?.cancelledAt, cancelled?.cancelledBy === userId, cancelled?.endedAt],
        cancelledAgain: cancelledAgain?.cancelledAt,
      });
    }
    expect(results[0]).toEqual({
      // Invited as planned; rescheduled to no invitees, not any more.
      invited: [true, false],
      plan: { scheduledFor: 50_000, durationMin: 30, invitees: [userId], template: "retro" },
      moved: [60_000, "Moved", { scheduledFor: 60_000, durationMin: 45, invitees: [] }],
      earlyAppend: undefined,
      started: [61_000, ["go"], "record"],
      startedAgain: undefined,
      lateCancel: undefined,
      // Cancelling closes it, never before its planned start.
      cancelled: [65_000, true, 70_000],
      cancelledAgain: 65_000,
    });
    expect(results[1]).toEqual(results[0]);
  });

  it("appends corrections atomically: two at once both land (docs/28 S7)", async () => {
    const pg = new PostgresMeetingStore(db);
    const m = await seed(pg, boardA, 8_000);
    await Promise.all([
      pg.addCorrection(boardA, m.id, { turn: 0, text: "first", by: userId, at: 1 }),
      pg.addCorrection(boardA, m.id, { turn: 0, text: "second", by: userId, at: 2 }),
    ]);
    const read = await pg.get(boardA, m.id);
    expect(read?.corrections?.map((c) => c.text).sort()).toEqual(["first", "second"]);
    expect(read?.turns[0]?.text).toBe("x");
    expect(
      await pg.addCorrection(boardB, m.id, { turn: 0, text: "no", by: userId, at: 3 }),
    ).toBeUndefined();
  });
});
