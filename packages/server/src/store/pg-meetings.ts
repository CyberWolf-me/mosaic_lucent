import { and, desc, eq, inArray, isNotNull, isNull, lt, lte, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { meetingTranscripts } from "../db/schema.js";
import {
  MEETING_LIST_LIMIT,
  lastActivity,
  newMeetingId,
  type MeetingRecap,
  type MeetingStore,
  type MeetingTranscript,
  type MeetingTurn,
  type TurnCorrection,
  type NewMeetingTranscript,
} from "../meetings.js";

/**
 * Postgres-backed meeting transcript store (E3 / R3). Parity with
 * `InMemoryMeetingStore` is pinned by the gated suites (LUCENT_TEST_DATABASE_URL)
 * in meeting-store-pg.test.ts, idle-captures.test.ts and retention.test.ts.
 *
 * `turns` rides the JSONB column as-is — the meeting flow owns its shape,
 * the store only copies (the same split the workspace blob gets: the SQL
 * never interprets board state).
 */
export class PostgresMeetingStore implements MeetingStore {
  constructor(private readonly target: Db) {}

  async insert(input: NewMeetingTranscript): Promise<MeetingTranscript> {
    const rows = await this.target.db
      .insert(meetingTranscripts)
      .values({
        id: newMeetingId(),
        boardId: input.boardId,
        orgId: input.orgId,
        startedAt: input.startedAt,
        endedAt: input.endedAt ?? null,
        turns: input.turns,
        ...(input.mode !== undefined ? { mode: input.mode } : {}),
        ...(input.title ? { title: input.title } : {}),
        createdBy: input.createdBy,
        createdAt: input.createdAt,
      })
      .returning();
    return toRow(rows[0]!);
  }

  async forBoard(boardId: string, limit = MEETING_LIST_LIMIT): Promise<MeetingTranscript[]> {
    const rows = await this.target.db
      .select()
      .from(meetingTranscripts)
      .where(eq(meetingTranscripts.boardId, boardId))
      .orderBy(desc(meetingTranscripts.startedAt), desc(meetingTranscripts.id))
      .limit(limit);
    return rows.map(toRow);
  }

  async forBoards(
    boardIds: readonly string[],
    limit = MEETING_LIST_LIMIT,
  ): Promise<MeetingTranscript[]> {
    // An empty IN () is not SQL; no boards means no meetings.
    if (boardIds.length === 0) return [];
    const rows = await this.target.db
      .select()
      .from(meetingTranscripts)
      .where(inArray(meetingTranscripts.boardId, [...boardIds]))
      .orderBy(desc(meetingTranscripts.startedAt), desc(meetingTranscripts.id))
      .limit(limit);
    return rows.map(toRow);
  }

  async setTitle(
    boardId: string,
    id: string,
    title: string | null,
  ): Promise<MeetingTranscript | undefined> {
    const rows = await this.target.db
      .update(meetingTranscripts)
      .set({ title })
      .where(and(eq(meetingTranscripts.boardId, boardId), eq(meetingTranscripts.id, id)))
      .returning();
    return rows[0] ? toRow(rows[0]) : undefined;
  }

  async setRecap(
    boardId: string,
    id: string,
    recap: MeetingRecap,
  ): Promise<MeetingTranscript | undefined> {
    const rows = await this.target.db
      .update(meetingTranscripts)
      .set({ summary: recap })
      .where(and(eq(meetingTranscripts.boardId, boardId), eq(meetingTranscripts.id, id)))
      .returning();
    return rows[0] ? toRow(rows[0]) : undefined;
  }

  /**
   * Append one correction atomically: a JSONB concatenation inside the one
   * UPDATE, so two editors correcting at once both land — a read-modify-write
   * here would let the second write drop the first. The board-scoped WHERE
   * keeps a leaked id from writing elsewhere.
   */
  async addCorrection(
    boardId: string,
    id: string,
    correction: TurnCorrection,
  ): Promise<MeetingTranscript | undefined> {
    const rows = await this.target.db
      .update(meetingTranscripts)
      .set({
        corrections: sql`COALESCE(${meetingTranscripts.corrections}, '[]'::jsonb) || ${JSON.stringify([correction])}::jsonb`,
      })
      .where(and(eq(meetingTranscripts.boardId, boardId), eq(meetingTranscripts.id, id)))
      .returning();
    return rows[0] ? toRow(rows[0]) : undefined;
  }

  async get(boardId: string, id: string): Promise<MeetingTranscript | undefined> {
    const rows = await this.target.db
      .select()
      .from(meetingTranscripts)
      .where(and(eq(meetingTranscripts.boardId, boardId), eq(meetingTranscripts.id, id)))
      .limit(1);
    return rows[0] ? toRow(rows[0]) : undefined;
  }

  /**
   * Append to a RUNNING meeting: JSONB read-modify-write with the ended-null
   * precondition enforced in the WHERE, so a concurrent "end this meeting"
   * makes the append affect zero rows (and return undefined) rather than
   * resurrecting closed minutes.
   */
  async appendTo(
    boardId: string,
    id: string,
    turns: MeetingTurn[],
  ): Promise<MeetingTranscript | undefined> {
    const existing = await this.get(boardId, id);
    if (!existing || existing.endedAt !== null) return undefined;
    const merged = [...existing.turns, ...turns];
    const rows = await this.target.db
      .update(meetingTranscripts)
      .set({ turns: merged })
      .where(
        and(
          eq(meetingTranscripts.boardId, boardId),
          eq(meetingTranscripts.id, id),
          isNull(meetingTranscripts.endedAt),
        ),
      )
      .returning();
    return rows[0] ? toRow(rows[0]) : undefined;
  }

  /**
   * End a still-open meeting (Stage C3): the `isNull(endedAt)` precondition
   * in the WHERE makes a concurrent double-end affect zero rows — the row
   * comes back unchanged, the idempotent answer. A `gte(startedAt)` guard
   * keeps a bad timestamp from back-dating the meeting's end before its
   * start.
   */
  async end(boardId: string, id: string, endedAt: number): Promise<MeetingTranscript | undefined> {
    const rows = await this.target.db
      .update(meetingTranscripts)
      .set({ endedAt })
      .where(
        and(
          eq(meetingTranscripts.boardId, boardId),
          eq(meetingTranscripts.id, id),
          isNull(meetingTranscripts.endedAt),
          // endedAt >= startedAt, expressed from the startedAt side: an end
          // timestamp before the meeting began back-dates the record.
          lte(meetingTranscripts.startedAt, endedAt),
        ),
      )
      .returning();
    // Zero rows means the row is unknown OR already ended OR the timestamp
    // predates the start; the already-ended case must still answer with the
    // row (idempotent), so read it back when the update touched nothing.
    if (rows[0]) return toRow(rows[0]);
    return this.get(boardId, id);
  }

  /**
   * docs/24 Phase H: delete ended transcripts older than the cutoff, oldest
   * first, bounded. Two steps (select ids, then delete by id) because
   * Postgres DELETE takes no LIMIT: the ids are the claim, and a concurrent
   * end between the steps can only move a row OUT of eligibility (endedAt
   * becomes now, which is past any cutoff) — never strand a running
   * capture, which the WHERE excludes by construction.
   */
  async deleteExpired(orgId: string, endedBefore: number, limit: number): Promise<number> {
    if (limit <= 0) return 0;
    const stale = await this.target.db
      .select({ id: meetingTranscripts.id })
      .from(meetingTranscripts)
      .where(
        and(
          eq(meetingTranscripts.orgId, orgId),
          isNotNull(meetingTranscripts.endedAt),
          lt(meetingTranscripts.endedAt, endedBefore),
        ),
      )
      .orderBy(meetingTranscripts.endedAt)
      .limit(limit);
    if (stale.length === 0) return 0;
    await this.target.db.delete(meetingTranscripts).where(
      inArray(
        meetingTranscripts.id,
        stale.map((r) => r.id),
      ),
    );
    return stale.length;
  }

  /**
   * docs/28 F14: end abandoned captures at their last activity. The last
   * turn lives inside the JSONB, so idleness is judged in JS over the open
   * rows that started before the cutoff (a capture that began after it
   * cannot have been idle since) — live captures plus orphans, a handful.
   * Each end carries the `isNull(endedAt)` precondition, so a capture that
   * ends itself between the read and the write keeps its own end.
   */
  async endIdle(idleBefore: number, limit: number): Promise<number> {
    if (limit <= 0) return 0;
    const open = await this.target.db
      .select()
      .from(meetingTranscripts)
      .where(and(isNull(meetingTranscripts.endedAt), lt(meetingTranscripts.startedAt, idleBefore)));
    const idle = open
      .map(toRow)
      .filter((row) => lastActivity(row) < idleBefore)
      .sort((a, b) => lastActivity(a) - lastActivity(b))
      .slice(0, limit);
    let ended = 0;
    for (const row of idle) {
      const rows = await this.target.db
        .update(meetingTranscripts)
        .set({ endedAt: lastActivity(row) })
        .where(and(eq(meetingTranscripts.id, row.id), isNull(meetingTranscripts.endedAt)))
        .returning({ id: meetingTranscripts.id });
      ended += rows.length;
    }
    return ended;
  }
}

function toRow(row: typeof meetingTranscripts.$inferSelect): MeetingTranscript {
  return {
    id: row.id,
    boardId: row.boardId,
    orgId: row.orgId,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    turns: row.turns as MeetingTurn[],
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    // Pre-profile rows read NULL: absence, not a value (meetings.ts).
    ...(row.mode !== null && row.mode !== undefined
      ? { mode: row.mode as MeetingTranscript["mode"] }
      : {}),
    // Untitled rows read NULL: absence, like mode (ADR 0045).
    ...(row.title ? { title: row.title } : {}),
    // No summary yet (or Record mode) reads NULL (docs/28 A3.3).
    ...(row.summary ? { recap: row.summary as MeetingRecap } : {}),
    // No corrections reads NULL (docs/28 S7).
    ...(Array.isArray(row.corrections) && row.corrections.length > 0
      ? { corrections: row.corrections as TurnCorrection[] }
      : {}),
  };
}
