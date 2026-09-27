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
  /** The account that said it, when the capture knows (a call participant, docs/28 A3.5). */
  speakerId?: string;
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
  /** The meeting's name (ADR 0045); absent means untitled. */
  title?: string;
  /** The end-of-meeting summary (docs/28 A3.3); absent until written. */
  recap?: MeetingRecap;
  /** People's corrections to turns (docs/28 S7): an overlay, originals kept. */
  corrections?: Array<{ turn: number; text: string; by: string; at: number }>;
}

/** A turn as a reader sees it: corrected, with the original words kept aside. */
export type ReadTurn = MeetingTurn & { original?: string };

/**
 * The turns with each one's latest correction applied (docs/28 S7) — the
 * server's `correctedTurns`, mirrored. A corrected turn keeps its original
 * words in `original`, for the "edited" mark.
 */
export function correctedTurns(
  meeting: Pick<MeetingTranscript, "turns" | "corrections">,
): ReadTurn[] {
  const corrections = meeting.corrections ?? [];
  if (corrections.length === 0) return meeting.turns;
  const latest = new Map<number, { text: string; at: number }>();
  for (const c of corrections) {
    const prior = latest.get(c.turn);
    if (!prior || c.at >= prior.at) latest.set(c.turn, c);
  }
  return meeting.turns.map((t, i) => {
    const c = latest.get(i);
    return c && c.text !== t.text ? { ...t, text: c.text, original: t.text } : t;
  });
}

/** Correct what one turn says (editor). Null on failure. */
export async function correctTurn(
  boardId: string,
  meetingId: string,
  turn: number,
  text: string,
): Promise<MeetingTranscript | null> {
  const res = await apiFetch(
    `/api/boards/${encodeURIComponent(boardId)}/meetings/${encodeURIComponent(meetingId)}/turns/${turn}/correction`,
    { method: "POST", body: JSON.stringify({ text }) },
  );
  if (!res.ok) return null;
  return (await res.json()) as MeetingTranscript;
}

/**
 * The end-of-meeting summary: the notes enhancer's cited note over the whole
 * transcript. Every line cites the turns it came from; `offline` says why the
 * model didn't write it, when it didn't.
 */
export interface MeetingRecap {
  sections: Array<{
    title: string;
    items: Array<{ text: string; source: "user" | "ai"; turns?: [number, number] }>;
  }>;
  generatedAt: number;
  by: "model" | "fallback";
  model?: string;
  offline?: "policy" | "no-model" | "limit" | "model-failed";
}

/** One meeting with its transcript (and summary); null when it can't be read. */
export async function fetchMeeting(
  boardId: string,
  meetingId: string,
): Promise<MeetingTranscript | null> {
  const res = await apiFetch(
    `/api/boards/${encodeURIComponent(boardId)}/meetings/${encodeURIComponent(meetingId)}`,
  );
  if (!res.ok) return null;
  return (await res.json()) as MeetingTranscript;
}

/**
 * Write (or rewrite) the end-of-meeting summary now (docs/28 S9). The error
 * is the server's own words — "Record mode keeps the transcript only".
 */
export async function writeMeetingSummary(
  boardId: string,
  meetingId: string,
): Promise<{ ok: true; meeting: MeetingTranscript } | { ok: false; error: string }> {
  const res = await apiFetch(
    `/api/boards/${encodeURIComponent(boardId)}/meetings/${encodeURIComponent(meetingId)}/summary`,
    { method: "POST" },
  );
  if (res.ok) return { ok: true, meeting: (await res.json()) as MeetingTranscript };
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return { ok: false, error: body.error ?? "Couldn't write the summary — try again." };
}

/** One row of the workspace meetings list (ADR 0045): no turns. */
export interface MeetingSummary {
  id: string;
  boardId: string;
  boardName: string;
  title: string | null;
  status: "live" | "ended" | "summarized";
  startedAt: number;
  endedAt: number | null;
  turnCount: number;
  mode: string | null;
  createdBy: string | null;
}

/**
 * What a meeting is called where a person reads it: its title, or — for an
 * untitled one — the board and the day it started.
 */
export function meetingName(
  meeting: { title?: string | null; startedAt: number },
  boardName?: string,
): string {
  if (meeting.title) return meeting.title;
  const day = new Date(meeting.startedAt).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  return boardName ? `${boardName} · ${day}` : `Meeting · ${day}`;
}

/**
 * Every meeting on the boards this person can read in the org, newest first
 * (docs/28 S1). Null when the call fails, so the view can say so.
 */
export async function listWorkspaceMeetings(orgId: string): Promise<MeetingSummary[] | null> {
  const res = await apiFetch(`/api/orgs/${encodeURIComponent(orgId)}/meetings?limit=100`);
  if (!res.ok) return null;
  const body = (await res.json()) as { meetings?: MeetingSummary[] };
  return Array.isArray(body.meetings) ? body.meetings : [];
}

/** Name a meeting; an empty title makes it untitled again. Null on failure. */
export async function renameMeeting(
  boardId: string,
  meetingId: string,
  title: string,
): Promise<MeetingTranscript | null> {
  const res = await apiFetch(
    `/api/boards/${encodeURIComponent(boardId)}/meetings/${encodeURIComponent(meetingId)}`,
    { method: "PATCH", body: JSON.stringify({ title }) },
  );
  if (!res.ok) return null;
  return (await res.json()) as MeetingTranscript;
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
