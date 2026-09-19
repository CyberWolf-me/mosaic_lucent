import { describe, expect, it } from "vitest";
import type { Operation } from "../src/model.js";
import {
  applyOperations,
  blockingChains,
  createWorkspace,
  executionRollup,
  stampAuthorship,
} from "../src/index.js";

/**
 * The execution rollup (Stage E2, ADR 0037). The contract: one screen's
 * worth of answers, pure over (workspace, now). Counts over EXECUTABLE
 * actions only; blocked is manual-status OR derived blockers; at-risk is
 * derived overdue-unfinished upstream with BLOCKED NOT EXCLUDED (ADR
 * 0029's settled rule — trouble compounds); overdue is the action's own
 * past-due date; percent over completed only. The blocking chains tell
 * the story: blocker-first node paths from a manually blocked upstream to
 * each derived-blocked target.
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

function depends(a: string, b: string): Operation {
  return { op: "CONNECT_NODES", source: a, target: b, relationship: "depends_on" };
}

function board(ops: Operation[]) {
  return applyOperations(createWorkspace(), stampAuthorship(ops, "test-user"));
}

describe("executionRollup", () => {
  it("counts the executable actions across the signals, percent over completed", () => {
    const ws = board([
      ...action("done-0", { status: "completed", statusCategory: "done" }),
      ...action("done-1", { status: "cancelled", statusCategory: "done" }),
      ...action("prog-0", { status: "in_progress", statusCategory: "in_progress" }),
      ...action("todo-0"),
    ]);
    const r = executionRollup(ws, NOW);
    expect(r).toEqual({
      total: 4,
      completed: 2,
      inProgress: 1,
      blocked: 0,
      atRisk: 0,
      overdue: 0,
      percent: 50,
    });
  });

  it("an empty board rolls up to zeros, not NaN", () => {
    const r = executionRollup(board([]), NOW);
    expect(r.total).toBe(0);
    expect(r.percent).toBe(0);
  });

  it("counts a bare action statement without an issue as NOT executable", () => {
    const ws = board([
      { op: "CREATE_NODE", id: "bare", nodeType: "action", label: "Bare" },
      { op: "SET_STATEMENT", id: "bare", statement: { kind: "action", status: "open" } },
    ]);
    expect(executionRollup(ws, NOW).total).toBe(0);
  });

  it("blocked is the manual status OR any derived blocker", () => {
    // manual-blocked, no upstream
    const manual = board([
      ...action("stuck", { status: "blocked", statusCategory: "in_progress" }),
    ]);
    expect(executionRollup(manual, NOW).blocked).toBe(1);
    // open status, blocked through the graph — the downstream counts; the
    // blocked upstream counts too (it is itself an executable action whose
    // manual status is blocked). Both are blocked work; the rollup says so.
    const derived = board([
      ...action("blocked-upstream", { status: "blocked", statusCategory: "in_progress" }),
      ...action("waiting"),
      depends("waiting", "blocked-upstream"),
    ]);
    expect(executionRollup(derived, NOW).blocked).toBe(2);
  });

  it("at-risk counts blocked-and-overdue upstream (blocked NOT excluded — ADR 0029)", () => {
    const ws = board([
      // blocked AND past due: the compounded trouble the settled rule keeps
      ...action("sour", {
        status: "blocked",
        statusCategory: "in_progress",
        dueDate: "2020-01-01",
      }),
      ...action("downstream"),
      depends("downstream", "sour"),
    ]);
    const r = executionRollup(ws, NOW);
    expect(r.atRisk).toBe(1); // the downstream, at risk FROM the sour upstream
    expect(r.blocked).toBe(2); // sour (manual) + downstream (derived)
    expect(r.overdue).toBe(1); // sour's own past-due date
  });

  it("overdue is the action's own past-due unfinished date", () => {
    const ws = board([
      ...action("late", { dueDate: "2026-09-01" }),
      ...action("on-time", { dueDate: "2026-12-31" }),
      ...action("late-but-done", {
        status: "completed",
        statusCategory: "done",
        dueDate: "2026-09-01",
      }),
    ]);
    expect(executionRollup(ws, NOW).overdue).toBe(1);
  });

  it("in-progress excludes blocked work (blocked is its own signal)", () => {
    const ws = board([
      ...action("prog-0", { status: "in_progress", statusCategory: "in_progress" }),
      ...action("stuck", { status: "in_progress", statusCategory: "in_progress" }),
      ...action("root-block", { status: "blocked", statusCategory: "in_progress" }),
      depends("stuck", "root-block"),
    ]);
    const r = executionRollup(ws, NOW);
    expect(r.inProgress).toBe(1); // prog-0 only; stuck is blocked
    expect(r.blocked).toBe(2); // stuck (derived) + root-block (manual)
  });
});

describe("blockingChains", () => {
  it("walks the chain from a manually blocked upstream down to the target, blocker-first", () => {
    const ws = board([
      ...action("design", { status: "blocked", statusCategory: "in_progress" }),
      ...action("implementation"),
      ...action("qa"),
      depends("implementation", "design"),
      depends("qa", "implementation"),
    ]);
    const chains = blockingChains(ws, NOW);
    expect(chains).toHaveLength(2);
    const qaChain = chains.find((c) => c.nodeId === "qa")!;
    // The story: design is blocked → implementation waits on it → qa waits
    // on implementation. Blocker-first order.
    expect(qaChain.chain.map((n) => n.id)).toEqual(["design", "implementation", "qa"]);
    const implChain = chains.find((c) => c.nodeId === "implementation")!;
    expect(implChain.chain.map((n) => n.id)).toEqual(["design", "implementation"]);
  });

  it("falls back to the direct blockers when no manually blocked root is reachable", () => {
    // A blocked root that is NOT executable (no action statement): the
    // graph forwards nothing through it, so the executable chain below it
    // never reaches a manually blocked root — the chain is the direct
    // blocker list, still a story.
    const ws = board([
      ...action("derived-blocked", { status: "in_progress", statusCategory: "in_progress" }),
      ...action("waiting"),
      { op: "CREATE_NODE", id: "plain", nodeType: "task", label: "Plain blocker" },
      {
        op: "SET_ISSUE",
        id: "plain",
        issue: { type: "task", status: "blocked", statusCategory: "in_progress" },
      },
      {
        op: "CONNECT_NODES",
        source: "derived-blocked",
        target: "plain",
        relationship: "depends_on",
      },
      depends("waiting", "derived-blocked"),
    ]);
    const chains = blockingChains(ws, NOW);
    const waiting = chains.find((c) => c.nodeId === "waiting");
    expect(waiting).toBeDefined();
    expect(waiting!.chain.map((n) => n.id)).toContain("derived-blocked");
  });

  it("a board with no dependencies has no chains", () => {
    const ws = board([...action("solo"), ...action("pair")]);
    expect(blockingChains(ws, NOW)).toEqual([]);
  });

  it("picks the shortest path when several blocked roots exist (deterministic)", () => {
    const ws = board([
      ...action("far-root", { status: "blocked", statusCategory: "in_progress" }),
      ...action("near-root", { status: "blocked", statusCategory: "in_progress" }),
      ...action("mid"),
      ...action("target"),
      depends("mid", "far-root"),
      depends("target", "near-root"),
      depends("target", "mid"),
    ]);
    const chains = blockingChains(ws, NOW);
    const target = chains.find((c) => c.nodeId === "target")!;
    // near-root is one hop from target; far-root is two. Shortest wins.
    expect(target.chain.map((n) => n.id)).toEqual(["near-root", "target"]);
  });
});
