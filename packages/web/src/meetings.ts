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
  /** Capture profile in force when recorded (docs/24 Phase D); absent on older rows. */
  mode?: string;
}

/**
 * Classify one turn for the extract board. A keyword heuristic, not a model
 * call: the classification is a *draft* the meeting owner can correct before
 * saving, and a model round-trip per line would cost real money for output
 * the user overrides anyway. The keywords are deliberately few — each one
 * must justify itself by catching turns the alternatives miss.
 *
 * A rejection ("no, we're not doing X") classifies as a DECISION: in the
 * statement-kind model it is the strongest decision signal there is — it
 * closes an option — and the differential prompt teaches the extraction to
 * mark what it superseded (found by the meeting-eval suite: the disagreement
 * fixture's "No, we're not doing usage-based pricing" fell through every
 * branch and rendered unclassified).
 */
export function classifyTurn(text: string): MeetingTurn["kind"] | undefined {
  const t = text.toLowerCase();
  if (
    /\b(we'?ll|we will|let's|decided|agree[d]?|we'?re not doing|we are not doing|no, we'?re not)\b/.test(
      t,
    )
  )
    return "decision";
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
    "Give statement nodes their meaning with SET_STATEMENT: a decided point is kind=decision status=resolved (born resolved — an undecided 'decision' is a proposal); speculation is kind=proposal status=open; a genuine commitment is kind=action (with SET_ISSUE for its owner); requirements and risks map to their own kinds. Set a short kebab-case topic (e.g. 'pricing') when the subject is clear — and REUSE a topic key the board already carries when the subject matches (existing statement topics appear in the board summary); minting 'pricing-model' beside an existing 'pricing' splits the group.",
    "",
    "Transcript:",
    lines,
  ].join("\n");
}

/** Save the in-progress capture to the board. Returns the stored transcript or null. */
export async function saveMeeting(
  boardId: string,
  input: { turns: MeetingTurn[]; startedAt: number; endedAt?: number | null; mode?: string },
): Promise<MeetingTranscript | null> {
  const res = await apiFetch(`/api/boards/${encodeURIComponent(boardId)}/meetings`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (!res.ok) return null;
  return (await res.json()) as MeetingTranscript;
}

/**
 * Checkpoint append (M2): push the turns captured since the last checkpoint
 * into a RUNNING meeting, so a refresh mid-meeting loses nothing. Returns
 * the extended transcript, or null when the meeting isn't open for appends
 * (wrong id, or it already ended — the caller falls back to a fresh save).
 */
export async function appendMeetingTurns(
  boardId: string,
  meetingId: string,
  turns: MeetingTurn[],
): Promise<MeetingTranscript | null> {
  const res = await apiFetch(
    `/api/boards/${encodeURIComponent(boardId)}/meetings/${encodeURIComponent(meetingId)}/turns`,
    { method: "POST", body: JSON.stringify({ turns }) },
  );
  if (!res.ok) return null;
  return (await res.json()) as MeetingTranscript;
}

/**
 * End a live capture (Stage C3): stopRecording used to abandon the id and
 * the store kept saying "in progress" forever. Idempotent server-side, so
 * a retry is harmless; null when the board/meeting is unknown (the caller
 * treats it like the abandon path — nothing to recover locally).
 */
export async function endMeeting(
  boardId: string,
  meetingId: string,
): Promise<MeetingTranscript | null> {
  const res = await apiFetch(
    `/api/boards/${encodeURIComponent(boardId)}/meetings/${encodeURIComponent(meetingId)}/end`,
    { method: "POST", body: JSON.stringify({ endedAt: Date.now() }) },
  );
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
