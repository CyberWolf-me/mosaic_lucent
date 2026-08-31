import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { meetingTranscripts } from "../db/schema.js";
import {
  MEETING_LIST_LIMIT,
  newMeetingId,
  type MeetingStore,
  type MeetingTranscript,
  type MeetingTurn,
  type NewMeetingTranscript,
} from "../meetings.js";

/**
 * Postgres-backed meeting transcript store (E3 / R3). Parity with
 * `InMemoryMeetingStore` is pinned by the gated suite in pg-store.test.ts.
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
  };
}
