import { randomBytes } from "node:crypto";
import { isNoteTemplateId, type EnhancedNote, type NoteTemplateId } from "@lucent/ai";

/**
 * Meeting transcripts (E3 / R3): the diarised record of one meeting held on
 * a board, plus the extraction classification the meeting flow computes.
 *
 * Shape mirrors the other board-scoped stores (presence, snapshots): rows
 * are read and written whole, the interface is narrow on purpose — a
 * transcript is immutable once saved; "editing the minutes" is a new save.
 * `endedAt` nullable because an in-flight capture can be persisted before
 * the meeting actually ends (the web's save button), and the row is the
 * source the extraction reads.
 */

/** One classified line of the transcript. The extraction's own data rides `kind`. */
export interface MeetingTurn {
  /** Speaker label as the STT provider reported it: a LiveKit identity, or "You" for local STT. */
  speaker: string;
  /** Epoch ms the turn was finalised at. */
  at: number;
  /** The final (not interim) recognised text. */
  text: string;
  /** The meeting flow's classification of this line, when the flow classifies. */
  kind?: "problem" | "hypothesis" | "solution" | "decision" | "action" | "requirement";
  /**
   * The account that said it, when the capture knows (docs/28 A3.5): in a
   * call, each person's line arrives from their own device, as their LiveKit
   * identity — their user id. Absent for on-device capture of a room.
   */
  speakerId?: string;
}

/**
 * A person's correction to one transcript turn (docs/28 S7, spec §23). An
 * OVERLAY: the turn itself is never rewritten, so an ended transcript stays
 * immutable and the original words stay on record. The latest correction of
 * a turn is what readers — the summary, Ask, search, extraction — see.
 */
export interface TurnCorrection {
  /** Index of the corrected turn. */
  turn: number;
  text: string;
  /** Who corrected it. */
  by: string;
  at: number;
}

/** How long a corrected line may be — the same cap as a turn. */
export const MAX_CORRECTION_CHARS = 2000;

/** The turns as readers should see them: each turn's latest correction applied. */
export function correctedTurns(
  meeting: Pick<MeetingTranscript, "turns" | "corrections">,
): MeetingTurn[] {
  const corrections = meeting.corrections ?? [];
  if (corrections.length === 0) return meeting.turns;
  const latest = new Map<number, TurnCorrection>();
  for (const c of corrections) {
    const prior = latest.get(c.turn);
    if (!prior || c.at >= prior.at) latest.set(c.turn, c);
  }
  return meeting.turns.map((t, i) => {
    const c = latest.get(i);
    return c ? { ...t, text: c.text } : t;
  });
}

/** The meeting as a reader should see it: corrected turns, originals kept aside. */
export function withCorrections(meeting: MeetingTranscript): MeetingTranscript {
  return meeting.corrections?.length ? { ...meeting, turns: correctedTurns(meeting) } : meeting;
}

/** One saved meeting. */
export interface MeetingTranscript {
  id: string;
  boardId: string;
  orgId: string;
  startedAt: number;
  endedAt: number | null;
  turns: MeetingTurn[];
  createdBy: string | null;
  createdAt: number;
  /**
   * Capture profile in force when recorded (docs/24 Phase D). Absent on
   * rows written before profiles existed — unknown how captured, and never
   * backfilled (a guess about history would be a lie about it).
   */
  mode?: MeetingMode;
  /** The meeting's name (ADR 0045). Absent means untitled. */
  title?: string;
  /** The end-of-meeting summary (docs/28 A3.3). Absent until it is written. */
  recap?: MeetingRecap;
  /** People's corrections to turns (docs/28 S7): an overlay on `turns`. */
  corrections?: TurnCorrection[];
  /**
   * The plan, when the meeting was scheduled (docs/28 A3.4). Until it starts
   * the row has no turns and `startedAt` is the planned start; the recording
   * that starts it keeps this row — and so its id — and sets the real start.
   */
  schedule?: MeetingSchedule;
  /** When the host called it off, and who; a cancelled meeting is closed. */
  cancelledAt?: number;
  cancelledBy?: string;
}

