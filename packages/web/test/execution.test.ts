import { describe, expect, it } from "vitest";
import { applyOperations, createWorkspace, type Operation } from "@lucent/core";
import { executionProjection } from "../src/execution.js";

/**
 * The Execution projection (Stage E2, ADR 0037). Pure, node-tested per the
 * web suite's convention — the view renders what this module decides. The
 * contract: the rollup counts, the blocker-first chains with reveal-ready
 * label chips, the decisions-behind rows over active work only, and the
 * empty flag.
 */

const NOW = Date.UTC(2026, 8, 9, 12, 0); // 2026-09-09

function action(
  id: string,
  fields: {
    status?: string;
    statusCategory?: "todo" | "in_progress" | "done";
    dueDate?: string;
  } = {},
): Operation[] {
  return [
    { op: "CREATE_NODE", id, nodeType: "action", label: id.replace(/-/g, " ") },
    { op: "SET_STATEMENT", id, statement: { kind: "action", status: "open" } },
    {
      op: "SET_ISSUE",
      id,
      issue: {
        type: "task",
        status: fields.status ?? "open",
        ...(fields.statusCategory ? { statusCategory: fields.statusCategory } : {}),
        ...(fields.dueDate ? { dueDate: fields.dueDate } : {}),
      },
    },
  ];
}

function decision(id: string, label = id): Operation[] {
  return [
    { op: "CREATE_NODE", id, nodeType: "decision", label },
    { op: "SET_STATEMENT", id, statement: { kind: "decision", status: "resolved" } },
  ];
}

function board(ops: Operation[]) {
  return applyOperations(createWorkspace(), ops);
}

describe("executionProjection", () => {
  it("empty is true only when the board has no executable actions", () => {
    expect(executionProjection(board([]), NOW).empty).toBe(true);
    const bareStatement = board([
      { op: "CREATE_NODE", id: "bare", nodeType: "action", label: "Bare" },
      { op: "SET_STATEMENT", id: "bare", statement: { kind: "action", status: "open" } },
    ]);
    expect(executionProjection(bareStatement, NOW).empty).toBe(true);
    expect(executionProjection(board([...action("one")]), NOW).empty).toBe(false);
  });

  it("chains carry blocker-first label chips with ids for the reveal jump", () => {
    const ws = board([
      ...action("design", { status: "blocked", statusCategory: "in_progress" }),
      ...action("implementation"),
      ...action("qa"),
      {
        op: "CONNECT_NODES",
        source: "implementation",
        target: "design",
        relationship: "depends_on",
      },
      { op: "CONNECT_NODES", source: "qa", target: "implementation", relationship: "depends_on" },
    ]);
    const { chains } = executionProjection(ws, NOW);
    const qa = chains.find((c) => c.nodeId === "qa")!;
    expect(qa.chain.map((n) => n.id)).toEqual(["design", "implementation", "qa"]);
    // Label chips: what the view renders inside the buttons.
    expect(qa.chain.every((n) => typeof n.label === "string")).toBe(true);
  });

  it("decisionsBehind covers only active work (in-progress/blocked/derived-blocked)", () => {
    const ws = board([
      ...decision("dec-0", "Phased rollout"),
      ...action("active-work", { status: "in_progress", statusCategory: "in_progress" }),
      ...action("done-work", { status: "completed", statusCategory: "done" }),
      ...action("todo-work"),
      { op: "CONNECT_NODES", source: "dec-0", target: "active-work", relationship: "drives" },
      { op: "CONNECT_NODES", source: "dec-0", target: "done-work", relationship: "drives" },
      { op: "CONNECT_NODES", source: "dec-0", target: "todo-work", relationship: "drives" },
    ]);
    const { decisionsBehind } = executionProjection(ws, NOW);
    expect(decisionsBehind).toHaveLength(1);
    expect(decisionsBehind[0]).toMatchObject({
      actionId: "active-work",
      decisionId: "dec-0",
      decisionLabel: "Phased rollout",
    });
  });

  it("a blocked action's decisionsBehind row renders beside its chain", () => {
    // The E1+E2 payoff together: blocked work whose cause is a decision —
    // the dashboard names both the chain and the decision.
    const ws = board([
      ...decision("dec-0", "Phased rollout"),
      ...action("root", { status: "blocked", statusCategory: "in_progress" }),
      ...action("waiting", { status: "in_progress", statusCategory: "in_progress" }),
      { op: "CONNECT_NODES", source: "waiting", target: "root", relationship: "depends_on" },
      { op: "CONNECT_NODES", source: "dec-0", target: "waiting", relationship: "drives" },
    ]);
    const p = executionProjection(ws, NOW);
    expect(p.chains.find((c) => c.nodeId === "waiting")).toBeDefined();
    expect(p.decisionsBehind.map((r) => r.actionId)).toContain("waiting");
    expect(p.rollup.blocked).toBe(2);
  });

  it("the rollup is the core rollup, unmodified", () => {
    const ws = board([
      ...action("done-0", { status: "completed", statusCategory: "done" }),
      ...action("open-0"),
    ]);
    expect(executionProjection(ws, NOW).rollup).toEqual({
      total: 2,
      completed: 1,
      inProgress: 0,
      blocked: 0,
      atRisk: 0,
      overdue: 0,
      percent: 50,
    });
  });
});
