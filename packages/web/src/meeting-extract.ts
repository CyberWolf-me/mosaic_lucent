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

/**
 * The differential prompt: only the NEW turns, plus an explicit statement of
 * what the board already holds, so the model adds rather than rebuilds.
 */
export function differentialPrompt(
  turns: ReadonlyArray<{ speaker?: string; text: string; kind?: string }>,
): string {
  const lines = turns.map((t) => {
    const tag = t.kind ? ` [${t.kind}]` : "";
    const who = t.speaker ? `${t.speaker}:` : "";
    return `${who}${tag} ${t.text}`.trim();
  });
  return [
    "New turns from the live meeting (the board already shows everything captured earlier — do NOT rebuild it):",
    "",
    ...lines,
    "",
    "Add ONLY what these new turns introduce that is not on the board yet: new concepts as nodes, new relationships as connections, new topics as a new group with a fitting diagram kind (mindmap, flowchart, journey, orgchart, decisiontree, process, or architecture). Connect new nodes to related existing ones. If a turn refines or corrects something already on the board, update that node's label or connections — do not duplicate it. Emit no DELETE operations and do not regenerate existing regions. Casual suggestions ('maybe we could…') are proposals, not requirements — label them as such rather than treating them as decided.",
  ].join("\n");
}
