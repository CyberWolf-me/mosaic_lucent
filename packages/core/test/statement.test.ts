import { describe, it, expect } from "vitest";
import {
  applyOperations,
  createWorkspace,
  validateOperations,
  inverseOperations,
  statementNodes,
  attachProvenance,
  safeParseOperations,
  type Operation,
  type Workspace,
} from "../src/index.js";

/**
 * Statement semantics (Stage C2): the semantic lifecycle on nodes, as the
 * mirror of issue.test.ts — the work-tracking precedent this feature follows
 * file by file. What is under test, in order of load-bearing-ness:
 *
 * 1. THE CONTRACT — SET_STATEMENT attaches/replaces/clears; UPDATE_STATEMENT
 *    patches; null-clears strip the key (the canonical-absence rule).
 * 2. VISIBLE SUPERSESSION — a statement's targets flip to "superseded"; the
 *    inverse restores their priors (undo a rejection without burying the
 *    rejected proposal).
 * 3. VALIDATION — targets exist, carry statements, no self-reference, no
 *    cycles (A supersedes B, B supersedes C, C supersedes A is refused), with
 *    in-batch simulation (a statement created earlier in the same batch is a
 *    valid target).
 * 4. THE IDENTITY RULE — a relabel leaves the statement and provenance
 *    untouched: meaning survives visual changes.
 * 5. PROVENANCE — CREATE_NODE stores it once; attachProvenance enriches
 *    create/statement ops and is idempotent per op.
 */

function board(): Workspace {
  return applyOperations(createWorkspace({ diagramKind: "flowchart" }), [
    { op: "CREATE_NODE", id: "sep", nodeType: "decision", label: "Launch in September" },
    { op: "CREATE_NODE", id: "oct", nodeType: "decision", label: "Launch October 15" },
    { op: "CREATE_NODE", id: "plain", nodeType: "step", label: "A plain step" },
    { op: "SET_STATEMENT", id: "sep", statement: { kind: "decision", status: "resolved" } },
  ]);
}

describe("SET_STATEMENT", () => {
  it("attaches a statement to a node", () => {
    const ws = applyOperations(board(), [
      {
        op: "SET_STATEMENT",
        id: "oct",
        statement: { kind: "decision", status: "resolved", topic: "launch-date" },
      },
    ]);
    expect(ws.nodes.oct!.statement).toEqual({
      kind: "decision",
      status: "resolved",
      topic: "launch-date",
    });
    expect(statementNodes(ws).map((n) => n.id)).toEqual(["sep", "oct"]);
  });

  it("replaces wholesale and clears with statement:null", () => {
    let ws = applyOperations(board(), [
      {
        op: "SET_STATEMENT",
        id: "oct",
        statement: { kind: "proposal", status: "open", topic: "launch-date" },
      },
    ]);
    expect(ws.nodes.oct!.statement!.kind).toBe("proposal");
    ws = applyOperations(ws, [{ op: "SET_STATEMENT", id: "oct", statement: null }]);
    expect(ws.nodes.oct!.statement).toBeUndefined();
  });

  it("marks superseded targets visibly, preserving their other fields", () => {
    const ws = applyOperations(board(), [
      {
        op: "SET_STATEMENT",
        id: "oct",
        statement: {
          kind: "decision",
          status: "resolved",
          topic: "launch-date",
          supersedes: ["sep"],
        },
      },
    ]);
    expect(ws.nodes.sep!.statement).toMatchObject({
      kind: "decision",
      status: "superseded",
    });
    // The replaced statement keeps its identity fields — what was replaced
    // stays readable, only the lifecycle moved.
    expect(ws.nodes.sep!.label).toBe("Launch in September");
  });
});

describe("UPDATE_STATEMENT", () => {
  it("patches status and topic without resending the statement", () => {
    const ws = applyOperations(board(), [
      {
        op: "SET_STATEMENT",
        id: "oct",
        statement: { kind: "proposal", status: "open", topic: "launch-date" },
      },
      { op: "UPDATE_STATEMENT", id: "oct", status: "rejected" },
    ]);
    expect(ws.nodes.oct!.statement).toMatchObject({
      kind: "proposal",
      status: "rejected",
      topic: "launch-date",
    });
  });

  it("clears topic with null, replaces supersedes wholesale", () => {
    let ws = applyOperations(board(), [
      {
        op: "SET_STATEMENT",
        id: "oct",
        statement: { kind: "proposal", status: "open", topic: "launch-date", supersedes: ["sep"] },
      },
    ]);
    expect(ws.nodes.sep!.statement!.status).toBe("superseded");
    ws = applyOperations(ws, [
      { op: "UPDATE_STATEMENT", id: "oct", topic: null, supersedes: [] },
    ]);
    expect(ws.nodes.oct!.statement!.topic).toBeUndefined();
    expect(ws.nodes.oct!.statement!.supersedes).toEqual([]);
  });

  it("is a no-op on a node with no statement (the guard the reducer owns)", () => {
    const ws = applyOperations(board(), [
      { op: "UPDATE_STATEMENT", id: "plain", status: "resolved" },
    ]);
    expect(ws.nodes.plain!.statement).toBeUndefined();
  });
});

