import { randomBytes } from "node:crypto";
import type { EnhancedNote } from "@lucent/ai";

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
 * Where a meeting is in its life (ADR 0045): derived from `endedAt` until a
 * feature needs a stored lifecycle — scheduling adds `scheduled`, the
 * end-of-meeting pass `summarized`, the review center `reviewed`.
 */
export type MeetingStatus = "live" | "ended" | "summarized";

export function meetingStatus(
  meeting: Pick<MeetingTranscript, "endedAt" | "recap">,
): MeetingStatus {
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
    };
    this.rows.set(row.id, row);
    return { ...row, turns: [...row.turns] };
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
