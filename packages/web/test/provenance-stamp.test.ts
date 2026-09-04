import { describe, it, expect } from "vitest";
import {
  applyOperations,
  attachProvenance,
  createWorkspace,
  validateOperations,
  inverseOperations,
  type Operation,
} from "@lucent/core";

/**
 * Provenance on the originating operations (Stage C2, ADR 0022): the meeting
 * loop enriches the ops before anything is applied, so the evidence lands in
 * the undo history, on peers via the room, in the server's board, and in the
 * op log — everywhere the ops go. This suite pins the enrichment contract the
 * two apply paths (send, local proposal) and the server's approve path share.
 *
 * The shape these tests assert is the OLD stamp minus `extractedAt` (the op
 * log's `at` already records when; a second timestamp was a second source of
 * truth) — plus the guarantee the old post-pass could never give: the stamp
 * IS the op, so a round-trip through history and peers carries it.
 */

const evidence = {
  meetingId: "mtg_123",
  quote: "David: I'll prepare the launch brief by Friday.",
  turnRange: [4, 4] as [number, number],
  turnKinds: ["action"],
};

const batch: Operation[] = [
  { op: "CREATE_NODE", id: "n1", nodeType: "action", label: "Prepare launch brief" },
  { op: "SET_ISSUE", id: "n1", issue: { type: "task", status: "To Do", assignee: "David" } },
  {
    op: "SET_STATEMENT",
    id: "n1",
    statement: { kind: "action", status: "open", topic: "launch" },
  },
  { op: "CHANGE_TEXT", id: "existing", text: "Updated wording" },
];

describe("attachProvenance — the enrichment the apply paths call", () => {
  it("enriches CREATE_NODE and SET_STATEMENT, leaves other ops untouched", () => {
    const enriched = attachProvenance(batch, evidence);
    expect(enriched[0]).toMatchObject({
      op: "CREATE_NODE",
      id: "n1",
      provenance: evidence,
    });
    expect(enriched[2]).toMatchObject({
      op: "SET_STATEMENT",
      id: "n1",
      statement: { kind: "action", status: "open", topic: "launch", provenance: evidence },
    });
    // SET_ISSUE and CHANGE_TEXT carry no provenance: evidence belongs to the
    // creation/statement, not to footnotes on every edit.
    expect(enriched[1]).not.toHaveProperty("provenance");
    expect(enriched[3]).not.toHaveProperty("provenance");
  });

  it("is idempotent per op — a second extraction never overwrites an origin", () => {
    const once = attachProvenance(batch, evidence);
    const twice = attachProvenance(once, { ...evidence, meetingId: "mtg_later" });
    expect(twice[0]).toMatchObject({ provenance: { meetingId: "mtg_123" } });
    expect(twice[2]).toMatchObject({ statement: { provenance: { meetingId: "mtg_123" } } });
  });

  it("skips a statement-clearing op", () => {
    const enriched = attachProvenance(
      [{ op: "SET_STATEMENT", id: "n1", statement: null }],
      evidence,
    );
    expect(enriched[0]).toEqual({ op: "SET_STATEMENT", id: "n1", statement: null });
  });

  it("the enriched batch still validates and applies — the stamp is not a special case", () => {
    const seeded = applyOperations(createWorkspace(), [
      { op: "CREATE_NODE", id: "existing", nodeType: "step", label: "Old" },
    ]);
    const enriched = attachProvenance(batch, evidence);
    expect(validateOperations(seeded, enriched)).toEqual([]);
    const ws = applyOperations(seeded, enriched);
    // The node carries its provenance as model state now, not metadata.
    expect(ws.nodes.n1?.provenance).toEqual(evidence);
    expect(ws.nodes.existing?.provenance).toBeUndefined();
  });

  it("THE CONVERGENCE CONTRACT: undo and peer replay carry the stamp", () => {
    const seeded = applyOperations(createWorkspace(), [
      { op: "CREATE_NODE", id: "existing", nodeType: "step", label: "Old" },
    ]);
    const enriched = attachProvenance(batch, evidence);
    const after = applyOperations(seeded, enriched);

    // Undo: the inverse replay restores the node WITHOUT provenance (the
    // batch is undone), and re-undo carries it back — both directions exact,
    // because the stamp is in the ops the history replays.
    const undone = applyOperations(after, inverseOperations(enriched, seeded));
    expect(undone.nodes.n1).toBeUndefined();
    // Peer replay: a fresh browser applies the same ops from the log and sees
    // the same provenance — the divergence the old post-pass created is
    // structurally impossible now.
    const replayed = applyOperations(seeded, enriched);
    expect(replayed.nodes.n1?.provenance).toEqual(after.nodes.n1?.provenance);
  });

  it("the ✦ reads the same fields the enrichment writes (the HUD contract)", () => {
    const enriched = attachProvenance(batch, evidence);
    const provenance = (enriched[0] as { provenance?: typeof evidence }).provenance!;
    // What the HUD tooltip renders + what the click handler routes on.
    expect(provenance.quote).toContain("launch brief");
    expect((provenance.turnKinds ?? []).join(", ")).toBe("action");
    expect(provenance.turnRange ? `${provenance.turnRange[0]}–${provenance.turnRange[1]}` : null).toBe("4–4");
    expect(provenance.meetingId !== "live-session" ? provenance.meetingId : null).toBe("mtg_123");
  });
});
