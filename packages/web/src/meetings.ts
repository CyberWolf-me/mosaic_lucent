import { apiFetch } from "./http.js";

/**
 * Meeting transcripts — client side (E3 / R3).
 *
 * The wire types mirror `packages/server/src/meetings.ts` (copied, not
 * imported, for the same reason PlanRefusal is: the browser bundle does not
 * depend on the server package). The pure helpers (`classifyTurn`,
 * `promptFromTranscript`) are the meeting flow's own decisions and are
 * unit-tested in meetings-logic.test.ts.
 */

/** One classified line of the transcript. */
export interface MeetingTurn {
  speaker: string;
  at: number;
  text: string;
  kind?: "problem" | "hypothesis" | "solution" | "decision" | "action" | "requirement";
}

/** One saved meeting, from the server. */
export interface MeetingTranscript {
  id: string;
  boardId: string;
  orgId: string;
  startedAt: number;
  endedAt: number | null;
  turns: MeetingTurn[];
  createdBy: string | null;
  createdAt: number;
}

/**
 * Classify one turn for the extract board. A keyword heuristic, not a model
 * call: the classification is a *draft* the meeting owner can correct before
 * saving, and a model round-trip per line would cost real money for output
 * the user overrides anyway. The keywords are deliberately few — each one
 * must justify itself by catching turns the alternatives miss.
 */
export function classifyTurn(text: string): MeetingTurn["kind"] | undefined {
  const t = text.toLowerCase();
  if (/\b(we'?ll|we will|let's|decided|agree[d]?)\b/.test(t)) return "decision";
  if (/\b(problem|bug|broken|fails?|can'?t|blocked)\b/.test(t)) return "problem";
  if (/\b(we need|require[sd]?|must|should)\b/.test(t)) return "requirement";
  if (/\b(action|todo|task|next step|i'?ll|assign)\b/.test(t)) return "action";
  if (/\b(maybe|perhaps|what if|might|could try|assume)\b/.test(t)) return "hypothesis";
  if (/\b(solution|fix|instead|workaround|so we)\b/.test(t)) return "solution";
  return undefined;
}

/**
 * Build the extraction prompt from a saved transcript: one line per turn,
 * speaker-labelled, with the classified lines called out. This is the text
 * the normal `send()` pipeline receives, so extraction inherits the entire
 * generate path — validation, metering, history, the AI's own op-batch.
 *
 * The prompt states the goal and the shape; the transcript is presented as
 * quoted data with speaker names, so the model reads it as minutes, not as
 * instructions to it — the same treatment buildUserPrompt gives any user
 * content.
 */
export function promptFromTranscript(meeting: MeetingTranscript): string {
  const lines = meeting.turns
    .map((t) => {
      const tag = t.kind ? ` [${t.kind}]` : "";
      return `${t.speaker}${tag}: ${t.text}`;
    })
    .join("\n");
  return [
    "Build a diagram from this meeting transcript. Use one node per distinct point, connect related points, and group them by the bracketed classifications where present.",
    "",
    "Transcript:",
    lines,
  ].join("\n");
}

/** Save the in-progress capture to the board. Returns the stored transcript or null. */
export async function saveMeeting(
  boardId: string,
  input: { turns: MeetingTurn[]; startedAt: number; endedAt?: number | null },
): Promise<MeetingTranscript | null> {
  const res = await apiFetch(`/api/boards/${encodeURIComponent(boardId)}/meetings`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (!res.ok) return null;
  return (await res.json()) as MeetingTranscript;
}

/** The board's saved meetings, newest first; null when the call fails. */
export async function listMeetings(boardId: string): Promise<MeetingTranscript[] | null> {
  const res = await apiFetch(`/api/boards/${encodeURIComponent(boardId)}/meetings`);
  if (!res.ok) return null;
  const body = (await res.json()) as { meetings?: MeetingTranscript[] };
  return Array.isArray(body.meetings) ? body.meetings : [];
}
