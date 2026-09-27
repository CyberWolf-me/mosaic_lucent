import { classifyTurn, type NoteTemplateId } from "@lucent/ai";
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
  /** The plan, for a scheduled meeting (docs/28 A3.4). */
  schedule?: MeetingSchedule;
  /** When the host called it off. */
  cancelledAt?: number;
  cancelledBy?: string;
}

/** A scheduled meeting's plan (docs/28 S2) — the server's MeetingSchedule. */
export interface MeetingSchedule {
  scheduledFor: number;
  durationMin: number;
  invitees: string[];
  template?: NoteTemplateId;
}

/** What a person fills in to schedule a meeting (S2). */
export interface MeetingPlan {
  title: string;
  scheduledFor: number;
  durationMin: number;
  invitees: string[];
  template?: NoteTemplateId;
  mode?: string;
}

/** Scheduled and not yet started — the meeting page (S3) instead of a transcript. */
export function isUpcoming(meeting: Pick<MeetingTranscript, "schedule" | "turns" | "endedAt">) {
  return meeting.schedule !== undefined && meeting.turns.length === 0 && meeting.endedAt === null;
}

/** Someone who can be invited: they can read the board. */
export interface Invitable {
  id: string;
  name: string;
  email: string;
}

export async function listInvitable(boardId: string): Promise<Invitable[] | null> {
  const res = await apiFetch(`/api/boards/${encodeURIComponent(boardId)}/meetings/invitable`);
  if (!res.ok) return null;
  return ((await res.json()) as { people: Invitable[] }).people;
}

type PlanResult =
  | { ok: true; meeting: MeetingTranscript; invited: number }
  | { ok: false; error: string };

async function planResult(res: Response, fallback: string): Promise<PlanResult> {
  const body = (await res.json().catch(() => ({}))) as {
    meeting?: MeetingTranscript;
    invited?: number;
    error?: string;
  } & Partial<MeetingTranscript>;
  if (!res.ok) {
    return {
      ok: false,
      error:
        res.status === 404
          ? "You can schedule only on boards you can edit."
          : (body.error ?? fallback),
    };
  }
  const meeting = body.meeting ?? (body as MeetingTranscript);
  return { ok: true, meeting, invited: body.invited ?? 0 };
}

/** Schedule a meeting; invites go out from the server. */
export async function scheduleMeeting(boardId: string, plan: MeetingPlan): Promise<PlanResult> {
  try {
    const res = await apiFetch(`/api/boards/${encodeURIComponent(boardId)}/meetings/schedule`, {
      method: "POST",
      body: JSON.stringify(plan),
    });
    return await planResult(res, "Couldn't create the meeting.");
  } catch {
    return { ok: false, error: "Couldn't reach the server. Try again." };
  }
}

/** Change a scheduled meeting's plan (host). */
export async function rescheduleMeeting(
  boardId: string,
  meetingId: string,
  plan: MeetingPlan,
): Promise<PlanResult> {
  try {
    const res = await apiFetch(
      `/api/boards/${encodeURIComponent(boardId)}/meetings/${encodeURIComponent(meetingId)}/reschedule`,
      { method: "POST", body: JSON.stringify(plan) },
    );
    return await planResult(res, "Couldn't change the meeting.");
  } catch {
    return { ok: false, error: "Couldn't reach the server. Try again." };
  }
}

/** Call a scheduled meeting off (host). */
export async function cancelMeeting(
  boardId: string,
  meetingId: string,
): Promise<{ ok: true; meeting: MeetingTranscript } | { ok: false; error: string }> {
  const res = await apiFetch(
    `/api/boards/${encodeURIComponent(boardId)}/meetings/${encodeURIComponent(meetingId)}/cancel`,
    { method: "POST" },
  );
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return res.ok
    ? { ok: true, meeting: body as MeetingTranscript }
    : { ok: false, error: body.error ?? "Couldn't cancel the meeting." };
}

