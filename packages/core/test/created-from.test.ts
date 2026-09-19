import { describe, expect, it } from "vitest";
import type { Operation } from "../src/model.js";
import {
  applyOperations,
  createWorkspace,
  inverseOperations,
  parseWorkspace,
  safeParseOperations,
} from "../src/index.js";
import { attachPlanProvenance, attachProvenance } from "../src/operations.js";

/**
 * The createdFrom evidence kind (Stage D2, ADR 0028): the provenance family's
 * second member — the statement→action link plan generation stamps. The
 * contract: at least one evidence kind required (meeting OR sources); the
 * model never emits it; attachPlanProvenance MERGES rather than overwrites
 * (a plan from a meeting carries both); it rides the one pipeline (validate,
 * log, peers, undo) because it is on the op, not a post-pass.
 */

describe("provenanceFieldsSchema: the at-least-one refine", () => {
  it("meeting evidence alone is valid", () => {
    expect(
      safeParseOperations([
        {
          op: "CREATE_NODE",
          id: "n1",
          nodeType: "action",
          label: "L",
          provenance: { meetingId: "mtg_1" },
        },
      ]).success,
    ).toBe(true);
  });

  it("createdFrom alone is valid — a plan from board selection", () => {
    expect(
      safeParseOperations([
        {
          op: "CREATE_NODE",
          id: "n1",
          nodeType: "action",
          label: "L",
          provenance: { createdFrom: ["decision-1", "risk-2"] },
        },
      ]).success,
    ).toBe(true);
  });

  it("neither evidence kind is rejected", () => {
    const result = safeParseOperations([
      {
        op: "CREATE_NODE",
        id: "n1",
        nodeType: "action",
        label: "L",
        provenance: {},
      },
    ]);
    expect(result.success).toBe(false);
  });

  it("both evidence kinds coexist — a plan from a meeting's decisions", () => {
    expect(
      safeParseOperations([
        {
          op: "CREATE_NODE",
          id: "n1",
          nodeType: "action",
          label: "L",
          provenance: {
            meetingId: "mtg_1",
            turnRange: [2, 3],
            createdFrom: ["decision-1"],
          },
        },
      ]).success,
    ).toBe(true);
  });

  it("an empty createdFrom array is not evidence", () => {
    const result = safeParseOperations([
      {
        op: "CREATE_NODE",
        id: "n1",
        nodeType: "action",
        label: "L",
        provenance: { createdFrom: [] },
      },
    ]);
    expect(result.success).toBe(false);
  });

  it("more than 20 sources is rejected (the cap)", () => {
    expect(
      safeParseOperations([
        {
          op: "CREATE_NODE",
          id: "n1",
          nodeType: "action",
          label: "L",
          provenance: { createdFrom: Array.from({ length: 21 }, (_, i) => `s${i}`) },
        },
      ]).success,
    ).toBe(false);
  });
});