/** A scheduled meeting's plan (docs/28 S2). */
export interface MeetingSchedule {
  scheduledFor: number;
  durationMin: number;
  /** User ids invited; the host is the meeting's `createdBy`. */
  invitees: string[];
  /** The notes template it follows (docs/27 §2.3); the summary uses it too. */
  template?: NoteTemplateId;
}

export const MIN_MEETING_MINUTES = 5;
export const MAX_MEETING_MINUTES = 8 * 60;
export const MAX_INVITEES = 100;
/** A meeting may be scheduled at most this far ahead. */
export const MAX_SCHEDULE_AHEAD_MS = 366 * 24 * 60 * 60 * 1000;

/**
 * A plan from the wire (S2): a time from now on (a minute of slack for the
 * clock in the browser), a sane length, and account ids. Whether the invitees
 * may read the board is the route's to check — it needs the stores.
 */
export function validateSchedule(
  input: Record<string, unknown>,
  now: number,
): { ok: true; schedule: MeetingSchedule } | { ok: false; error: string } {
  const at = input.scheduledFor;
  if (typeof at !== "number" || !Number.isFinite(at)) {
    return { ok: false, error: "Pick a date and time." };
  }
  if (at < now - 60_000) return { ok: false, error: "Pick a time in the future." };
  if (at > now + MAX_SCHEDULE_AHEAD_MS) {
    return { ok: false, error: "Pick a time within the next year." };
  }
  const minutes = input.durationMin;
  if (
    typeof minutes !== "number" ||
    !Number.isInteger(minutes) ||
    minutes < MIN_MEETING_MINUTES ||
    minutes > MAX_MEETING_MINUTES
  ) {
    return {
      ok: false,
      error: `A meeting runs ${MIN_MEETING_MINUTES} minutes to ${MAX_MEETING_MINUTES / 60} hours.`,
    };
  }
  const raw = input.invitees ?? [];
  if (!Array.isArray(raw) || raw.some((v) => typeof v !== "string" || !/^[\w-]{1,128}$/.test(v))) {
    return { ok: false, error: "invitees must be a list of account ids" };
  }
  const invitees = [...new Set(raw as string[])];
  if (invitees.length > MAX_INVITEES) {
    return { ok: false, error: `Invite at most ${MAX_INVITEES} people.` };
  }
  const template = input.template;
  if (template !== undefined && template !== null && !isNoteTemplateId(template)) {
    return { ok: false, error: "template must be one of the meeting templates" };
  }
  return {
    ok: true,
    schedule: {
      scheduledFor: Math.round(at),
      durationMin: minutes,
      invitees,
      ...(template ? { template } : {}),
    },
  };
}

/** Scheduled and not yet started: no turns, still open, not called off. */
export function notStarted(
  meeting: Pick<MeetingTranscript, "schedule" | "turns" | "endedAt" | "cancelledAt">,
): boolean {
  return (
    meeting.schedule !== undefined &&
    meeting.turns.length === 0 &&
    meeting.endedAt === null &&
    meeting.cancelledAt === undefined
  );
}

/**
 * The scheduled meeting a recording on this board should become (docs/28
 * §9.6): one not yet started whose window — from 15 minutes before its start
 * to 15 minutes after its planned end — contains `now`; the one starting
 * nearest to now when several do.
 */
export function scheduledMeetingAt(
  meetings: readonly MeetingTranscript[],
  now: number,
): MeetingTranscript | undefined {
  const margin = 15 * 60_000;
  return meetings
    .filter((m) => {
      if (!notStarted(m) || !m.schedule) return false;
      const start = m.schedule.scheduledFor;
      const end = start + m.schedule.durationMin * 60_000;
      return now >= start - margin && now <= end + margin;
    })
    .sort(
      (a, b) => Math.abs(a.schedule!.scheduledFor - now) - Math.abs(b.schedule!.scheduledFor - now),
    )[0];
}

/**
 * Why a summary was written without the model: the board's AI boundary or
 * the org's provider policy refused it, no model is configured, the monthly
 * allowance is spent, or the model call failed. The offline enhancer's note
 * is still honest — quoted turns, cited — and says which of these applied.
 */
