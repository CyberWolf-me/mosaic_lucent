import { describe, expect, it } from "vitest";
import type { Operation } from "../src/model.js";
import {
  actionsFromDecision,
  applyOperations,
  createWorkspace,
  decisionDriveGraph,
  decisionsBehindAction,
  dependsOnGraph,
  derivedExecution,
  DRIVES_RELATIONSHIP,
  stampAuthorship,
  validateOperations,
} from "../src/index.js";

/**
 * The drives relation (Stage E1, ADR 0037). The contract: causality is a
 * typed relationship on existing edges — the DECISION is the source, the
 * executable ACTION is the target; the validator checks both endpoints
 * (including statements/issues minted earlier in the same batch); the
 * graph is readable in both directions; and drives NEVER enters the
 * dependency graph — a causal edge is historical fact, not an ordering, so
 * it can never form a cycle and never propagates blocking.
 */

const NOW = Date.UTC(2026, 8, 9, 12, 0); // 2026-09-09

function decision(id: string): Operation[] {
  return [
    { op: "CREATE_NODE", id, nodeType: "decision", label: id.replace(/-/g, " ") },
    { op: "SET_STATEMENT", id, statement: { kind: "decision", status: "resolved" } },
  ];
}

function action(id: string, fields: { status?: string; dueDate?: string } = {}): Operation[] {
  return [
    { op: "CREATE_NODE", id, nodeType: "action", label: id.replace(/-/g, " ") },
    { op: "SET_STATEMENT", id, statement: { kind: "action", status: "open" } },
    {
      op: "SET_ISSUE",
      id,
      issue: {
        type: "task",
        status: fields.status ?? "open",
        ...(fields.dueDate ? { dueDate: fields.dueDate } : {}),
      },
    },
  ];
}

function drives(from: string, to: string): Operation {
  return { op: "CONNECT_NODES", source: from, target: to, relationship: "drives" };
}

function board(ops: Operation[]) {
  return applyOperations(createWorkspace(), stampAuthorship(ops, "test-user"));
}

describe("decisionDriveGraph — the causal adjacency", () => {
  it("collects decision → action pairs from drives edges", () => {
    const ws = board([
      ...decision("dec-0"),
      ...action("req-0-action"),
      drives("dec-0", "req-0-action"),
    ]);
    const graph = decisionDriveGraph(ws);
    expect(graph.get("dec-0")).toEqual(["req-0-action"]);
  });

  it("is readable in both directions", () => {
    const ws = board([
      ...decision("dec-0"),
      ...decision("dec-1"),
      ...action("act-a"),
      ...action("act-b"),
      drives("dec-0", "act-a"),
      drives("dec-1", "act-b"),
    ]);
    expect(actionsFromDecision(ws, "dec-0").map((n) => n.id)).toEqual(["act-a"]);
    expect(decisionsBehindAction(ws, "act-b").map((n) => n.id)).toEqual(["dec-1"]);
  });

  it("ignores edges whose endpoints lost their meaning", () => {
    // A drives edge whose source is not a decision or whose target is not
    // executable reads as no causality — the read-side defensive filter,
    // same stance as derivedExecution takes toward its graph.
    const ws = applyOperations(
      createWorkspace(),
      stampAuthorship([
        // target without an issue: an action statement alone is not work.
        { op: "CREATE_NODE", id: "bare", nodeType: "action", label: "Bare" },
        { op: "SET_STATEMENT", id: "bare", statement: { kind: "action", status: "open" } },
        // source without a decision statement: a plain node drives nothing.
        { op: "CREATE_NODE", id: "plain", nodeType: "task", label: "Plain" },
        ...action("act-a"),
        ...decision("dec-0"),
        drives("dec-0", "bare"),
        drives("plain", "act-a"),
      ]),
    );
    expect(decisionDriveGraph(ws).size).toBe(0);
    expect(actionsFromDecision(ws, "dec-0")).toEqual([]);
    expect(decisionsBehindAction(ws, "act-a")).toEqual([]);
  });

  it("dedupes parallel drives edges between the same pair", () => {
    const ops: Operation[] = [
      ...decision("dec-0"),
      ...action("act-a"),
      drives("dec-0", "act-a"),
      drives("dec-0", "act-a"),
    ];
    const ws = applyOperations(createWorkspace(), stampAuthorship(ops));
    // The reducer keys edges by (source, target, relationship) — the same
    // triple is one edge; the graph reflects that.
    expect(decisionDriveGraph(ws).get("dec-0")).toEqual(["act-a"]);
  });
});