describe("attachPlanProvenance: fill-don't-overwrite, merge-with-meeting", () => {
  const planOps: Operation[] = [
    { op: "CREATE_NODE", id: "task-1", nodeType: "action", label: "Implement" },
    {
      op: "SET_STATEMENT",
      id: "task-1",
      statement: { kind: "action", status: "open", topic: "launch" },
    },
    { op: "CREATE_GROUP", id: "plan-region", label: "Launch plan", children: ["task-1"] },
  ];

  it("stamps createdFrom onto CREATE_NODE and SET_STATEMENT, not onto other ops", () => {
    const stamped = attachPlanProvenance(planOps, ["decision-1", "decision-2"]);
    const create = stamped[0]!;
    expect(create.op === "CREATE_NODE" ? create.provenance?.createdFrom : undefined).toEqual([
      "decision-1",
      "decision-2",
    ]);
    const set = stamped[1]!;
    expect(set.op === "SET_STATEMENT" ? set.statement?.provenance?.createdFrom : undefined).toEqual(
      ["decision-1", "decision-2"],
    );
    // Groups carry no provenance — evidence is about creation, not layout.
    expect(stamped[2]).toEqual(planOps[2]);
  });

  it("MERGES with meeting evidence instead of overwriting it", () => {
    // The meeting stamp first (the existing writer), then the plan stamp.
    const meeting = attachProvenance(planOps, {
      meetingId: "mtg_1",
      turnRange: [2, 2],
      quote: "we decided",
    });
    const both = attachPlanProvenance(meeting, ["decision-1"]);
    const create = both[0]!;
    if (create.op !== "CREATE_NODE") throw new Error("expected CREATE_NODE");
    expect(create.provenance).toEqual({
      meetingId: "mtg_1",
      turnRange: [2, 2],
      quote: "we decided",
      createdFrom: ["decision-1"],
    });
  });

  it("is idempotent: a second stamp does not overwrite the first", () => {
    const once = attachPlanProvenance(planOps, ["decision-1"]);
    const twice = attachPlanProvenance(once, ["decision-2"]);
    const create = twice[0]!;
    expect(create.op === "CREATE_NODE" ? create.provenance?.createdFrom : undefined).toEqual([
      "decision-1",
    ]);
  });

  it("an empty statementIds list returns the ops unchanged", () => {
    expect(attachPlanProvenance(planOps, [])).toEqual(planOps);
  });

  it("a SET_STATEMENT clear (null) is untouched", () => {
    const clearing: Operation[] = [{ op: "SET_STATEMENT", id: "x", statement: null }];
    expect(attachPlanProvenance(clearing, ["s1"])).toEqual(clearing);
  });
});

describe("createdFrom rides the pipeline", () => {
  const stampedOps: Operation[] = [
    {
      op: "CREATE_NODE",
      id: "task-1",
      nodeType: "action",
      label: "Implement",
      provenance: { createdFrom: ["decision-1"] },
    },
    {
      op: "SET_STATEMENT",
      id: "task-1",
      statement: {
        kind: "action",
        status: "open",
        provenance: { createdFrom: ["decision-1"] },
      },
    },
  ];

  it("the reducer stores createdFrom on the node and its statement", () => {
    const ws = applyOperations(createWorkspace(), stampedOps);
    expect(ws.nodes["task-1"]?.provenance?.createdFrom).toEqual(["decision-1"]);
    expect(ws.nodes["task-1"]?.statement?.provenance?.createdFrom).toEqual(["decision-1"]);
  });

  it("undo restores createdFrom (DELETE_NODE's inverse re-emits provenance)", () => {
    const ws = applyOperations(createWorkspace(), stampedOps);
    const del: Operation[] = [{ op: "DELETE_NODE", id: "task-1" }];
    const deleted = applyOperations(ws, del);
    expect(deleted.nodes["task-1"]).toBeUndefined();
    const restored = applyOperations(deleted, inverseOperations(del, ws));
    expect(restored.nodes["task-1"]?.provenance?.createdFrom).toEqual(["decision-1"]);
    expect(restored.nodes["task-1"]?.statement?.provenance?.createdFrom).toEqual(["decision-1"]);
  });

  it("the persistence round-trip keeps createdFrom (the strip trap)", () => {
    const ws = applyOperations(createWorkspace(), stampedOps);
    const loaded = parseWorkspace(JSON.parse(JSON.stringify(ws)));
    if (!loaded.ok) throw new Error(loaded.detail);
    expect(loaded.workspace.nodes["task-1"]?.provenance?.createdFrom).toEqual(["decision-1"]);
    expect(loaded.workspace.nodes["task-1"]?.statement?.provenance?.createdFrom).toEqual([
      "decision-1",
    ]);
  });

  it("a stored board with legacy meeting-only provenance loads unchanged", () => {
    const legacyOps: Operation[] = [
      {
        op: "CREATE_NODE",
        id: "old",
        nodeType: "step",
        label: "Old",
        provenance: { meetingId: "mtg_0", turnRange: [0, 0] },
      },
    ];
    const ws = applyOperations(createWorkspace(), legacyOps);
    const loaded = parseWorkspace(JSON.parse(JSON.stringify(ws)));
    if (!loaded.ok) throw new Error(loaded.detail);
    expect(loaded.workspace.nodes["old"]?.provenance?.meetingId).toBe("mtg_0");
    expect(loaded.workspace.nodes["old"]?.provenance?.createdFrom).toBeUndefined();
  });
});