export type RecapOffline = "policy" | "no-model" | "limit" | "model-failed";

/**
 * The end-of-meeting summary (docs/28 S8/S9): the notes enhancer's cited note
 * (docs/27 N1) over the whole transcript with no personal lines — every line
 * cites the turns it came from, uncited lines are dropped.
 */
export interface MeetingRecap extends EnhancedNote {
  offline?: RecapOffline;
}

/** What writing a summary did (docs/28 A3.3). */
export type RecapOutcome =
  | { outcome: "written"; meeting: MeetingTranscript }
  /** Record mode keeps the transcript only — no summary, by the profile. */
  | { outcome: "record-mode" }
  | { outcome: "not-found" | "not-ended" | "empty" | "unavailable" };

export interface NewMeetingTranscript {
  boardId: string;
  orgId: string;
  startedAt: number;
  endedAt?: number | null;
  turns: MeetingTurn[];
  createdBy: string;
  createdAt: number;
  mode?: MeetingMode;
  title?: string;
  /** A scheduled meeting (A3.4): no turns, `startedAt` the planned start. */
  schedule?: MeetingSchedule;
}

/** How long a meeting title may be. */
export const MAX_MEETING_TITLE = 120;

/**
 * A title from the wire: trimmed; empty or null clears it (back to
 * untitled); anything else must be a string of at most MAX_MEETING_TITLE.
 */
export function validateMeetingTitle(
  input: unknown,
): { ok: true; title: string | null } | { ok: false; error: string } {
  if (input === null) return { ok: true, title: null };
  if (typeof input !== "string") return { ok: false, error: "title must be a string or null" };
  const title = input.trim();
  if (title.length > MAX_MEETING_TITLE) {
    return { ok: false, error: `title exceeds ${MAX_MEETING_TITLE} characters` };
  }
  return { ok: true, title: title === "" ? null : title };
}

/**
 * Where a meeting is in its life (ADR 0045), derived from what is stored:
 * `scheduled` until its recording starts (A3.4), `cancelled` when the host
 * called it off, `live` while it records, then `ended` and — once the
 * end-of-meeting pass writes the summary (A3.3) — `summarized`. The review
 * center (A2) adds `reviewed`.
 */
export type MeetingStatus = "scheduled" | "cancelled" | "live" | "ended" | "summarized";

export function meetingStatus(
  meeting: Pick<MeetingTranscript, "endedAt" | "recap" | "schedule" | "turns" | "cancelledAt">,
): MeetingStatus {
  if (meeting.cancelledAt !== undefined) return "cancelled";
  if (notStarted(meeting)) return "scheduled";
  if (meeting.endedAt === null) return "live";
  return meeting.recap ? "summarized" : "ended";
}

/** One row of the workspace meetings list: everything but the turns. */
export interface MeetingSummary {
  id: string;
  boardId: string;
  boardName: string;
  title: string | null;
  status: MeetingStatus;
  startedAt: number;
  endedAt: number | null;
  turnCount: number;
  mode: MeetingMode | null;
  createdBy: string | null;
  /** The plan, for a scheduled meeting (A3.4). */
  scheduledFor: number | null;
  durationMin: number | null;
  inviteeCount: number;
}

export function summarizeMeeting(meeting: MeetingTranscript, boardName: string): MeetingSummary {
  return {
    id: meeting.id,
    boardId: meeting.boardId,
    boardName,
    title: meeting.title ?? null,
    status: meetingStatus(meeting),
    startedAt: meeting.startedAt,
    endedAt: meeting.endedAt,
    turnCount: meeting.turns.length,
    mode: meeting.mode ?? null,
    createdBy: meeting.createdBy,
    scheduledFor: meeting.schedule?.scheduledFor ?? null,
    durationMin: meeting.schedule?.durationMin ?? null,
    inviteeCount: meeting.schedule?.invitees.length ?? 0,
  };
}