/** The host and the invitees, by name. */
export interface MeetingPeople {
  host: { id: string; name: string } | null;
  invitees: Array<{ id: string; name: string }>;
  cancelledBy: { id: string; name: string } | null;
  youHost: boolean;
}

export async function fetchMeetingPeople(
  boardId: string,
  meetingId: string,
): Promise<MeetingPeople | null> {
  const res = await apiFetch(
    `/api/boards/${encodeURIComponent(boardId)}/meetings/${encodeURIComponent(meetingId)}/people`,
  );
  return res.ok ? ((await res.json()) as MeetingPeople) : null;
}

/** The meeting's calendar file (Add to calendar). */
export function calendarFileUrl(boardId: string, meetingId: string): string {
  return `/api/boards/${encodeURIComponent(boardId)}/meetings/${encodeURIComponent(meetingId)}/calendar.ics`;
}

/** "Tue 3 Oct, 14:00–14:45" in the reader's own time zone. */
export function meetingTimeRange(scheduledFor: number, durationMin: number): string {
  const start = new Date(scheduledFor);
  const end = new Date(scheduledFor + durationMin * 60_000);
  const day = start.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
  const time = (d: Date) => d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${day}, ${time(start)}–${time(end)}`;
}

/** "in 2 h", "in 5 min", "now", "started 10 min ago" — relative to `now`. */
export function startsIn(scheduledFor: number, now: number): string {
  const diff = scheduledFor - now;
  const minutes = Math.round(Math.abs(diff) / 60_000);
  const span =
    minutes < 1
      ? null
      : minutes < 60
        ? `${minutes} min`
        : minutes < 48 * 60
          ? `${Math.round(minutes / 60)} h`
          : `${Math.round(minutes / (24 * 60))} days`;
  if (span === null) return "now";
  return diff > 0 ? `in ${span}` : `started ${span} ago`;
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

/** Who "Notify owners" told, and which owners matched no one (docs/28 S11). */
export interface OwnersNotified {
  told: Array<{ name: string; you: boolean; actions: number }>;
  unmatched: string[];
  actions: number;
}

/** Tell each owner the actions they own from this meeting (docs/28 S11). */
export async function notifyMeetingOwners(
  boardId: string,
  meetingId: string,
): Promise<{ ok: true; result: OwnersNotified } | { ok: false; error: string }> {
  try {
    const res = await apiFetch(
      `/api/boards/${encodeURIComponent(boardId)}/meetings/${encodeURIComponent(meetingId)}/notify-owners`,
      { method: "POST" },
    );
    const body = (await res.json().catch(() => ({}))) as { error?: string } & OwnersNotified;
    if (!res.ok) return { ok: false, error: body.error ?? "Couldn't tell the owners — try again." };
    return { ok: true, result: body };
  } catch {
    return { ok: false, error: "Couldn't reach Lucent — try again." };
  }
}

/** One row of the workspace meetings list (ADR 0045): no turns. */
export interface MeetingSummary {
  id: string;
  boardId: string;
  boardName: string;
  title: string | null;
  status: "scheduled" | "cancelled" | "live" | "ended" | "summarized";
  startedAt: number;
  endedAt: number | null;
  turnCount: number;
  mode: string | null;
  createdBy: string | null;
  /** The plan, for a scheduled meeting (A3.4). */
  scheduledFor?: number | null;
  durationMin?: number | null;
  inviteeCount?: number;
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

/**
 * Scheduled meetings that invite this person, on any board they can read —
 * including boards another org shared with them (docs/28 A3.4). Empty when
 * the call fails: the workspace list still stands on its own.
 */
export async function listInvitedMeetings(): Promise<MeetingSummary[]> {
  try {
    const res = await apiFetch("/api/meetings/invited");
    if (!res.ok) return [];
    const body = (await res.json()) as { meetings?: MeetingSummary[] };
    return Array.isArray(body.meetings) ? body.meetings : [];
  } catch {
    return [];
  }
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

// The keyword classifier lives in @lucent/ai (docs/26 A5): the server's
// end-of-meeting extraction tags turns the same way this view does.
export { classifyTurn };

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
