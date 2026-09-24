import { and, eq } from "drizzle-orm";
import type { EnhancedNote, NoteLine, NoteTemplateId } from "@lucent/ai";
import type { Db } from "../db/client.js";
import { meetingNotes } from "../db/schema.js";
import type { MeetingNotesRecord, MeetingNotesStore } from "../meetingNotes.js";

/**
 * Postgres-backed meeting notes (docs/27 N1). `lines` and `enhanced` ride
 * JSONB as-is — the notes domain owns their shape and the routes validate
 * every write; the SQL never interprets them.
 */
export class PostgresMeetingNotesStore implements MeetingNotesStore {
  constructor(private readonly target: Db) {}

  async get(meetingId: string, userId: string): Promise<MeetingNotesRecord | undefined> {
    const rows = await this.target.db
      .select()
      .from(meetingNotes)
      .where(and(eq(meetingNotes.meetingId, meetingId), eq(meetingNotes.userId, userId)))
      .limit(1);
    const r = rows[0];
    return r
      ? {
          meetingId: r.meetingId,
          userId: r.userId,
          boardId: r.boardId,
          orgId: r.orgId,
          template: r.template as NoteTemplateId,
          lines: r.lines as NoteLine[],
          enhanced: (r.enhanced as EnhancedNote | null) ?? null,
          updatedAt: r.updatedAt,
        }
      : undefined;
  }

  async put(record: MeetingNotesRecord): Promise<MeetingNotesRecord> {
    const values = {
      meetingId: record.meetingId,
      userId: record.userId,
      boardId: record.boardId,
      orgId: record.orgId,
      template: record.template,
      lines: record.lines,
      enhanced: record.enhanced,
      updatedAt: record.updatedAt,
    };
    await this.target.db
      .insert(meetingNotes)
      .values(values)
      .onConflictDoUpdate({
        target: [meetingNotes.meetingId, meetingNotes.userId],
        set: {
          template: values.template,
          lines: values.lines,
          enhanced: values.enhanced,
          updatedAt: values.updatedAt,
        },
      });
    return record;
  }
}
