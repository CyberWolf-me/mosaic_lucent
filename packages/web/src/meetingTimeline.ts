import type { Workspace } from "@lucent/core";

/**
 * Reverse provenance (Stage C3): from a transcript turn to the board objects
 * it produced. The forward link shipped with C2 — nodes carry
 * `provenance { meetingId, turnRange }`, attached to the ops by
 * `attachProvenance` so it converges to every holder (ADR 0022) — and this
 * module reads it backwards, the way the Stage C document drew it:
 *
 *   Transcript turn → "Used to create 2 objects" → View on board.
 *
 * Pure, node-tested (the historyTimeline.ts convention): the view that
 * renders it (MeetingView) only lays out what these helpers decide, and the
 * data is entirely client-side — the workspace the browser already holds,
 * because C2 put provenance IN the state rather than in one browser's memory.
 */

/** The id a live capture uses when no server transcript was opened. */
const LIVE_SESSION = "live-session";

/** True when a provenance record points at the given meeting's real id. */
function pointsAt(
  provenance: { meetingId?: string } | undefined,
  meetingId: string,
): boolean {
  // A live-session stamp has no saved transcript to jump to — the same rule
  // the canvas ✦ button applies. Those turns list nothing, honestly.
  // Stage D2: provenance may carry only createdFrom (plan evidence, no
  // meeting) — `?.meetingId === meetingId` is false for it, which is the
  // right answer: a plan item belongs to no transcript turn.
  return provenance?.meetingId === meetingId && meetingId !== LIVE_SESSION;
}

/** The turn range that covers `index`, when this provenance has one. */
function coversTurn(
  provenance: { turnRange?: [number, number] } | undefined,
  index: number,
): boolean {
  // No range: the record belongs to the meeting but to no single turn. A
  // per-turn affordance ("this turn produced N objects") must not claim it
  // for every turn — the same rule objectsByTurn applies. The object stays
  // reachable from the meeting view as a whole, which is the honest bound.
  if (!provenance?.turnRange) return false;
  const [start, end] = provenance.turnRange;
  return index >= start && index <= end;
}

/** Every provenance record a node carries: its creation AND its statement's. */
function nodeProvenances(node: {
  provenance?: { meetingId?: string; turnRange?: [number, number] };
  statement?: { provenance?: { meetingId?: string; turnRange?: [number, number] } };
}): Array<{ meetingId?: string; turnRange?: [number, number] }> {
  const records: Array<{ meetingId?: string; turnRange?: [number, number] }> = [];
  if (node.provenance) records.push(node.provenance);
  if (node.statement?.provenance) records.push(node.statement.provenance);
  return records;
}

/**
 * The ids of board objects produced by a specific turn of a specific meeting.
 * A node matches when ANY of its provenance records points at the meeting
 * and covers the index.
 */
export function turnObjects(workspace: Workspace, meetingId: string, turnIndex: number): string[] {
  const out: string[] = [];
  for (const node of Object.values(workspace.nodes)) {
    for (const record of nodeProvenances(node)) {
      if (pointsAt(record, meetingId) && coversTurn(record, turnIndex)) {
        out.push(node.id);
        break; // a node is listed once, whichever record matched
      }
    }
  }
  return out;
}

/**
 * The whole-meeting map: turn index → the objects that turn produced. Built
 * in one pass so a transcript view renders every turn's affordance from one
 * scan of the workspace. Turn counts come from the transcript the caller
 * holds; indices with no objects are absent from the map (falsy reads).
 */
export function objectsByTurn(
  workspace: Workspace,
  meetingId: string,
  turnCount: number,
): Map<number, string[]> {
  const byTurn = new Map<number, string[]>();
  for (const node of Object.values(workspace.nodes)) {
    for (const record of nodeProvenances(node)) {
      if (!pointsAt(record, meetingId)) continue;
      if (record.turnRange) {
        for (let i = Math.max(0, record.turnRange[0]); i <= record.turnRange[1] && i < turnCount; i++) {
          const bucket = byTurn.get(i) ?? [];
          if (!bucket.includes(node.id)) bucket.push(node.id);
          byTurn.set(i, bucket);
        }
      } else {
        // No range: the objects belong to the meeting but not to any
        // specific turn — they surface on no turn row rather than every one.
        continue;
      }
    }
  }
  return byTurn;
}

/**
 * Provisional live-session provenance (UX-5): the same equality as pointsAt
 * but WITHOUT the live-session exclusion, so the live meeting view can chip
 * the objects the running capture just stamped. Saved views keep using
 * pointsAt/objectsByTurn, which honestly list nothing for "live-session".
 */
export function pointsAtLive(
  provenance: { meetingId?: string } | undefined,
  meetingId: string,
): boolean {
  return provenance?.meetingId === meetingId;
}

/** True when a meeting id is the provisional live-capture stamp. */
export function isLiveProvenance(meetingId: string): boolean {
  return meetingId === LIVE_SESSION;
}