describe("statement validation", () => {
  it("requires the target node to exist", () => {
    const errors = validateOperations(board(), [
      { op: "SET_STATEMENT", id: "ghost", statement: { kind: "decision", status: "resolved" } },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("does not exist");
  });

  it("requires superseded targets to carry statements", () => {
    const errors = validateOperations(board(), [
      {
        op: "SET_STATEMENT",
        id: "oct",
        statement: { kind: "decision", status: "resolved", supersedes: ["plain"] },
      },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("carries no statement");
  });

  it("refuses self-supersession", () => {
    const errors = validateOperations(board(), [
      {
        op: "SET_STATEMENT",
        id: "oct",
        statement: { kind: "decision", status: "resolved", supersedes: ["oct"] },
      },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("cannot supersede itself");
  });

  it("refuses an A→B→C→A supersession cycle", () => {
    const ws = applyOperations(createWorkspace({ diagramKind: "mindmap" }), [
      { op: "CREATE_NODE", id: "a", nodeType: "decision", label: "A" },
      { op: "CREATE_NODE", id: "b", nodeType: "decision", label: "B" },
      { op: "CREATE_NODE", id: "c", nodeType: "decision", label: "C" },
      { op: "SET_STATEMENT", id: "a", statement: { kind: "decision", status: "resolved" } },
      { op: "SET_STATEMENT", id: "b", statement: { kind: "decision", status: "resolved" } },
      { op: "SET_STATEMENT", id: "c", statement: { kind: "decision", status: "resolved" } },
      {
        op: "SET_STATEMENT",
        id: "a",
        statement: { kind: "decision", status: "resolved", supersedes: ["b"] },
      },
      {
        op: "SET_STATEMENT",
        id: "b",
        statement: { kind: "decision", status: "resolved", supersedes: ["c"] },
      },
    ]);
    // c → b → a: superseding a from c closes the loop.
    const errors = validateOperations(ws, [
      {
        op: "SET_STATEMENT",
        id: "c",
        statement: { kind: "decision", status: "resolved", supersedes: ["a"] },
      },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("cycle");
  });

  it("accepts a target statement created earlier in the same batch", () => {
    const errors = validateOperations(createWorkspace({ diagramKind: "mindmap" }), [
      { op: "CREATE_NODE", id: "old", nodeType: "decision", label: "Old" },
      { op: "CREATE_NODE", id: "new", nodeType: "decision", label: "New" },
      { op: "SET_STATEMENT", id: "old", statement: { kind: "proposal", status: "open" } },
      {
        op: "SET_STATEMENT",
        id: "new",
        statement: { kind: "decision", status: "resolved", supersedes: ["old"] },
      },
    ]);
    expect(errors).toEqual([]);
  });

  it("rejects a malformed topic (kebab-case contract)", () => {
    const parsed = safeParseOperations([
      {
        op: "SET_STATEMENT",
        id: "oct",
        statement: { kind: "decision", status: "resolved", topic: "Launch Date!" },
      },
    ]);
    expect(parsed.success).toBe(false);
  });
});

describe("the identity rule — statements survive visual changes", () => {
  it("a relabel leaves the statement and provenance untouched", () => {
    const ws = applyOperations(board(), [
      {
        op: "SET_STATEMENT",
        id: "oct",
        statement: { kind: "decision", status: "resolved", topic: "launch-date" },
      },
      { op: "CHANGE_TEXT", id: "oct", text: "Ship on Oct 15 (v2 wording)" },
    ]);
    expect(ws.nodes.oct!.label).toBe("Ship on Oct 15 (v2 wording)");
    expect(ws.nodes.oct!.statement).toEqual({
      kind: "decision",
      status: "resolved",
      topic: "launch-date",
    });
  });

  it("a transform is op-level too: CHANGE_NODE_TYPE preserves the statement", () => {
    const ws = applyOperations(board(), [
      { op: "CHANGE_NODE_TYPE", id: "sep", nodeType: "milestone" },
    ]);
    expect(ws.nodes.sep!.statement).toMatchObject({ kind: "decision", status: "resolved" });
    expect(ws.nodes.sep!.nodeType).toBe("milestone");
  });
});

describe("provenance", () => {
  it("CREATE_NODE stores provenance once, untouched by later ops", () => {
    const ws = applyOperations(createWorkspace({ diagramKind: "mindmap" }), [
      {
        op: "CREATE_NODE",
        id: "pricing",
        nodeType: "decision",
        label: "Pricing $15/mo",
        provenance: { meetingId: "mtg_7", turnRange: [4, 6], quote: "let's price at fifteen" },
      },
      { op: "CHANGE_TEXT", id: "pricing", text: "Pricing ($15/month)" },
    ]);
    expect(ws.nodes.pricing!.provenance).toEqual({
      meetingId: "mtg_7",
      turnRange: [4, 6],
      quote: "let's price at fifteen",
    });
    expect(ws.nodes.pricing!.label).toBe("Pricing ($15/month)");
  });

  it("attachProvenance enriches creates and statements, idempotently per op", () => {
    const ops: Operation[] = [
      { op: "CREATE_NODE", id: "a", nodeType: "decision", label: "A" },
      {
        op: "SET_STATEMENT",
        id: "a",
        statement: { kind: "decision", status: "resolved" },
      },
      { op: "CREATE_NODE", id: "b", nodeType: "step", label: "B" },
      { op: "CHANGE_TEXT", id: "b", text: "B2" },
    ];
    const provenance = { meetingId: "mtg_1", quote: "we decided" };
    const enriched = attachProvenance(ops, provenance);
    expect(enriched[0]).toMatchObject({ op: "CREATE_NODE", provenance });
    expect(enriched[1]).toMatchObject({
      op: "SET_STATEMENT",
      statement: { kind: "decision", status: "resolved", provenance },
    });
    expect(enriched[2]).toMatchObject({ op: "CREATE_NODE", provenance });
    // CHANGE_TEXT is untouched: provenance is about creation, not footnotes.
    expect(enriched[3]).toEqual(ops[3]);
    // Idempotent: a second pass never overwrites an origin already set.
    const again = attachProvenance(enriched, { meetingId: "mtg_2" });
    expect(again[0]).toMatchObject({ provenance: { meetingId: "mtg_1" } });
    expect(again[1]).toMatchObject({
      statement: { provenance: { meetingId: "mtg_1" } },
    });
    // And enrichment never breaks validation.
    expect(validateOperations(createWorkspace(), enriched)).toEqual([]);
  });

  it("attachProvenance skips a statement-clearing op", () => {
    const enriched = attachProvenance(
      [{ op: "SET_STATEMENT" as const, id: "a", statement: null }],
      { meetingId: "mtg_1" },
    );
    expect(enriched[0]).toEqual({ op: "SET_STATEMENT", id: "a", statement: null });
  });
});

describe("statement undo", () => {
  const expectRoundTrip = (before: Workspace, ops: Operation[]) => {
    const after = applyOperations(before, ops);
    const undone = applyOperations(after, inverseOperations(ops, before));
    const canon = (ws: Workspace) =>
      JSON.stringify(ws, (_k, v) =>
        typeof v === "object" && v !== null ? Object.keys(v).sort().reduce((acc: Record<string, unknown>, key) => {
          acc[key] = (v as Record<string, unknown>)[key];
          return acc;
        }, {}) : v,
      );
    expect(canon(undone)).toBe(canon(before));
  };

  it("SET_STATEMENT round-trips, including the null clear", () => {
    const before = board();
    expectRoundTrip(before, [
      {
        op: "SET_STATEMENT",
        id: "plain",
        statement: { kind: "question", status: "open", topic: "pricing" },
      },
    ]);
    expectRoundTrip(applyOperations(before, [
      {
        op: "SET_STATEMENT",
        id: "plain",
        statement: { kind: "question", status: "open" },
      },
    ]), [{ op: "SET_STATEMENT", id: "plain", statement: null }]);
  });

  it("UPDATE_STATEMENT round-trips via the full prior statement", () => {
    const before = applyOperations(board(), [
      {
        op: "SET_STATEMENT",
        id: "oct",
        statement: { kind: "proposal", status: "open", topic: "launch-date" },
      },
    ]);
    expectRoundTrip(before, [{ op: "UPDATE_STATEMENT", id: "oct", status: "rejected" }]);
  });

  it("undoing a supersession restores the target's prior statement", () => {
    const before = board();
    const ops: Operation[] = [
      {
        op: "SET_STATEMENT",
        id: "oct",
        statement: {
          kind: "decision",
          status: "resolved",
          topic: "launch-date",
          supersedes: ["sep"],
        },
      },
    ];
    const after = applyOperations(before, ops);
    expect(after.nodes.sep!.statement!.status).toBe("superseded");
    expectRoundTrip(before, ops);
  });

  it("deleting a statement node and undoing restores its statement", () => {
    const before = board();
    const ops: Operation[] = [{ op: "DELETE_NODE", id: "sep" }];
    expectRoundTrip(before, ops);
  });

  it("deleting a provenance-carrying node and undoing restores the provenance", () => {
    const before = applyOperations(createWorkspace({ diagramKind: "mindmap" }), [
      {
        op: "CREATE_NODE",
        id: "a",
        nodeType: "decision",
        label: "A",
        provenance: { meetingId: "mtg_9" },
      },
    ]);
    expectRoundTrip(before, [{ op: "DELETE_NODE", id: "a" }]);
  });
});
