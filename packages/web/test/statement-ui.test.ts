import { describe, it, expect } from "vitest";
import { applyOperations, createWorkspace, validateOperations, type Operation } from "@lucent/core";
import {
  KIND_TINT,
  STATEMENT_KINDS,
  STATEMENT_STATUSES,
  statementChipDim,
  statementChipText,
  statementEditOps,
  topicDuplicateHint,
  topicSuggestions,
} from "../src/statementUi.js";

/**
 * Statement presentation + edit decisions (Stage C2), node-tested per the web
 * suite's convention. The two contracts under test:
 *
 * - The CHIP: what the card renders (kind · status) and when it recedes (a
 *   settled lifecycle should not shout).
 * - The HUD EDIT → OP mapping: manual edits build the SAME op the model
 *   emits, and the commit runs through the same validator — so the editor's
 *   behavior is checkable here without a DOM, including the guardrails the
 *   review asked for (supersedes constrained to statement-carrying nodes,
 *   rejected visibly on a bad edit).
 */

describe("statementChip", () => {
  it("renders kind · status as one token", () => {
    expect(statementChipText({ kind: "decision", status: "resolved", topic: "pricing" })).toBe(
      "decision · resolved",
    );
    expect(statementChipText({ kind: "question", status: "open" })).toBe("question · open");
  });

  it("recedes when the lifecycle is settled; shouts only while open", () => {
    expect(statementChipDim({ kind: "proposal", status: "open" })).toBe(false);
    for (const status of ["resolved", "rejected", "superseded"] as const) {
      expect(statementChipDim({ kind: "proposal", status })).toBe(true);
    }
  });

  it("tints every kind (a missing tint would render unstyled)", () => {
    for (const kind of STATEMENT_KINDS) expect(KIND_TINT[kind]).toBeDefined();
    for (const status of STATEMENT_STATUSES)
      expect(["open", "resolved", "rejected", "superseded"]).toContain(status);
  });
});

describe("statementEditOps — the HUD's op builder", () => {
  const seeded = applyOperations(createWorkspace(), [
    { op: "CREATE_NODE", id: "n1", nodeType: "decision", label: "One" },
    { op: "CREATE_NODE", id: "n2", nodeType: "decision", label: "Two" },
    {
      op: "SET_STATEMENT",
      id: "n2",
      statement: { kind: "proposal", status: "open", topic: "pricing" },
    },
  ]);

  it("no prior statement → SET_STATEMENT with the draft", () => {
    const ops = statementEditOps("n1", undefined, {
      kind: "decision",
      status: "resolved",
      topic: "launch-date",
    });
    expect(ops).toEqual([
      {
        op: "SET_STATEMENT",
        id: "n1",
        statement: { kind: "decision", status: "resolved", topic: "launch-date" },
      },
    ]);
    expect(validateOperations(seeded, ops)).toEqual([]);
  });

  it("same kind → UPDATE_STATEMENT patch (kind is identity, never patched)", () => {
    const prior = seeded.nodes.n2!.statement!;
    const ops = statementEditOps("n2", prior, {
      kind: "proposal",
      status: "rejected",
      topic: "pricing",
      supersedes: [],
    });
    expect(ops).toEqual([
      { op: "UPDATE_STATEMENT", id: "n2", status: "rejected", topic: "pricing", supersedes: [] },
    ]);
    expect(validateOperations(seeded, ops)).toEqual([]);
  });

  it("empty topic string clears the key (null, the reducer's clear contract)", () => {
    const prior = seeded.nodes.n2!.statement!;
    const ops = statementEditOps("n2", prior, {
      kind: "proposal",
      status: "open",
      topic: "",
    });
    expect(ops[0]).toMatchObject({ op: "UPDATE_STATEMENT", id: "n2", topic: null });
    // Applied: the key is gone, not an empty string.
    const next = applyOperations(seeded, ops as Operation[]);
    expect(next.nodes.n2?.statement?.topic).toBeUndefined();
  });

  it("different kind → SET_STATEMENT replacement (a kind change is a new statement)", () => {
    const prior = seeded.nodes.n2!.statement!;
    const ops = statementEditOps("n2", prior, {
      kind: "decision",
      status: "resolved",
      topic: "pricing",
    });
    expect(ops[0]).toMatchObject({
      op: "SET_STATEMENT",
      id: "n2",
      statement: { kind: "decision", status: "resolved", topic: "pricing" },
    });
  });

  it("THE GUARDRAIL: a supersedes edit on a statement-less node is refused by the same validator the AI faces", () => {
    // The editor's picker only offers statement-carrying nodes, but the op
    // contract is what actually protects the board — this is the review's
    // rule that manual edits validate identically, proven here at the seam
    // the editor commits through.
    const ops = statementEditOps("n1", undefined, {
      kind: "decision",
      status: "resolved",
      supersedes: ["n2"],
    });
    // n2 carries a statement → valid.
    expect(validateOperations(seeded, ops)).toEqual([]);
    // But a statement-less target is refused…
    const seeded2 = applyOperations(createWorkspace(), [
      { op: "CREATE_NODE", id: "plain", nodeType: "step", label: "Plain" },
      { op: "CREATE_NODE", id: "from", nodeType: "decision", label: "From" },
    ]);
    const badOps = statementEditOps("from", undefined, {
      kind: "decision",
      status: "resolved",
      supersedes: ["plain"],
    });
    expect(validateOperations(seeded2, badOps)).toHaveLength(1);
    // …and so is a cycle: A supersedes B while B supersedes A.
    const cyclicBoard = applyOperations(createWorkspace(), [
      { op: "CREATE_NODE", id: "a", nodeType: "decision", label: "A" },
      { op: "CREATE_NODE", id: "b", nodeType: "decision", label: "B" },
      {
        op: "SET_STATEMENT",
        id: "a",
        statement: { kind: "decision", status: "open", supersedes: ["b"] },
      },
      { op: "SET_STATEMENT", id: "b", statement: { kind: "proposal", status: "open" } },
    ]);
    const cycleOps = statementEditOps("b", cyclicBoard.nodes.b!.statement, {
      kind: "proposal",
      status: "rejected",
      supersedes: ["a"],
    });
    expect(validateOperations(cyclicBoard, cycleOps)).toHaveLength(1);
  });
});

