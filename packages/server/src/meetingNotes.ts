import { z } from "zod";
import {
  NOTE_TEMPLATE_IDS,
  type EnhancedNote,
  type NoteLine,
  type NoteTemplateId,
} from "@lucent/ai";

/**
 * Meeting notes (docs/27 N1): one person's notes on one meeting — the lines
 * they typed (each stamped with the transcript turn it followed) and, once
 * enhanced, the structured note. PRIVATE by construction: the key is
 * (meeting, user), and every read and write is the caller's own row. Sharing
 * a note is a later, explicit act; nothing here lets one member read
 * another's notes.
 */

export interface MeetingNotesRecord {
  meetingId: string;
  boardId: string;
  orgId: string;
  userId: string;
  template: NoteTemplateId;
  lines: NoteLine[];
  enhanced: EnhancedNote | null;
  updatedAt: number;
}

export interface MeetingNotesStore {
  get(meetingId: string, userId: string): Promise<MeetingNotesRecord | undefined>;
  put(record: MeetingNotesRecord): Promise<MeetingNotesRecord>;
}

export class InMemoryMeetingNotesStore implements MeetingNotesStore {
  private readonly rows = new Map<string, MeetingNotesRecord>();

  async get(meetingId: string, userId: string): Promise<MeetingNotesRecord | undefined> {
    const row = this.rows.get(`${meetingId}\u0000${userId}`);
    return row ? structuredClone(row) : undefined;
  }

  async put(record: MeetingNotesRecord): Promise<MeetingNotesRecord> {
    this.rows.set(`${record.meetingId}\u0000${record.userId}`, structuredClone(record));
    return structuredClone(record);
  }
}

export const NOTES_BODY_LIMITS = { lines: 500, lineChars: 2_000, sections: 12, items: 80 } as const;

const noteLine = z.object({
  text: z.string().max(NOTES_BODY_LIMITS.lineChars),
  turn: z.number().int().min(0).max(1_000_000),
});

const noteItem = z.object({
  text: z.string().min(1).max(NOTES_BODY_LIMITS.lineChars),
  source: z.enum(["user", "ai"]),
  turns: z.tuple([z.number().int().min(0), z.number().int().min(0)]).optional(),
  line: z.number().int().min(0).optional(),
});

const enhancedNote = z.object({
  template: z.enum(NOTE_TEMPLATE_IDS as [NoteTemplateId, ...NoteTemplateId[]]),
  sections: z
    .array(
      z.object({
        title: z.string().min(1).max(80),
        items: z.array(noteItem).max(NOTES_BODY_LIMITS.items),
      }),
    )
    .max(NOTES_BODY_LIMITS.sections),
  generatedAt: z.number(),
  by: z.enum(["model", "fallback"]),
  model: z.string().max(100).optional(),
});

/** PUT body: the typed lines, the template, and (after edits) the note itself. */
export const notesPutSchema = z.object({
  template: z.enum(NOTE_TEMPLATE_IDS as [NoteTemplateId, ...NoteTemplateId[]]).optional(),
  lines: z.array(noteLine).max(NOTES_BODY_LIMITS.lines).optional(),
  enhanced: enhancedNote.nullable().optional(),
});

/**
 * An edited note is re-checked against the transcript before it is stored:
 * a citation must still point inside the meeting. An AI line whose text the
 * person changed is theirs now (the client marks it "user"); a citation on a
 * line that claims to be the model's but points nowhere is dropped rather
 * than kept as a false source.
 */
export function sanitizeEnhanced(note: EnhancedNote, turnCount: number): EnhancedNote {
  return {
    ...note,
    sections: note.sections
      .map((s) => ({
        title: s.title,
        items: s.items
          .map((i) => {
            if (i.source === "user")
              return {
                text: i.text,
                source: "user" as const,
                ...(i.line !== undefined ? { line: i.line } : {}),
              };
            const t = i.turns;
            if (!t || t[0] > t[1] || t[1] >= turnCount) return null;
            return { text: i.text, source: "ai" as const, turns: t };
          })
          .filter((i): i is NonNullable<typeof i> => i !== null),
      }))
      .filter((s) => s.items.length > 0),
  };
}