/**
 * The capture profiles (docs/24 Phase D). Copied, not imported, from the
 * web's meeting-modes: the server validates the wire, it does not share the
 * client's UI vocabulary (same split as MeetingTurn/kind).
 */
export const MEETING_MODES = ["record", "intelligence", "assistant", "participant"] as const;

export type MeetingMode = (typeof MEETING_MODES)[number];

export function isMeetingMode(value: unknown): value is MeetingMode {
  return typeof value === "string" && (MEETING_MODES as readonly string[]).includes(value);
}

/**
 * Validate the optional mode on a save body. Absent is legal (pre-profile
 * clients and rows); present must name a profile — a typo must not create
 * a fifth mode no gate understands (the classification-typo rule, same one).
 */
export function validateMeetingMode(
  input: unknown,
): { ok: true; mode: MeetingMode | undefined } | { ok: false; error: string } {
  if (input === undefined) return { ok: true, mode: undefined };
  if (!isMeetingMode(input)) {
    return { ok: false, error: `mode must be one of: ${MEETING_MODES.join(", ")}` };
  }
  return { ok: true, mode: input };
}

export interface MeetingStore {
  /** Insert one transcript; ids are minted by the store (like every other id here). */
  insert(input: NewMeetingTranscript): Promise<MeetingTranscript>;
  /** A board's meetings, newest first, bounded. */
  forBoard(boardId: string, limit?: number): Promise<MeetingTranscript[]>;
  /**
   * The meetings of several boards together, newest first, bounded — the
   * workspace list (ADR 0045). The caller passes only boards it may read.
   */
  forBoards(boardIds: readonly string[], limit?: number): Promise<MeetingTranscript[]>;
  /** Name (or, with null, un-name) a meeting; scoped to its board like `get`. */
  setTitle(
    boardId: string,
    id: string,
    title: string | null,
  ): Promise<MeetingTranscript | undefined>;
  /** Store the end-of-meeting summary (docs/28 A3.3), replacing any earlier one. */
  setRecap(
    boardId: string,
    id: string,
    recap: MeetingRecap,
  ): Promise<MeetingTranscript | undefined>;
  /**
   * Record one correction (docs/28 S7) — appended, never replacing the turn
   * or an earlier correction, so the log of who changed what stays whole.
   * The route checks the turn index is inside the transcript.
   */
  addCorrection(
    boardId: string,
    id: string,
    correction: TurnCorrection,
  ): Promise<MeetingTranscript | undefined>;
  /** One transcript, scoped to its board so a leaked id is not a read. */
  get(boardId: string, id: string): Promise<MeetingTranscript | undefined>;
  /**
   * Delete one org's ENDED transcripts older than `endedBefore`, up to
   * `limit` rows, oldest first. The retention sweep's primitive (docs/24
   * Phase H): org-scoped, because each org carries its own lifetime, and
   * running captures (`endedAt` null) are never eligible at any setting.
   * Returns the deleted count.
   */
  deleteExpired(orgId: string, endedBefore: number, limit: number): Promise<number>;
  /**
   * Append turns to a running meeting (M2): a live capture checkpoints as it
   * goes instead of holding the whole transcript in a tab. The transcript
   * stays immutable as a RECORD once ended; appending only extends a capture
   * whose `endedAt` is still null (an ended meeting's minutes are a new
   * save, per the insert-only contract).
   */
  appendTo(
    boardId: string,
    id: string,
    turns: MeetingTurn[],
  ): Promise<MeetingTranscript | undefined>;
  /**
   * End a meeting (Stage C3): set `endedAt` on a still-open capture. A live
   * recording used to just abandon its id — the store then said "in
   * progress" forever, which was a lie the cross-meeting chronology would
   * have inherited. Idempotent by design (the transition-guard pattern): a
   * second end returns the row unchanged, so a retry or a double-click is a
   * read, never a second effect. `endedAt < startedAt` is refused by the
   * route; the store trusts its caller.
   */
  end(boardId: string, id: string, endedAt: number): Promise<MeetingTranscript | undefined>;
  /**
   * End captures abandoned mid-meeting (docs/28 F14): a tab that closed,
   * crashed or was left never sends its end, and the record would say "in
   * progress" forever. Every still-open transcript whose last activity is
   * before `idleBefore` — up to `limit` rows, longest-idle first — is ended
   * AT that last activity, so the record says when the talking stopped, not
   * when the sweep noticed. Returns how many it ended.
   */
  endIdle(idleBefore: number, limit: number): Promise<number>;
  /**
   * Change a scheduled meeting's plan (and title) before it starts (A3.4).
   * Undefined once it started or was cancelled — a meeting that happened
   * isn't rescheduled.
   */
  reschedule(
    boardId: string,
    id: string,
    schedule: MeetingSchedule,
    title: string | null,
  ): Promise<MeetingTranscript | undefined>;
  /**
   * Call a scheduled meeting off before it starts: it closes (`endedAt`) and
   * reads `cancelled`. Idempotent; undefined once it started.
   */
  cancel(
    boardId: string,
    id: string,
    by: string,
    at: number,
  ): Promise<MeetingTranscript | undefined>;
  /**
   * The recording that starts a scheduled meeting (A3.4): its first turns,
   * the real start, and the capture profile land on the scheduled row, whose
   * id the invites already carry. Exactly one recording can start it: the
   * store only moves a meeting that has not started, so a second caller gets
   * undefined and opens its own transcript.
   */
  start(
    boardId: string,
    id: string,
    input: { startedAt: number; turns: MeetingTurn[]; mode?: MeetingMode },
  ): Promise<MeetingTranscript | undefined>;
  /**
   * Scheduled meetings that invite this person, on any board, newest first
   * (A3.4): an invite can come from a board in another org, which the
   * workspace list (`forBoards`) never reaches. The route re-checks that the
   * person can still read each board.
   */
  invitedTo(userId: string, limit?: number): Promise<MeetingTranscript[]>;
}

