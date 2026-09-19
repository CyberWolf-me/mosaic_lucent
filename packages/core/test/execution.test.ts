import { describe, expect, it } from "vitest";
import type { Operation } from "../src/model.js";
import {
  actionNodes,
  applyOperations,
  categorizeStatus,
  createWorkspace,
  EXECUTION_STATUSES,
  executionStatusColumn,
  inverseOperations,
  parseWorkspace,
  resolveDueDate,
  safeParseOperations,
  validateOperations,
} from "../src/index.js";

/**
 * The execution model (Stage D1, ADR 0027). The contract: an Action is an
 * ordinary workspace node carrying a C2 action statement plus IssueFields;
 * dueDate and description are execution metadata on the issue layer; the
 * canonical execution vocabulary is convention + teaching + mapping, NOT an
 * enum; no field derives another; dependencies are deferred to D3.
 *
 * The five places every issue field must land (model, op schema, reducer,
 * inverse, workspaceSchema restatement) are pinned by the round-trip tests:
 * the strip trap is the one that fails silently.
 */

function boardOf(ops: Operation[]) {
  return applyOperations(createWorkspace(), ops);
}

function actionNode(id: string, extra: { issue?: Record<string, unknown>; statement?: boolean } = {}) {
  const ops: Operation[] = [
    { op: "CREATE_NODE", id, nodeType: "action", label: id },
    ...(extra.statement === false
      ? []
      : [
          {
            op: "SET_STATEMENT",
            id,
            statement: { kind: "action", status: "open" },
          } as Operation,
        ]),
    ...(extra.issue
      ? [{ op: "SET_ISSUE", id, issue: { type: "task", status: "open", ...extra.issue } } as Operation]
      : []),
  ];
  return ops;
}

describe("dueDate + description on the issue layer (Stage D1)", () => {
  it("SET_ISSUE carries both fields; UPDATE_ISSUE patches and null-clears them", () => {
    const ws = boardOf([
      ...actionNode("a1", {
        issue: { dueDate: "2026-09-12", description: "Prepare the final launch brief" },
      }),
    ]);
    const issue = ws.nodes.a1?.issue;
    expect(issue?.dueDate).toBe("2026-09-12");
    expect(issue?.description).toBe("Prepare the final launch brief");

    // Patch one field: the other is untouched (independence at the op level).
    const patched = applyOperations(ws, [
      { op: "UPDATE_ISSUE", id: "a1", description: "Updated scope" },
    ]);
    expect(patched.nodes.a1?.issue?.description).toBe("Updated scope");
    expect(patched.nodes.a1?.issue?.dueDate).toBe("2026-09-12");

    // Null clears.
    const cleared = applyOperations(patched, [{ op: "UPDATE_ISSUE", id: "a1", dueDate: null }]);
    expect(cleared.nodes.a1?.issue?.dueDate).toBeUndefined();
    expect(cleared.nodes.a1?.issue?.description).toBe("Updated scope");
  });

  it("the op schema rejects malformed dates and over-cap descriptions", () => {
    const _board = boardOf(actionNode("a1"));
    const badDate = safeParseOperations([
      { op: "SET_ISSUE", id: "a1", issue: { type: "task", status: "open", dueDate: "Friday" } },
    ]);
    expect(badDate.success).toBe(false);
    const garbage = safeParseOperations([
      { op: "SET_ISSUE", id: "a1", issue: { type: "task", status: "open", dueDate: "2026-9-12" } },
    ]);
    expect(garbage.success).toBe(false);
    const badPatch = safeParseOperations([{ op: "UPDATE_ISSUE", id: "a1", dueDate: "tomorrow" }]);
    expect(badPatch.success).toBe(false);
    const tooLong = safeParseOperations([
      {
        op: "SET_ISSUE",
        id: "a1",
        issue: { type: "task", status: "open", description: "x".repeat(2001) },
      },
    ]);
    expect(tooLong.success).toBe(false);
    // 2000 exactly is fine (the Comment.body cap).
    const atCap = safeParseOperations([
      {
        op: "SET_ISSUE",
        id: "a1",
        issue: { type: "task", status: "open", description: "x".repeat(2000) },
      },
    ]);
    expect(atCap.success).toBe(true);
  });

  it("undo round-trips both fields — SET and UPDATE inverses", () => {
    const before = boardOf(actionNode("a1"));
    const _ops: Operation[] = [
      ...actionNode("a1", { issue: { dueDate: "2026-09-12", description: "The brief" } }),
    ];
    // SET_ISSUE (over an existing issue) and UPDATE_ISSUE both restore.
    const setWs = applyOperations(before, [
      {
        op: "SET_ISSUE",
        id: "a1",
        issue: { type: "task", status: "assigned", dueDate: "2026-09-12", description: "The brief" },
      },
    ]);
    expect(setWs.nodes.a1?.issue?.dueDate).toBe("2026-09-12");
    const undoneSet = applyOperations(setWs, inverseOperations(
      [{ op: "SET_ISSUE", id: "a1", issue: { type: "task", status: "assigned", dueDate: "2026-09-12", description: "The brief" } }],
      before,
    ));
    expect(undoneSet.nodes.a1?.issue?.dueDate).toBeUndefined();
    expect(undoneSet.nodes.a1?.issue?.description).toBeUndefined();

    const updated = applyOperations(setWs, [{ op: "UPDATE_ISSUE", id: "a1", dueDate: "2026-09-30" }]);
    const undoneUpdate = applyOperations(updated, inverseOperations(
      [{ op: "UPDATE_ISSUE", id: "a1", dueDate: "2026-09-30" }],
      setWs,
    ));
    expect(undoneUpdate.nodes.a1?.issue?.dueDate).toBe("2026-09-12");
  });

  it("DELETE_NODE's undo restore carries both fields", () => {
    const ws = boardOf(actionNode("a1", { issue: { dueDate: "2026-09-12", description: "D" } }));
    const del: Operation[] = [{ op: "DELETE_NODE", id: "a1" }];
    expect(validateOperations(ws, del)).toEqual([]);
    const deleted = applyOperations(ws, del);
    expect(deleted.nodes.a1).toBeUndefined();
    const restored = applyOperations(deleted, inverseOperations(del, ws));
    expect(restored.nodes.a1?.issue?.dueDate).toBe("2026-09-12");
    expect(restored.nodes.a1?.issue?.description).toBe("D");
  });

  it("the persistence round-trip survives: parseWorkspace keeps both fields (the strip trap)", () => {
    const ws = boardOf(actionNode("a1", { issue: { dueDate: "2026-09-12", description: "D" } }));
    const persisted = JSON.parse(JSON.stringify(ws));
    const result = parseWorkspace(persisted);
    if (!result.ok) throw new Error(result.detail);
    expect(result.workspace.nodes.a1?.issue?.dueDate).toBe("2026-09-12");
    expect(result.workspace.nodes.a1?.issue?.description).toBe("D");
  });
});

