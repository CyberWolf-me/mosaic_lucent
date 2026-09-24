import type { EnhancedNote, NoteLine, NoteTemplateId } from "@lucent/ai";
import { apiFetch } from "./http.js";
import { localIsoDate } from "./api.js";

/**
 * Meeting notes — client side (docs/27 N1). Private per person: every call
 * reads or writes the signed-in user's own notes on one meeting.
 */

export interface MeetingNotes {
  meetingId: string;
  template: NoteTemplateId;
  lines: NoteLine[];
  enhanced: EnhancedNote | null;
  updatedAt: number;
  /** Set on an enhance answer made without a model, and why. */
  offline?: "policy" | "no-model" | "model-failed";
}

const base = (boardId: string, meetingId: string) =>
  `/api/boards/${encodeURIComponent(boardId)}/meetings/${encodeURIComponent(meetingId)}/notes`;

export async function getNotes(boardId: string, meetingId: string): Promise<MeetingNotes | null> {
  try {
    const res = await apiFetch(base(boardId, meetingId));
    return res.ok ? ((await res.json()) as MeetingNotes) : null;
  } catch {
    return null;
  }
}

export async function saveNotes(
  boardId: string,
  meetingId: string,
  patch: { lines?: NoteLine[]; template?: NoteTemplateId; enhanced?: EnhancedNote | null },
): Promise<MeetingNotes | null> {
  try {
    const res = await apiFetch(base(boardId, meetingId), {
      method: "PUT",
      body: JSON.stringify(patch),
    });
    return res.ok ? ((await res.json()) as MeetingNotes) : null;
  } catch {
    return null;
  }
}

export async function enhanceNotes(
  boardId: string,
  meetingId: string,
  template: NoteTemplateId,
): Promise<MeetingNotes | { error: string }> {
  try {
    const res = await apiFetch(`${base(boardId, meetingId)}/enhance`, {
      method: "POST",
      body: JSON.stringify({ template, today: localIsoDate() }),
    });
    const body = (await res.json().catch(() => ({}))) as MeetingNotes & { error?: string };
    if (!res.ok) return { error: body.error ?? `Couldn't enhance the notes (${res.status}).` };
    return body;
  } catch {
    return { error: "Couldn't reach Lucent. Your notes are kept; try again." };
  }
}

/**
 * Keep each line's turn stamp across an edit of the whole notepad text. One
 * edit touches one contiguous region, so the lines before and after it are
 * matched by their text and keep their stamps (inserting a line mid-page
 * doesn't shift everything below it in time). Inside the region, a line
 * edited in place keeps its stamp; lines added are stamped with the turn
 * count now — "this came after what was said so far".
 */
export function restamp(previous: NoteLine[], text: string, turnNow: number): NoteLine[] {
  const texts = text.split("\n");
  let head = 0;
  while (head < previous.length && head < texts.length && previous[head]!.text === texts[head])
    head++;
  let tail = 0;
  while (
    tail < previous.length - head &&
    tail < texts.length - head &&
    previous[previous.length - 1 - tail]!.text === texts[texts.length - 1 - tail]
  )
    tail++;
  const changedBefore = previous.length - head - tail;
  return texts.map((t, i) => {
    if (i < head) return { text: t, turn: previous[i]!.turn };
    if (i >= texts.length - tail)
      return { text: t, turn: previous[previous.length - (texts.length - i)]!.turn };
    const k = i - head;
    return { text: t, turn: k < changedBefore ? previous[head + k]!.turn : turnNow };
  });
}

/** The note as Markdown: the person's lines as written, added lines cited by turn. */
export function noteToMarkdown(note: EnhancedNote, title: string): string {
  const out = [`# ${title}`, ""];
  for (const s of note.sections) {
    out.push(`## ${s.title}`, "");
    for (const i of s.items) {
      out.push(
        `- ${i.text}${i.source === "ai" && i.turns ? ` _(turn ${i.turns[0] + 1}${i.turns[1] > i.turns[0] ? `–${i.turns[1] + 1}` : ""})_` : ""}`,
      );
    }
    out.push("");
  }
  return out.join("\n").trimEnd() + "\n";
}