describe("topic suggestions + the duplicate recommendation (Stage C5, ADR 0025)", () => {
  function board(...topics: string[]) {
    const ops: Operation[] = [];
    topics.forEach((topic, i) => {
      ops.push({ op: "CREATE_NODE", id: `n${i}`, nodeType: "decision", label: `N${i}` });
      ops.push({
        op: "SET_STATEMENT",
        id: `n${i}`,
        statement: { kind: "decision", status: "open", topic },
      });
    });
    return applyOperations(createWorkspace(), ops);
  }

  it("topicSuggestions lists the board's authored keys, as-authored", () => {
    expect(topicSuggestions(board("pricing", "onboarding", "pricing"))).toEqual([
      "pricing",
      "onboarding",
    ]);
    expect(topicSuggestions(createWorkspace())).toEqual([]);
  });

  it("the hint fires on a variant with evidence: statement count, existing key", () => {
    // The human types 'Pricing Model' over a board carrying 'pricing' (twice).
    const ws = board("pricing", "pricing", "onboarding");
    const hint = topicDuplicateHint("Pricing Model", ws);
    expect(hint).toEqual({ existing: "pricing", statements: 2 });
  });

  it("the typed value AS an existing key hints nothing — it IS the key", () => {
    expect(topicDuplicateHint("pricing", board("pricing"))).toBeUndefined();
  });

  it("the ambiguity guard: two candidate keys hint nothing", () => {
    // 'pricing-model' matches both 'pricing' and 'model-pricing' — not a
    // duplicate of either. Same rule as the fold, applied to suggestions.
    expect(topicDuplicateHint("pricing-model", board("pricing", "model-pricing"))).toBeUndefined();
  });

  it("a semantic non-variant never hints: monetization beside pricing", () => {
    expect(topicDuplicateHint("monetization", board("pricing"))).toBeUndefined();
    expect(topicDuplicateHint("customer-acquisition", board("user-acquisition"))).toBeUndefined();
  });

  it("an empty or whitespace value hints nothing", () => {
    expect(topicDuplicateHint("", board("pricing"))).toBeUndefined();
    expect(topicDuplicateHint("   ", board("pricing"))).toBeUndefined();
  });
});

describe("the manual path never folds (Stage C5, rule 2)", () => {
  it("a human's variant topic commits exactly as typed through statementEditOps", () => {
    // applyManual runs these ops with NO fold call (pinned by placement —
    // workspace.tsx's applyManual passes ops straight to validateOperations).
    // What this pins: the ops the HUD builds carry the topic verbatim, so a
    // human's 'pricing-model' beside 'pricing' is the human's authored key —
    // grouped at read time by canonicalization, never rewritten at write
    // time.
    const ops = statementEditOps("n1", undefined, {
      kind: "decision",
      status: "open",
      topic: "pricing-model",
      supersedes: [],
    });
    expect(ops).toHaveLength(1);
    const op = ops[0]!;
    if (op.op !== "SET_STATEMENT") throw new Error("expected SET_STATEMENT");
    expect(op.statement?.topic).toBe("pricing-model");
  });
});