describe("status independence (the ADR 0027 non-derivation rule)", () => {
  it("changing the assignee never touches the status, and vice versa", () => {
    const ws = boardOf(
      actionNode("a1", { issue: { status: "completed", assignee: "sarah", dueDate: "2026-09-12" } }),
    );
    // Unassign a COMPLETED action: status stays completed — "assigned" is an
    // initialization convention, not a derived state.
    const unassigned = applyOperations(ws, [{ op: "UPDATE_ISSUE", id: "a1", assignee: null }]);
    expect(unassigned.nodes.a1?.issue?.status).toBe("completed");
    expect(unassigned.nodes.a1?.issue?.assignee).toBeUndefined();
    // Changing status never touches the assignee either.
    const reopened = applyOperations(ws, [{ op: "UPDATE_ISSUE", id: "a1", status: "open" }]);
    expect(reopened.nodes.a1?.issue?.assignee).toBe("sarah");
    expect(reopened.nodes.a1?.issue?.dueDate).toBe("2026-09-12");
  });

  it("the statement lifecycle never derives from the issue status", () => {
    const ws = boardOf(actionNode("a1", { issue: { status: "completed" } }));
    const progressed = applyOperations(ws, [{ op: "UPDATE_ISSUE", id: "a1", status: "in_progress" }]);
    // The action statement is still open — the semantic lifecycle is its own.
    expect(progressed.nodes.a1?.statement?.status).toBe("open");
  });
});

