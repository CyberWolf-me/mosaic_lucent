import { describe, it, expect } from "vitest";
import { applyOperations, createWorkspace } from "@lucent/core";
import { objectsByTurn, turnObjects } from "../src/meetingTimeline.js";

/**
 * Reverse provenance (Stage C3): transcript turn → the board objects that
 * turn produced. The forward link is C2's op-level provenance (ADR 0022);
 * these helpers read it backwards, purely, from the workspace the browser
 * already holds. What's under test:
 *
 * - RANGE MATCHING: a node created by turns 4–6 belongs to turns 4, 5, 6 —
 *   and to no other turn.
 * - BOTH RECORDS COUNT: creation provenance (node.provenance) AND statement
 *   provenance (node.statement.provenance) — a decision node and its
 *   statement came from the same words.
 * - HONEST ABSENCES: "live-session" ids match nothing (no stored
 *   transcript); provenance with no range surfaces on no single turn
 *   (it belongs to the meeting, not to one moment of it).
 * - ONE PASS: objectsByTurn builds the whole meeting's map in a scan, a
 *   node listed once per turn even when both records cover it.
 */

const ws = applyOperations(createWorkspace(), [
  {
    op: "CREATE_NODE",
    id: "created",
    nodeType: "decision",
    label: "Decision node",
    provenance: { meetingId: "mtg_1", turnRange: [4, 6], quote: "we decided" },
  },
  {
    op: "SET_STATEMENT",
    id: "created",
    statement: {
      kind: "decision",
      status: "resolved",
      topic: "pricing",
      provenance: { meetingId: "mtg_1", turnRange: [4, 6] },
    },
  },
  { op: "CREATE_NODE", id: "statement-only", nodeType: "decision", label: "Statement-only" },
  {
    op: "SET_STATEMENT",
    id: "statement-only",
    statement: {
      kind: "action",
      status: "open",
      provenance: { meetingId: "mtg_1", turnRange: [10, 10] },
    },
  },
  // A different meeting's node: must never appear.
  {
    op: "CREATE_NODE",
    id: "other-meeting",
    nodeType: "step",
    label: "Other",
    provenance: { meetingId: "mtg_2", turnRange: [4, 6] },
  },
  // Live-session capture: no stored transcript to reverse into.
  {
    op: "CREATE_NODE",
    id: "live",
    nodeType: "step",
    label: "Live",
    provenance: { meetingId: "live-session", turnRange: [0, 2] },
  },
  // Provenance with no range: belongs to the meeting, not one turn.
  {
    op: "CREATE_NODE",
    id: "whole-meeting",
    nodeType: "step",
    label: "Whole",
    provenance: { meetingId: "mtg_1" },
  },
]);

describe("turnObjects", () => {
  it("lists the objects a turn produced, from either provenance record", () => {
    expect(turnObjects(ws, "mtg_1", 4)).toEqual(["created"]);
    expect(turnObjects(ws, "mtg_1", 10)).toEqual(["statement-only"]);
    // Turn 5 sits inside the same 4–6 range: same node.
    expect(turnObjects(ws, "mtg_1", 5)).toEqual(["created"]);
  });

  it("a turn outside every range lists nothing", () => {
    expect(turnObjects(ws, "mtg_1", 3)).toEqual([]);
    expect(turnObjects(ws, "mtg_1", 99)).toEqual([]);
  });

  it("never crosses meetings, never matches live-session, never invents ranges", () => {
    // mtg_2's node does not appear under mtg_1 turns.
    expect(turnObjects(ws, "mtg_1", 4)).not.toContain("other-meeting");
    // The whole-meeting node has no range: no single turn claims it.
    expect(turnObjects(ws, "mtg_1", 4)).not.toContain("whole-meeting");
    // live-session is not a real meeting id — nothing matches it.
    expect(turnObjects(ws, "live-session", 0)).toEqual([]);
  });
});

describe("objectsByTurn", () => {
  it("builds the whole meeting's map in one pass, a node once per turn", () => {
    const map = objectsByTurn(ws, "mtg_1", 12);
    expect(map.get(4)).toEqual(["created"]);
    expect(map.get(5)).toEqual(["created"]);
    expect(map.get(6)).toEqual(["created"]);
    expect(map.get(10)).toEqual(["statement-only"]);
    expect(map.has(3)).toBe(false);
    expect(map.has(11)).toBe(false);
  });

  it("clamps ranges to the transcript's real length", () => {
    // A 3-turn transcript: turn 4 of a 4–6 range is outside the record.
    const map = objectsByTurn(ws, "mtg_1", 3);
    expect(map.size).toBe(0);
  });

  it("an empty meeting maps to nothing", () => {
    expect(objectsByTurn(createWorkspace(), "mtg_none", 5).size).toBe(0);
  });
});
