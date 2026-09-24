import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, type Db } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { PostgresOrgStore } from "../src/orgs.js";
import { PostgresMeetingStore } from "../src/store/pg-meetings.js";
import { PostgresMeetingNotesStore } from "../src/store/pg-meeting-notes.js";
import { InMemoryMeetingNotesStore, type MeetingNotesRecord } from "../src/meetingNotes.js";

/**
 * docs/27 N1: the Postgres notes store behaves like its in-memory twin —
 * private per (meeting, user), upsert on save, and it goes when its meeting
 * goes. Gated on LUCENT_TEST_DATABASE_URL, like the other pg suites (CI runs
 * them against postgres:16); each run tags its own ids, so no TRUNCATE.
 */

const URL = process.env.LUCENT_TEST_DATABASE_URL;
const describeIf = URL ? describe : describe.skip;
const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

describeIf("PostgresMeetingNotesStore", () => {
  let db: Db;
  const orgId = `org_notes_${tag}`;
  const boardId = `brd_notes_${tag}`;
  const alice = `usr_notes_a_${tag}`;
  const bob = `usr_notes_b_${tag}`;
  let meetingId = "";

  beforeAll(async () => {
    if (!URL) return;
    db = createDb(URL);
    await migrate(db);
    await new PostgresOrgStore(db).insert({ id: orgId, name: "Notes", createdAt: 1 });
    for (const id of [alice, bob]) {
      await db.pool.query(
        "INSERT INTO users (id, email, name, password_hash, created_at) VALUES ($1, $2, $3, $4, 1) ON CONFLICT (id) DO NOTHING",
        [id, `${id}@example.com`, id, "x"],
      );
    }
    await db.pool.query(
      "INSERT INTO boards (id, org_id, owner_id, name, workspace, created_at, updated_at) VALUES ($1, $2, $3, $4, '{}'::jsonb, 1, 1) ON CONFLICT (id) DO NOTHING",
      [boardId, orgId, alice, "Notes"],
    );
    const meeting = await new PostgresMeetingStore(db).insert({
      boardId,
      orgId,
      startedAt: 1,
      turns: [{ speaker: "A", at: 1, text: "We decided." }],
      createdBy: alice,
      createdAt: 1,
    });
    meetingId = meeting.id;
  });

  afterAll(async () => {
    if (db) await closeDb(db);
  });

  it("round-trips, upserts, keeps each person's notes apart — like the twin", async () => {
    const pg = new PostgresMeetingNotesStore(db);
    const mem = new InMemoryMeetingNotesStore();
    const rec = (userId: string, text: string): MeetingNotesRecord => ({
      meetingId,
      boardId,
      orgId,
      userId,
      template: "general",
      lines: [{ text, turn: 1 }],
      enhanced: null,
      updatedAt: 5,
    });
    for (const store of [pg, mem]) {
      await store.put(rec(alice, "alice first"));
      await store.put(rec(bob, "bob's own"));
      await store.put({
        ...rec(alice, "alice edited"),
        enhanced: {
          template: "general",
          sections: [
            { title: "Decisions", items: [{ text: "Decided.", source: "ai", turns: [0, 0] }] },
          ],
          generatedAt: 9,
          by: "model",
        },
        updatedAt: 9,
      });
      const a = await store.get(meetingId, alice);
      const b = await store.get(meetingId, bob);
      expect(a?.lines).toEqual([{ text: "alice edited", turn: 1 }]);
      expect(a?.enhanced?.sections[0]?.items[0]?.turns).toEqual([0, 0]);
      expect(b?.lines).toEqual([{ text: "bob's own", turn: 1 }]);
      expect(await store.get(meetingId, "usr_nobody")).toBeUndefined();
    }
  });

  it("goes when its meeting goes", async () => {
    await db.pool.query("DELETE FROM meeting_transcripts WHERE id = $1", [meetingId]);
    expect(await new PostgresMeetingNotesStore(db).get(meetingId, alice)).toBeUndefined();
  });
});