/** When a capture was last heard from: its last turn, or its start if silent. */
export function lastActivity(meeting: Pick<MeetingTranscript, "startedAt" | "turns">): number {
  const last = meeting.turns[meeting.turns.length - 1];
  return Math.max(meeting.startedAt, last?.at ?? meeting.startedAt);
}

/** How many meetings `forBoard` returns when the caller does not say. */
export const MEETING_LIST_LIMIT = 50;

/** Per-transcript caps, enforced at the route before the store sees anything. */
export const MAX_TURNS_PER_TRANSCRIPT = 500;
export const MAX_TURN_TEXT_CHARS = 2000;
export const MAX_SPEAKER_CHARS = 200;

export function newMeetingId(): string {
  return "mtg_" + Date.now().toString(36) + randomBytes(3).toString("hex");
}

/**
 * Validate an incoming `turns` array. Returns the cleaned turns or the first
 * problem — the route turns the string into its 400 body. Structural checks
 * live here rather than zod so the store contract stays JSON-only and the
 * web's client module can mirror the same rules.
 */
export function validateTurns(
  input: unknown,
): { ok: true; turns: MeetingTurn[] } | { ok: false; error: string } {
  if (!Array.isArray(input)) return { ok: false, error: "turns must be an array" };
  if (input.length === 0) return { ok: false, error: "turns must not be empty" };
  if (input.length > MAX_TURNS_PER_TRANSCRIPT) {
    return { ok: false, error: `turns exceeds the ${MAX_TURNS_PER_TRANSCRIPT}-turn cap` };
  }
  const kinds = new Set(["problem", "hypothesis", "solution", "decision", "action", "requirement"]);
  const turns: MeetingTurn[] = [];
  for (const raw of input) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return { ok: false, error: "each turn must be an object" };
    }
    const t = raw as Record<string, unknown>;
    if (typeof t.speaker !== "string" || t.speaker.trim().length === 0) {
      return { ok: false, error: "turn.speaker must be a non-empty string" };
    }
    if (typeof t.text !== "string" || t.text.trim().length === 0) {
      return { ok: false, error: "turn.text must be a non-empty string" };
    }
    if (t.text.length > MAX_TURN_TEXT_CHARS) {
      return { ok: false, error: `turn.text exceeds ${MAX_TURN_TEXT_CHARS} characters` };
    }
    if (typeof t.at !== "number" || !Number.isFinite(t.at) || t.at < 0) {
      return { ok: false, error: "turn.at must be a non-negative epoch ms number" };
    }
    const turn: MeetingTurn = {
      speaker: t.speaker.trim().slice(0, MAX_SPEAKER_CHARS),
      at: t.at,
      text: t.text.trim(),
    };
    if (t.kind !== undefined && t.kind !== null) {
      if (typeof t.kind !== "string" || !kinds.has(t.kind)) {
        return { ok: false, error: "turn.kind must be one of the six classifications" };
      }
      turn.kind = t.kind as MeetingTurn["kind"];
    }
    if (t.speakerId !== undefined && t.speakerId !== null) {
      if (typeof t.speakerId !== "string" || !/^[\w-]{1,128}$/.test(t.speakerId)) {
        return { ok: false, error: "turn.speakerId must be an account id" };
      }
      turn.speakerId = t.speakerId;
    }
    turns.push(turn);
  }
  return { ok: true, turns };
}

