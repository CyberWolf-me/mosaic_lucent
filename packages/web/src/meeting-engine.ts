import { shouldExtract, type ExtractTriggerOptions } from "./meeting-extract.js";

/**
 * The meeting engine (docs/25 V4) — orchestration, not storage.
 *
 * Sections, per the advisory's review:
 *
 * - Speech: turn-final bookkeeping (when speech landed, what is queued).
 * - Understanding: the hybrid trigger, batch slicing, and outcome
 *   application (what the loop already did, now behind one boundary).
 * - Context: prompt/provenance assembly stays in `meeting-extract.ts` and
 *   the view — the engine decides WHEN, the pipeline decides WHAT.
 * - Voice: reserved for the M6 loop. `undefined` until then, by type.
 *
 * The engine holds clock state (last final, last extract, in-flight) and
 * answers one question per tick — may a generation fire now? — plus the
 * pure batch/outcome arithmetic the view used to inline. It stores no
 * turns, no transcripts, no board state: those stay in React state, the
 * server transcript, and the op log respectively (docs/25 §6 — never a
 * competing store). Behavior is byte-identical to the inlined loop it
 * replaces; the meeting suites pin that, not this file's comments.
 */

export type ExtractTerminalOutcome =
  | "applied"
  | "proposed"
  | "answered"
  | "rejected"
  | "busy"
  | "refused"
  | "failed"
  | "cancelled";

export interface MeetingEngineOptions {
  trigger?: ExtractTriggerOptions;
  now?: () => number;
}

export interface EngineBatch<T> {
  batch: T[];
  batchStart: number;
}

/**
 * Slice the queued tail off the captured turns. `queued` counts finals
 * recorded since the previous extract; the batch is the last `queued`
 * turns, and `batchStart` is the stable transcript index the provenance
 * range keys on.
 */
export function sliceBatch<T>(turns: readonly T[], queued: number): EngineBatch<T> {
  const start = Math.max(0, turns.length - Math.max(0, queued));
  return { batch: turns.slice(start), batchStart: start };
}

/**
 * Apply a terminal outcome to the queue count AFTER the batch was dequeued
 * (the view subtracts first, then calls this). Only `busy` and `failed`
 * re-queue — their turns never reached the board, so dropping them would
 * lose speech behind a success message. Every other outcome leaves the
 * dequeue standing, including `cancelled` (asked-for, not lost) and
 * `rejected`/`refused` (the turns stay in the transcript, just not queued).
 */
export function applyExtractOutcome(
  queuedAfterDequeue: number,
  batchLength: number,
  outcome: ExtractTerminalOutcome,
): number {
  if (outcome === "busy" || outcome === "failed") return queuedAfterDequeue + batchLength;
  return queuedAfterDequeue;
}

/** The heartbeat line per outcome — the exact strings the view rendered inline. */
export function extractStatusMessage(
  outcome: ExtractTerminalOutcome,
  turns: number,
  detail?: { ops?: number; error?: string },
): string {
  const unit = turns === 1 ? "1 turn" : `${turns} turns`;
  const unitNew = turns === 1 ? "1 new turn" : `${turns} new turns`;
  switch (outcome) {
    case "applied":
      return `Applied ${unitNew} to the board`;
    case "proposed":
      return `Extracted ${unit} — review the ${detail?.ops ?? 0} proposed changes on the canvas`;
    case "answered":
      return `Extracted ${unit} — no board changes were needed`;
    case "rejected":
      return `Extraction refused — ${turns} turn${turns === 1 ? "" : "s"} left in the transcript, nothing was changed`;
    case "busy":
      return `Extraction waiting — another request is running`;
    case "refused":
      return `Extraction refused — this board is read-only for you`;
    case "failed":
      return `Extraction failed: ${detail?.error ?? "unknown"} — will retry`;
    case "cancelled":
      return `Extraction cancelled — nothing was applied`;
  }
}

export interface MeetingEngine {
  /** Record a captured final's timestamp. */
  noteFinal(at: number): void;
  /** May a generation fire now for this queue depth? Never re-entrant. */
  shouldFire(queuedCount: number): boolean;
  /** Mark a firing (sets the extract clock, raises in-flight). */
  markFired(): void;
  /** Lower in-flight when the call settles. */
  markDone(): void;
  /** Fresh capture: clear all three clocks. */
  reset(): void;
  /** Read-only view for heartbeat/debug surfaces. */
  readonly state: { lastFinalAt: number | null; lastExtractAt: number | null; inFlight: boolean };
}

export function createMeetingEngine(options: MeetingEngineOptions = {}): MeetingEngine {
  const now = options.now ?? Date.now;
  const trigger = options.trigger;
  let lastFinalAt: number | null = null;
  let lastExtractAt: number | null = null;
  let inFlight = false;
  return {
    noteFinal(at: number): void {
      lastFinalAt = at;
    },
    shouldFire(queuedCount: number): boolean {
      if (inFlight) return false;
      const at = now();
      const msSinceLastFinal = lastFinalAt === null ? Infinity : at - lastFinalAt;
      const msSinceLastExtract = lastExtractAt === null ? Infinity : at - lastExtractAt;
      return shouldExtract(queuedCount, msSinceLastFinal, msSinceLastExtract, trigger);
    },
    markFired(): void {
      lastExtractAt = now();
      inFlight = true;
    },
    markDone(): void {
      inFlight = false;
    },
    reset(): void {
      lastFinalAt = null;
      lastExtractAt = null;
      inFlight = false;
    },
    get state() {
      return { lastFinalAt, lastExtractAt, inFlight };
    },
  };
}
