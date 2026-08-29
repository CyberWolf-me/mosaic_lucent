import { describe, it, expect } from "vitest";
import {
  applyOperations,
  createWorkspace,
  validateOperations,
  categorizeStatus,
  boardColumns,
  pointsByCategory,
  issueNodes,
  inverseOperations,
  type Operation,
} from "../src/index.js";

function board() {
  return applyOperations(createWorkspace({ diagramKind: "flowchart" }), [
    { op: "CREATE_NODE", id: "epic", nodeType: "task", label: "Checkout redesign" },
    { op: "CREATE_NODE", id: "s1", nodeType: "task", label: "Guest checkout" },
    { op: "CREATE_NODE", id: "s2", nodeType: "task", label: "PayPal" },
  ]);
}

describe("categorizeStatus", () => {
  it("maps common statuses onto the three columns", () => {
    expect(categorizeStatus("To Do")).toBe("todo");
    expect(categorizeStatus("Backlog")).toBe("todo");
    expect(categorizeStatus("In Progress")).toBe("in_progress");
    expect(categorizeStatus("In Review")).toBe("in_progress");
    expect(categorizeStatus("Blocked")).toBe("in_progress");
    expect(categorizeStatus("Done")).toBe("done");
    expect(categorizeStatus("Shipped")).toBe("done");
  });
  it("defaults an unknown status to todo", () => {
    expect(categorizeStatus("Wishlist")).toBe("todo");
  });
});

describe("SET_ISSUE", () => {
  it("attaches issue fields and derives the column from status", () => {
    const ws = applyOperations(board(), [
      { op: "SET_ISSUE", id: "s1", issue: { type: "story", status: "In Review" } },
    ]);
    expect(ws.nodes.s1!.issue!.type).toBe("story");
    expect(ws.nodes.s1!.issue!.statusCategory).toBe("in_progress");
  });
  it("honours an explicit statusCategory over the derived one", () => {
    const ws = applyOperations(board(), [
      {
        op: "SET_ISSUE",
        id: "s1",
        issue: { type: "story", status: "Custom", statusCategory: "done" },
      },
    ]);
    expect(ws.nodes.s1!.issue!.statusCategory).toBe("done");
  });
  it("clears issue fields with issue:null", () => {
    let ws = applyOperations(board(), [
      { op: "SET_ISSUE", id: "s1", issue: { type: "story", status: "To Do" } },
    ]);
    ws = applyOperations(ws, [{ op: "SET_ISSUE", id: "s1", issue: null }]);
    expect(ws.nodes.s1!.issue).toBeUndefined();
  });
  it("rejects a parent that does not exist", () => {
    const errs = validateOperations(board(), [
      { op: "SET_ISSUE", id: "s1", issue: { type: "subtask", status: "To Do", parentId: "ghost" } },
    ]);
    expect(errs.length).toBeGreaterThan(0);
  });
});

describe("UPDATE_ISSUE", () => {
  const base = () =>
    applyOperations(board(), [
      {
        op: "SET_ISSUE",
        id: "s1",
        issue: { type: "story", status: "To Do", assignee: "sam", storyPoints: 5 },
      },
    ]);
  it("moves a card between columns", () => {
    const ws = applyOperations(base(), [{ op: "UPDATE_ISSUE", id: "s1", status: "In Progress" }]);
    expect(ws.nodes.s1!.issue!.statusCategory).toBe("in_progress");
  });
  it("clears a field with null and leaves others untouched", () => {
    const ws = applyOperations(base(), [{ op: "UPDATE_ISSUE", id: "s1", assignee: null }]);
    expect(ws.nodes.s1!.issue!.assignee).toBeUndefined();
    expect(ws.nodes.s1!.issue!.storyPoints).toBe(5);
  });
  it("does nothing to a node with no issue", () => {
    const ws = applyOperations(board(), [{ op: "UPDATE_ISSUE", id: "s2", status: "Done" }]);
    expect(ws.nodes.s2!.issue).toBeUndefined();
  });
});

describe("board helpers", () => {
  const ws = () =>
    applyOperations(board(), [
      {
        op: "SET_ISSUE",
        id: "epic",
        issue: { type: "epic", status: "In Progress", storyPoints: 0 },
      },
      { op: "SET_ISSUE", id: "s1", issue: { type: "story", status: "To Do", storyPoints: 3 } },
      { op: "SET_ISSUE", id: "s2", issue: { type: "story", status: "Done", storyPoints: 8 } },
    ]);
  it("groups issue nodes into columns", () => {
    const cols = boardColumns(ws());
    expect(cols.todo.map((n) => n.id)).toEqual(["s1"]);
    expect(cols.in_progress.map((n) => n.id)).toEqual(["epic"]);
    expect(cols.done.map((n) => n.id)).toEqual(["s2"]);
  });
  it("sums story points per column", () => {
    expect(pointsByCategory(ws())).toEqual({ todo: 3, in_progress: 0, done: 8 });
  });
  it("issueNodes ignores plain diagram nodes", () => {
    const mixed = applyOperations(board(), [
      { op: "SET_ISSUE", id: "s1", issue: { type: "story", status: "To Do" } },
    ]);
    expect(issueNodes(mixed).map((n) => n.id)).toEqual(["s1"]);
  });
});

describe("issue undo", () => {
  it("SET_ISSUE inverse clears an issue that wasn't there before", () => {
    const before = board();
    const ops: Operation[] = [
      { op: "SET_ISSUE", id: "s1", issue: { type: "story", status: "To Do" } },
    ];
    const after = applyOperations(before, ops);
    const undone = applyOperations(after, inverseOperations(ops, before));
    expect(undone.nodes.s1!.issue).toBeUndefined();
  });
  it("UPDATE_ISSUE inverse restores the prior status", () => {
    const before = applyOperations(board(), [
      { op: "SET_ISSUE", id: "s1", issue: { type: "story", status: "To Do" } },
    ]);
    const ops: Operation[] = [{ op: "UPDATE_ISSUE", id: "s1", status: "Done" }];
    const after = applyOperations(before, ops);
    expect(after.nodes.s1!.issue!.statusCategory).toBe("done");
    const undone = applyOperations(after, inverseOperations(ops, before));
    expect(undone.nodes.s1!.issue!.status).toBe("To Do");
    expect(undone.nodes.s1!.issue!.statusCategory).toBe("todo");
  });
});