/** A copy the caller can't reach back into the store through. */
function copyMeeting(row: MeetingTranscript): MeetingTranscript {
  return {
    ...row,
    turns: [...row.turns],
    ...(row.schedule
      ? { schedule: { ...row.schedule, invitees: [...row.schedule.invitees] } }
      : {}),
  };
}

export class InMemoryMeetingStore implements MeetingStore {
  private readonly rows = new Map<string, MeetingTranscript>();

  async insert(input: NewMeetingTranscript): Promise<MeetingTranscript> {
    const row: MeetingTranscript = {
      id: newMeetingId(),
      boardId: input.boardId,
      orgId: input.orgId,
      startedAt: input.startedAt,
      endedAt: input.endedAt ?? null,
      turns: input.turns.map((t) => ({ ...t })),
      createdBy: input.createdBy,
      createdAt: input.createdAt,
      ...(input.mode !== undefined ? { mode: input.mode } : {}),
      ...(input.title ? { title: input.title } : {}),
      ...(input.schedule
        ? { schedule: { ...input.schedule, invitees: [...input.schedule.invitees] } }
        : {}),
    };
    this.rows.set(row.id, row);
    return copyMeeting(row);
  }

  async reschedule(
    boardId: string,
    id: string,
    schedule: MeetingSchedule,
    title: string | null,
  ): Promise<MeetingTranscript | undefined> {
    const row = this.rows.get(id);
    if (!row || row.boardId !== boardId || !notStarted(row)) return undefined;
    row.schedule = { ...schedule, invitees: [...schedule.invitees] };
    row.startedAt = schedule.scheduledFor;
    if (title === null) delete row.title;
    else row.title = title;
    return copyMeeting(row);
  }

  async cancel(
    boardId: string,
    id: string,
    by: string,
    at: number,
  ): Promise<MeetingTranscript | undefined> {
    const row = this.rows.get(id);
    if (!row || row.boardId !== boardId) return undefined;
    if (row.cancelledAt !== undefined) return copyMeeting(row);
    if (!notStarted(row)) return undefined;
    row.cancelledAt = at;
    row.cancelledBy = by;
    row.endedAt = Math.max(at, row.startedAt);
    return copyMeeting(row);
  }

  async invitedTo(userId: string, limit = MEETING_LIST_LIMIT): Promise<MeetingTranscript[]> {
    return [...this.rows.values()]
      .filter((r) => r.schedule?.invitees.includes(userId))
      .sort((a, b) => b.startedAt - a.startedAt || (a.id < b.id ? -1 : 1))
      .slice(0, limit)
      .map(copyMeeting);
  }

  async start(
    boardId: string,
    id: string,
    input: { startedAt: number; turns: MeetingTurn[]; mode?: MeetingMode },
  ): Promise<MeetingTranscript | undefined> {
    const row = this.rows.get(id);
    if (!row || row.boardId !== boardId || !notStarted(row)) return undefined;
    row.startedAt = input.startedAt;
    row.turns = input.turns.map((t) => ({ ...t }));
    if (input.mode !== undefined) row.mode = input.mode;
    return copyMeeting(row);
  }