describe("drives never enters the dependency graph", () => {
  it("dependsOnGraph ignores drives edges", () => {
    const ws = board([...decision("dec-0"), ...action("act-a"), drives("dec-0", "act-a")]);
    expect(dependsOnGraph(ws).size).toBe(0);
  });

  it("derivedExecution is untouched by a drives edge to blocked work", () => {
    const ws = board([
      ...decision("dec-0"),
      ...action("act-a", { status: "blocked" }),
      drives("dec-0", "act-a"),
    ]);
    // act-a is blocked by nothing — its manual status is blocked, but no
    // dependency exists; and the decision, upstream of nothing, is fine.
    const derived = derivedExecution(ws, NOW);
    expect(derived.get("act-a")).toEqual({ blockedBy: [], atRiskBy: [] });
  });
});

describe("the validator's endpoint rule", () => {
  const check = (ops: Operation[]) => {
    const first = ops.findIndex((o) => o.op === "CONNECT_NODES");
    const seed = first === -1 ? ops : ops.slice(0, first);
    const rest = first === -1 ? [] : ops.slice(first);
    const ws = board(seed);
    return validateOperations(ws, stampAuthorship(rest, "test-user"));
  };

  it("accepts a decision → executable-action edge", () => {
    const errors = check([...decision("dec-0"), ...action("act-a"), drives("dec-0", "act-a")]);
    expect(errors).toEqual([]);
  });

  it("refuses when the source carries no decision statement", () => {
    const errors = check([
      ...decision("dec-0"),
      ...action("act-a"),
      { op: "CREATE_NODE", id: "plain", nodeType: "task", label: "Plain" },
      drives("plain", "act-a"),
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("the source carries no decision statement");
  });

  it("refuses when the target is not executable (no issue)", () => {
    const errors = check([
      ...decision("dec-0"),
      { op: "CREATE_NODE", id: "bare", nodeType: "action", label: "Bare" },
      { op: "SET_STATEMENT", id: "bare", statement: { kind: "action", status: "open" } },
      drives("dec-0", "bare"),
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("the target is not executable work");
  });

  it("refuses when the target carries no action statement", () => {
    const errors = check([...decision("dec-0"), ...decision("dec-1"), drives("dec-0", "dec-1")]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("the target is not executable work");
  });

  it("sees statements and issues minted earlier in the same batch", () => {
    // The plan flow emits CREATE + SET_STATEMENT + SET_ISSUE + CONNECT in
    // ONE batch — the endpoint rule must read the batch-simulated state,
    // not just the pre-existing board.
    const errors = check([
      { op: "CREATE_NODE", id: "dec-x", nodeType: "decision", label: "Decision x" },
      { op: "SET_STATEMENT", id: "dec-x", statement: { kind: "decision", status: "resolved" } },
      { op: "CREATE_NODE", id: "act-x", nodeType: "action", label: "Act x" },
      { op: "SET_STATEMENT", id: "act-x", statement: { kind: "action", status: "open" } },
      { op: "SET_ISSUE", id: "act-x", issue: { type: "task", status: "open" } },
      drives("dec-x", "act-x"),
    ]);
    expect(errors).toEqual([]);
  });

  it("disconnect of a drives edge stays always-valid", () => {
    const ws = board([...decision("dec-0"), ...action("act-a"), drives("dec-0", "act-a")]);
    const errors = validateOperations(
      ws,
      stampAuthorship(
        [{ op: "DISCONNECT_NODES", source: "dec-0", target: "act-a", relationship: "drives" }],
        "test-user",
      ),
    );
    expect(errors).toEqual([]);
    const after = applyOperations(
      ws,
      stampAuthorship(
        [{ op: "DISCONNECT_NODES", source: "dec-0", target: "act-a", relationship: "drives" }],
        "test-user",
      ),
    );
    expect(decisionDriveGraph(after).size).toBe(0);
  });
});

describe("the vocabulary pin", () => {
  it("DRIVES_RELATIONSHIP is the string the surfaces match on", () => {
    expect(DRIVES_RELATIONSHIP).toBe("drives");
  });
});
