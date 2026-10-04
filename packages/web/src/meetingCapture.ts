import type { MeetingTranscript, MeetingTurn } from "./meetings.js";

/**
 * Capture durability (P1-MT-001, docs/28 F13): every final a live capture
 * produces reaches the server transcript as it lands, so a reload or a closed
 * tab mid-meeting loses nothing.
 *
 * The server transcript is opened LAZILY, with the capture's first turns —
 * the same contract the meeting routes test (`POST …/meetings` with the first
 * turn, then `…/turns` appends). The view used to open it with `turns: []` at
 * Start, which the server refuses ("turns must not be empty"), so no live
 * transcript ever existed and everything waited for Stop. Opening on the
 * first turn also means a capture where nobody spoke leaves no empty record.
 *
 * Everything here is per capture and reads no React state: the view builds
 * one at Start and hands it the live turn list. The last version read the
 * meeting id from the render that armed the STT callbacks, which was always
 * null, so every checkpoint skipped.
 */

/** The server calls a capture needs; `web/src/meetings.ts` provides them. */
export interface CaptureStore {
  open(
    boardId: string,
    input: { turns: MeetingTurn[]; startedAt: number; mode?: string },
  ): Promise<MeetingTranscript | null>;
  append(
    boardId: string,
    meetingId: string,
    turns: MeetingTurn[],
  ): Promise<MeetingTranscript | null>;
  end(boardId: string, meetingId: string): Promise<MeetingTranscript | null>;
}

export interface CaptureDurabilityOptions {
  startedAt: number;
  mode?: string;
  /**
   * The server board, read at the first persist and then fixed for the
   * capture's life: a board shared mid-capture still gets the meeting, and
   * switching boards never moves it. Null means a local board — falls back
   * to scopeFallback.
   */
  board: () => string | null;
  /** Fallback scope identifier (e.g. projectId) when not attached to a server board. */
  scopeFallback?: () => string | null;
  store: CaptureStore;
  /** Called once, when the server or local transcript opens. */
  onOpened?: (stored: MeetingTranscript) => void;
}

export interface CaptureDurability {
  /**
   * Send every turn in `turns` the server does not hold yet. Calls are
   * serialized (a second call behind an in-flight one would re-send the same
   * span, or open a second transcript), and a failure leaves the gap for the
   * next call to close. Never rejects.
   */
  persist(turns: readonly MeetingTurn[]): Promise<void>;
  /**
   * Flush `turns`, then end the transcript. Resolves to the ended record, or
   * null when there is nothing to end (no turns, no scope) or a turn is still
   * unsaved — the transcript is then left open, so a retry appends to it
   * instead of writing the meeting twice.
   */
  finish(turns: readonly MeetingTurn[]): Promise<MeetingTranscript | null>;
  readonly boardId: string | null;
  /** The server transcript's id, once the first turns landed. */
  readonly meetingId: string | null;
  /** How many local turns the server definitely holds. */
  readonly persisted: number;
}

export function createCaptureDurability(options: CaptureDurabilityOptions): CaptureDurability {
  const { store } = options;
  let boardId: string | null = null;
  let meetingId: string | null = null;
  let persisted = 0;
  let chain: Promise<void> = Promise.resolve();
  // The newest list handed in. A step reads it when it RUNS, so finals that
  // land while a request is in flight go out together in the next one.
  let latest: readonly MeetingTurn[] = [];

  const effectiveScope = (): string | null => {
    boardId ??= options.board();
    return boardId || (options.scopeFallback ? options.scopeFallback() : null);
  };

  const step = async (): Promise<void> => {
    const turns = latest;
    if (persisted >= turns.length) return;
    const scope = effectiveScope();
    if (!scope) return;
    const from = persisted;
    const batch = turns.slice(from);
    const stored =
      meetingId === null
        ? await store.open(boardId ?? scope, {
            turns: batch,
            startedAt: options.startedAt,
            ...(options.mode ? { mode: options.mode } : {}),
          })
        : await store.append(boardId ?? scope, meetingId, batch);
    if (!stored) return;
    if (meetingId === null) {
      meetingId = stored.id;
      options.onOpened?.(stored);
    }
    // The server/store holds the full list; trust its length over our slice
    // arithmetic so a normalization on the server still converges.
    persisted = Math.max(from + batch.length, stored.turns.length);
  };

  const persist = (turns: readonly MeetingTurn[]): Promise<void> => {
    latest = turns;
    chain = chain.then(step).catch(() => {});
    return chain;
  };

  return {
    persist,
    async finish(turns) {
      await persist(turns);
      if (turns.length === 0 || persisted < turns.length) return null;
      const scope = effectiveScope();
      if (scope === null || meetingId === null) return null;
      return store.end(boardId ?? scope, meetingId).catch(() => null);
    },
    get boardId() {
      return boardId;
    },
    get meetingId() {
      return meetingId;
    },
    get persisted() {
      return persisted;
    },
  };
}