  async forBoard(boardId: string, limit = MEETING_LIST_LIMIT): Promise<MeetingTranscript[]> {
    return this.forBoards([boardId], limit);
  }

  async forBoards(
    boardIds: readonly string[],
    limit = MEETING_LIST_LIMIT,
  ): Promise<MeetingTranscript[]> {
    const wanted = new Set(boardIds);
    return [...this.rows.values()]
      .filter((r) => wanted.has(r.boardId))
      .sort((a, b) => b.startedAt - a.startedAt || (a.id < b.id ? -1 : 1))
      .slice(0, limit)
      .map((r) => ({ ...r, turns: [...r.turns] }));
  }

  async setTitle(
    boardId: string,
    id: string,
    title: string | null,
  ): Promise<MeetingTranscript | undefined> {
    const row = this.rows.get(id);
    if (!row || row.boardId !== boardId) return undefined;
    if (title === null) delete row.title;
    else row.title = title;
    return { ...row, turns: [...row.turns] };
  }

  async setRecap(
    boardId: string,
    id: string,
    recap: MeetingRecap,
  ): Promise<MeetingTranscript | undefined> {
    const row = this.rows.get(id);
    if (!row || row.boardId !== boardId) return undefined;
    row.recap = recap;
    return { ...row, turns: [...row.turns] };
  }

  async addCorrection(
    boardId: string,
    id: string,
    correction: TurnCorrection,
  ): Promise<MeetingTranscript | undefined> {
    const row = this.rows.get(id);
    if (!row || row.boardId !== boardId) return undefined;
    row.corrections = [...(row.corrections ?? []), { ...correction }];
    return { ...row, turns: [...row.turns], corrections: [...row.corrections] };
  }

  async get(boardId: string, id: string): Promise<MeetingTranscript | undefined> {
    const row = this.rows.get(id);
    if (!row || row.boardId !== boardId) return undefined;
    return { ...row, turns: [...row.turns] };
  }

  async appendTo(
    boardId: string,
    id: string,
    turns: MeetingTurn[],
  ): Promise<MeetingTranscript | undefined> {
    const row = this.rows.get(id);
    if (!row || row.boardId !== boardId) return undefined;
    if (row.endedAt !== null) return undefined; // ended minutes are immutable
    // A scheduled meeting starts through `start`, which also sets the real start.
    if (notStarted(row)) return undefined;
    if (row.turns.length + turns.length > MAX_TURNS_PER_TRANSCRIPT) return undefined;
    row.turns = [...row.turns, ...turns.map((t) => ({ ...t }))];
    return { ...row, turns: [...row.turns] };
  }

  async deleteExpired(orgId: string, endedBefore: number, limit: number): Promise<number> {
    const eligible = [...this.rows.values()]
      .filter((r) => r.orgId === orgId && r.endedAt !== null && r.endedAt < endedBefore)
      .sort((a, b) => (a.endedAt as number) - (b.endedAt as number))
      .slice(0, Math.max(0, limit));
    for (const row of eligible) this.rows.delete(row.id);
    return eligible.length;
  }

  async end(boardId: string, id: string, endedAt: number): Promise<MeetingTranscript | undefined> {
    const row = this.rows.get(id);
    if (!row || row.boardId !== boardId) return undefined;
    // Idempotent: an already-ended row returns unchanged (the same
    // transition-guard contract appendTo enforces from the other side).
    if (row.endedAt === null && endedAt >= row.startedAt) {
      row.endedAt = endedAt;
    }
    return { ...row, turns: [...row.turns] };
  }

  async endIdle(idleBefore: number, limit: number): Promise<number> {
    const idle = [...this.rows.values()]
      .filter((r) => r.endedAt === null && lastActivity(r) < idleBefore)
      .sort((a, b) => lastActivity(a) - lastActivity(b))
      .slice(0, Math.max(0, limit));
    for (const row of idle) row.endedAt = lastActivity(row);
    return idle.length;
  }
}
