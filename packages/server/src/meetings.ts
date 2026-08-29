import { randomBytes } from "node:crypto";

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
}

export interface NewMeetingTranscript {
  boardId: string;
  orgId: string;
  startedAt: number;
  endedAt?: number | null;
  turns: MeetingTurn[];
  createdBy: string;
  createdAt: number;
}

export interface MeetingStore {
  /** Insert one transcript; ids are minted by the store (like every other id here). */
  insert(input: NewMeetingTranscript): Promise<MeetingTranscript>;
  /** A board's meetings, newest first, bounded. */
  forBoard(boardId: string, limit?: number): Promise<MeetingTranscript[]>;
  /** One transcript, scoped to its board so a leaked id is not a read. */
  get(boardId: string, id: string): Promise<MeetingTranscript | undefined>;
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
export function validateTurns(input: unknown): { ok: true; turns: MeetingTurn[] } | { ok: false; error: string } {
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
    };
    this.rows.set(row.id, row);
    return { ...row, turns: [...row.turns] };
  }

  async forBoard(boardId: string, limit = MEETING_LIST_LIMIT): Promise<MeetingTranscript[]> {
    return [...this.rows.values()]
      .filter((r) => r.boardId === boardId)
      .sort((a, b) => b.startedAt - a.startedAt || (a.id < b.id ? -1 : 1))
      .slice(0, limit)
      .map((r) => ({ ...r, turns: [...r.turns] }));
  }

  async get(boardId: string, id: string): Promise<MeetingTranscript | undefined> {
    const row = this.rows.get(id);
    if (!row || row.boardId !== boardId) return undefined;
    return { ...row, turns: [...row.turns] };
  }
}
