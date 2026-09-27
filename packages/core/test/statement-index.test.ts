import { describe, expect, it } from "vitest";
import type { Operation } from "../src/model.js";
import {
  applyOperations,
  createWorkspace,
  isBlockedRow,
  stampAuthorship,
  statementRows,
} from "../src/index.js";

/**
 * The one statement derivation (docs/26 J3, ADR 0046): the board's own
 * Intelligence view and the workspace index both read these rows, so what a
 * board shows and what the workspace shows can't disagree. Rows follow from
 * the board alone — nothing in them depends on what day it is.
 */

function board(ops: Operation[]) {
  return applyOperations(createWorkspace(), stampAuthorship(ops, "test-user"));
}

function statement(id: string, kind: string, status = "open", extra: object = {}): Operation[] {
  return [
    { op: "CREATE_NODE", id, nodeType: kind === "question" ? "question" : "process", label: id },
    { op: "SET_STATEMENT", id, statement: { kind, status, ...extra } } as Operation,
  ];
}

function work(id: string, fields: { status?: string; dueDate?: string; assignee?: string } = {}) {
  return [
    ...statement(id, "action"),
    {
      op: "SET_ISSUE",
      id,
      issue: {
        type: "task",
        status: fields.status ?? "open",
        ...(fields.dueDate ? { dueDate: fields.dueDate } : {}),
        ...(fields.assignee ? { assignee: fields.assignee } : {}),
      },
    } as Operation,
  ];
}

describe("statementRows", () => {
  it("lists every statement, and nothing that isn't one", () => {
    const ws = board([
      ...statement("ship-friday", "decision", "resolved", { topic: "pricing" }),
      ...statement("grandfather", "question"),
      { op: "CREATE_NODE", id: "plain", nodeType: "process", label: "just a box" },
    ]);
    const rows = statementRows(ws);
    expect(rows.map((r) => [r.id, r.kind, r.status])).toEqual([
      ["ship-friday", "decision", "resolved"],
      ["grandfather", "question", "open"],
    ]);
    expect(rows[0]!.topic).toBe("pricing");
  });

  it("carries the work fields when the statement is also an issue", () => {
    const ws = board(work("rollout", { assignee: "Alice", dueDate: "2026-10-01" }));
    expect(statementRows(ws)[0]).toMatchObject({
      assignee: "Alice",
      dueDate: "2026-10-01",
      executionStatus: "open",
    });
  });

  it("knows blocked work, directly and through what it waits on", () => {
    const ws = board([
      ...work("design", { status: "blocked" }),
      ...work("build"),
      { op: "CONNECT_NODES", source: "build", target: "design", relationship: "depends_on" },
    ]);
    const byId = new Map(statementRows(ws).map((r) => [r.id, r]));
    expect(isBlockedRow(byId.get("design")!)).toBe(true);
    expect(byId.get("build")!.blockedBy).toEqual(["design"]);
    expect(isBlockedRow(byId.get("build")!)).toBe(true);
  });

  it("counts the actions a decision drives", () => {
    const ws = board([
      ...statement("go-annual", "decision", "resolved"),
      ...work("update-billing"),
      {
        op: "CONNECT_NODES",
        source: "go-annual",
        target: "update-billing",
        relationship: "drives",
      },
    ]);
    expect(statementRows(ws).find((r) => r.id === "go-annual")!.drivesActions).toBe(1);
  });

  it("doesn't depend on the calendar: an old due date is not flagged here", () => {
    const ws = board(work("late", { dueDate: "2000-01-01" }));
    const row = statementRows(ws)[0]!;
    expect(row).not.toHaveProperty("atRiskBy");
    expect(isBlockedRow(row)).toBe(false);
  });
});
