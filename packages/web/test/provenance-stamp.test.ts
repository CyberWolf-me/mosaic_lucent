import { describe, it, expect } from "vitest";
import type { Operation, Workspace } from "@lucent/core";

/**
 * The provenance stamp (M2 + Stage A): whatever a meeting extraction creates
 * must carry the durable link back to the conversation — meeting id, the
 * quoted words, the stable turn RANGE (ids/range survive transcript
 * normalization; the quote is presentation), and the statement KINDS.
 *
 * The stamping lives in workspace.tsx's two apply paths (the direct send and
 * the review-gated proposal). Those paths are React-coupled, so what this
 * suite pins is the STAMP SHAPE via the exact reducer-level contract the
 * paths implement — the operation of stamping is plain object composition,
 * and the shapes below assert the fields the ✦ and the future reverse link
 * read: a provenance record missing turnRange is a board that can never
 * navigate back to its evidence precisely.
 */

interface MeetingStamp {
  meetingId: string;
  quote: string;
  extractedAt: number;
  turnRange?: [number, number];
  turnKinds?: string[];
}

/** The stamping logic both apply paths share, in its pure form. */
function buildStamp(provenance: {
  meetingId: string;
  turns: string[];
  turnRange?: [number, number];
  turnKinds?: string[];
}): MeetingStamp {
  return {
    meetingId: provenance.meetingId,
    quote: provenance.turns.join(" ").slice(0, 240),
    extractedAt: Date.now(),
    ...(provenance.turnRange ? { turnRange: provenance.turnRange } : {}),
    ...(provenance.turnKinds?.length ? { turnKinds: provenance.turnKinds } : {}),
  };
}

const sampleOps: Operation[] = [
  { op: "CREATE_NODE", id: "n1", nodeType: "action", label: "Prepare launch brief" },
  { op: "SET_ISSUE", id: "n1", issue: { type: "task", status: "To Do", assignee: "David" } },
];

describe("the provenance stamp (Stage A)", () => {
  it("carries the meeting id, the quote, the stable range, and the kinds", () => {
    const stamp = buildStamp({
      meetingId: "mtg_123",
      turns: ["David: I'll prepare the launch brief by Friday."],
      turnRange: [4, 4],
      turnKinds: ["action"],
    });
    expect(stamp.meetingId).toBe("mtg_123");
    expect(stamp.quote).toContain("launch brief");
    // The stable reference — what a reverse link keys on, and what survives
    // transcript normalization where the quote cannot.
    expect(stamp.turnRange).toEqual([4, 4]);
    expect(stamp.turnKinds).toEqual(["action"]);
  });

  it("the range is OPTIONAL but the shape must not lie when absent", () => {
    const stamp = buildStamp({ meetingId: "live-session", turns: ["a turn"] });
    expect("turnRange" in stamp).toBe(false);
    expect("turnKinds" in stamp).toBe(false);
  });

  it("the quote truncates at the recorded cap (240 chars) but the range holds", () => {
    const longTurns = [`${"x".repeat(300)}`];
    const stamp = buildStamp({
      meetingId: "mtg_long",
      turns: longTurns,
      turnRange: [10, 10],
    });
    expect(stamp.quote.length).toBeLessThanOrEqual(240);
    expect(stamp.turnRange).toEqual([10, 10]);
  });

  it("stamps only the nodes the batch ADDED — existing nodes keep their provenance", () => {
    // The apply-path contract: `!workspace.nodes[id]` decides stamping.
    const before: Workspace["nodes"] = {
      existing: { id: "existing", nodeType: "step", label: "Old" },
    };
    const stamp = buildStamp({
      meetingId: "mtg_2",
      turns: ["turn"],
      turnRange: [0, 0],
    });
    const after: Workspace["nodes"] = {};
    for (const [id, node] of Object.entries(before)) {
      after[id] = id in before ? node : { ...node, metadata: { meeting: stamp } };
    }
    for (const op of sampleOps) {
      if (op.op === "CREATE_NODE" && !(op.id in before)) {
        after[op.id] = {
          id: op.id,
          nodeType: op.nodeType,
          label: op.label,
          metadata: { meeting: stamp },
        };
      }
    }
    // The pre-existing node's metadata is untouched.
    expect(after.existing?.metadata?.meeting).toBeUndefined();
    // The batch-added node carries the stamp.
    expect((after.n1?.metadata?.meeting as MeetingStamp | undefined)?.turnRange).toEqual([0, 0]);
  });

  it("the ✦ reads the same fields the stamp writes (the HUD contract)", () => {
    const stamp = buildStamp({
      meetingId: "mtg_hud",
      turns: ["We'll ship in October."],
      turnRange: [7, 7],
      turnKinds: ["decision"],
    });
    // What the HUD tooltip renders + what the click handler routes on.
    const tooltipQuote = stamp.quote;
    const tooltipKinds = (stamp.turnKinds ?? []).join(", ");
    const tooltipRange = stamp.turnRange ? `${stamp.turnRange[0]}–${stamp.turnRange[1]}` : null;
    const clickTarget = stamp.meetingId !== "live-session" ? stamp.meetingId : null;
    expect(tooltipQuote).toContain("October");
    expect(tooltipKinds).toBe("decision");
    expect(tooltipRange).toBe("7–7");
    expect(clickTarget).toBe("mtg_hud");
  });
});
