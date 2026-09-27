import type { Operation } from "@lucent/core";

/**
 * The live-meeting differential loop (M2): pure policy for turning captured
 * speech into incremental board updates.
 *
 * Three pieces, all testable without DOM or network:
 *  1. The HYBRID TRIGGER — when a batch of new transcript turns is worth an
 *     extraction call. Not a fixed timer: extract when the speaker seems done
 *     (enough new content + a pause), OR when enough has accumulated, OR when
 *     too much time has passed — whichever fires first. Thresholds are
 *     configurable so they can be tuned against real meetings.
 *  2. The SAFE-OP GATE — an additive-only batch applies silently (a meeting
 *     where Lucent asks "apply this?" every minute is unusable); anything
 *     destructive or oversized goes through the existing review panel.
 *  3. The DIFFERENTIAL PROMPT — the model is told what the board already
 *     shows and asked to ADD what's missing, never to rebuild.
 */

/** Tunable trigger thresholds; defaults are the starting point, not law. */
export interface ExtractTriggerOptions {
  /** New finals needed (with a silence gap) for a "speaker finished" extract. */
  quietTurns?: number;
  /** Silence after the last final that counts as "finished", ms. */
  quietMs?: number;
  /** New finals that force an extract with no silence required. */
  burstTurns?: number;
  /** Max wall-clock between extracts, ms — the safety valve. */
  maxIntervalMs?: number;
  /** Minimum spacing between extract calls, ms — the debounce. */
  minSpacingMs?: number;
}

export const DEFAULT_TRIGGER: Required<ExtractTriggerOptions> = {
  quietTurns: 3,
  quietMs: 4_000,
  burstTurns: 8,
  maxIntervalMs: 90_000,
  minSpacingMs: 15_000,
};

/**
 * Should we extract now, given the capture state?
 * - `newSinceLastExtract` — finals recorded since the previous extract call.
 * - `msSinceLastFinal` — silence since the newest final (Infinity before any).
 * - `msSinceLastExtract` — time since the previous extract (Infinity if none).
 */
export function shouldExtract(
  newSinceLastExtract: number,
  msSinceLastFinal: number,
  msSinceLastExtract: number,
  options: ExtractTriggerOptions = {},
): boolean {
  const o = { ...DEFAULT_TRIGGER, ...options };
  if (newSinceLastExtract === 0) return false;
  if (msSinceLastExtract < o.minSpacingMs) return false; // debounce
  const quietEnough = newSinceLastExtract >= o.quietTurns && msSinceLastFinal >= o.quietMs;
  const burst = newSinceLastExtract >= o.burstTurns;
  const overdue = msSinceLastExtract >= o.maxIntervalMs && newSinceLastExtract > 0;
  return quietEnough || burst || overdue;
}

/**
 * Operations that apply silently in a live meeting. Additive by construction:
 * creating nodes, connecting them, grouping them, sticky notes, work items.
 * ADD_COMMENT is deliberately NOT here — speech-to-text misreads turning into
 * dozens of pinned comments is noise; if the model wants to annotate, the
 * review panel is the place for it.
 */
const MEETING_SAFE_OPS: ReadonlySet<string> = new Set([
  "CREATE_NODE",
  "CONNECT_NODES",
  "CREATE_GROUP",
  "CREATE_SHAPE",
  "SET_ISSUE",
  "SET_GROUP_KIND",
  // Stage C2: statements are meaning, additive by construction — attaching a
  // decision to a new node changes no existing work, and a rejection's
  // UPDATE_STATEMENT is the visible supersession this doctrine always wanted.
  "SET_STATEMENT",
  "UPDATE_STATEMENT",
]);

/** Ops that must never auto-apply in a meeting — always route to review. */
const RISKY_OPS: ReadonlySet<string> = new Set([
  "DELETE_NODE",
  "DELETE_GROUP",
  "DELETE_SHAPE",
  "DELETE_WIREFRAME",
  "TRANSFORM_DIAGRAM",
  "DISCONNECT_NODES",
  "DISCONNECT_SHAPES",
  "CLEAR_VOTES",
  "REMOVE_VOTE",
  "REMOVE_REACTION",
  "DELETE_COMMENT",
]);

export interface MeetingGateDecision {
  autoApply: boolean;
  /** Human-facing reason when the panel is required. */
  reason?: string;
}

/** Max auto-applied batch size — bigger batches deserve a human glance. */
export const MEETING_AUTO_APPLY_MAX_OPS = 12;

/**
 * Decide whether an extraction batch applies silently or gates behind the
 * review panel. Destructive ops always gate (and say why); an oversized batch
 * gates; a small additive batch flows.
 */
export function gateMeetingOps(ops: readonly Operation[]): MeetingGateDecision {
  for (const op of ops) {
    if (RISKY_OPS.has(op.op)) {
      return {
        autoApply: false,
        reason: `This batch includes ${op.op}, which changes or removes existing work.`,
      };
    }
  }
  if (ops.length > MEETING_AUTO_APPLY_MAX_OPS) {
    return { autoApply: false, reason: `A large batch (${ops.length} changes) deserves a review.` };
  }
  for (const op of ops) {
    if (!MEETING_SAFE_OPS.has(op.op)) {
      return {
        autoApply: false,
        reason: `This batch includes ${op.op}, which is not on the meeting auto-apply list.`,
      };
    }
  }
  return { autoApply: true };
}

/** What `send` needs for a meeting-sourced extraction (a `SendAttachments`). */
export interface MeetingExtractRequest {
  propose: true;
  provenance?: {
    meetingId: string;
    turns: string[];
    turnRange: [number, number];
    turnKinds: string[];
  };
}

/**
 * The request options for EVERY meeting-sourced extraction — the live loop,
 * "Extract to board" and "Re-extract from here" (docs/28 F15). Decision 5
 * (docs/26): Lucent captures and understands everything said in a meeting,
 * but nothing extracted becomes board state without a person, so the result
 * is always a proposal to review, whatever its size and however empty the
 * board. The two manual paths used to leave `propose` off and fell under the
 * approval threshold, which applied five operations or fewer directly — and
 * any number on an empty board.
 *
 * The provenance stamps what the extraction creates with the meeting, the
 * quoted words, their index range in the transcript and their kinds. It is
 * left off when nothing is quoted.
 */
export function meetingExtractRequest(input: {
  meetingId: string;
  quoted: ReadonlyArray<{ text: string }>;
  turnRange: [number, number];
  kinds: ReadonlyArray<string | undefined>;
}): MeetingExtractRequest {
  if (input.quoted.length === 0) return { propose: true };
  return {
    propose: true,
    provenance: {
      meetingId: input.meetingId,
      turns: input.quoted.map((t) => t.text),
      turnRange: input.turnRange,
      turnKinds: input.kinds.filter((k): k is string => Boolean(k)),
    },
  };
}

// The differential prompt lives in @lucent/ai (docs/26 A5): the server's
// end-of-meeting extraction asks the model exactly as this loop does.
export { differentialPrompt } from "@lucent/ai";