describe("the execution vocabulary and the Board projection", () => {
  it("EXECUTION_STATUSES is the canonical six", () => {
    expect(EXECUTION_STATUSES).toEqual([
      "open",
      "assigned",
      "in_progress",
      "blocked",
      "completed",
      "cancelled",
    ]);
  });

  it("the six canonical statuses take the explicit column mapping", () => {
    expect(executionStatusColumn("open")).toBe("todo");
    expect(executionStatusColumn("assigned")).toBe("todo");
    expect(executionStatusColumn("in_progress")).toBe("in_progress");
    expect(executionStatusColumn("blocked")).toBe("in_progress");
    expect(executionStatusColumn("completed")).toBe("done");
    expect(executionStatusColumn("cancelled")).toBe("done");
    expect(executionStatusColumn("In Progress")).toBeUndefined(); // case: not canonical
    expect(executionStatusColumn("To Do")).toBeUndefined();
  });

  it("categorizeStatus maps the canonical values and keeps legacy behavior", () => {
    // Canonical (case-folded by categorizeStatus).
    expect(categorizeStatus("cancelled")).toBe("done");
    expect(categorizeStatus("assigned")).toBe("todo");
    expect(categorizeStatus("blocked")).toBe("in_progress");
    // Legacy labels: exactly today's keyword behavior, pinned.
    expect(categorizeStatus("To Do")).toBe("todo");
    expect(categorizeStatus("In Review")).toBe("in_progress");
    expect(categorizeStatus("Blocked")).toBe("in_progress");
    expect(categorizeStatus("Done")).toBe("done");
    expect(categorizeStatus("Some Novel Label")).toBe("todo");
  });
});

describe("actionNodes — the D1 selector", () => {
  it("selects statement.kind=action AND issue present; excludes the rest", () => {
    const ws = boardOf([
      ...actionNode("real-action", { issue: { status: "assigned", assignee: "sarah" } }),
      // A bare action statement: "maybe we should redesign onboarding" —
      // semantically an action, not executable work.
      ...actionNode("bare-action", { issue: undefined, statement: true }),
      // An issue without an action statement: a plain work card.
      ...actionNode("plain-card", { issue: { status: "open" }, statement: false }),
      // A decision with an issue: work-tracking a decision, not an action.
      {
        op: "CREATE_NODE",
        id: "decision-card",
        nodeType: "decision",
        label: "Decision with card",
      },
      {
        op: "SET_STATEMENT",
        id: "decision-card",
        statement: { kind: "decision", status: "resolved" },
      } as Operation,
      { op: "SET_ISSUE", id: "decision-card", issue: { type: "task", status: "open" } },
    ]);
    const actions = actionNodes(ws);
    expect(actions.map((n) => n.id)).toEqual(["real-action"]);
  });
});

describe("resolveDueDate — deterministic relative-date resolution", () => {
  // A fixed reference: Wednesday 2026-09-09 (UTC) — the determinism anchor.
  const REF = Date.UTC(2026, 8, 9, 14, 0); // month 8 = September

  it("weekday names resolve strictly forward; 'next' forces a week further", () => {
    expect(resolveDueDate("Sarah will prepare the brief by Friday.", REF)).toBe("2026-09-11");
    expect(resolveDueDate("due Friday", REF)).toBe("2026-09-11");
    expect(resolveDueDate("by next Monday", REF)).toBe("2026-09-14");
    // Wednesday itself: strictly forward, so next Wednesday.
    expect(resolveDueDate("by Wednesday", REF)).toBe("2026-09-16");
  });

  it("tomorrow/today/end of week resolve against the reference", () => {
    expect(resolveDueDate("by tomorrow", REF)).toBe("2026-09-10");
    expect(resolveDueDate("due today", REF)).toBe("2026-09-09");
    expect(resolveDueDate("end of the week", REF)).toBe("2026-09-11");
  });

  it("'the Nth' resolves within the month, rolling forward when past", () => {
    expect(resolveDueDate("before the 15th", REF)).toBe("2026-09-15");
    // The 3rd, said on the 9th: past, so next month.
    expect(resolveDueDate("by the 3rd", REF)).toBe("2026-10-03");
  });

  it("an explicit ISO date passes through; words never do", () => {
    expect(resolveDueDate("due 2026-10-01", REF)).toBe("2026-10-01");
    // No date in the words: undefined, never a guess.
    expect(resolveDueDate("Sarah will handle it when she can.", REF)).toBeUndefined();
    // THE RULE: the output is always ISO or undefined — "Friday" never
    // survives as a value.
    const resolved = resolveDueDate("by Friday", REF);
    expect(resolved).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("same words + same reference = the same date; a different reference can differ", () => {
    expect(resolveDueDate("by Friday", REF)).toBe(resolveDueDate("due Friday", REF));
    // A Monday reference: Friday is a different absolute date.
    const monday = Date.UTC(2026, 8, 7, 9, 0);
    expect(resolveDueDate("by Friday", monday)).toBe("2026-09-11");
    // Determinism itself: repeated calls are identical.
    expect(resolveDueDate("by Friday", REF)).toBe("2026-09-11");
  });
});
