/**
 * THE ATTENTION LAYER (Phase 3): "What needs my attention?" composed from
 * the existing machinery. Pinned: the four kinds, the evidence pointers
 * (every item names its node; meeting provenance rides along), the
 * per-kind cap (a surface, not a firehose), determinism, and the
 * done-work exclusion.
 */

import { describe, expect, it } from "vitest";
import { applyOperations, needsAttention, type Operation } from "../src/index.js";
import { createWorkspace } from "../src/model.js";

const NOW = Date.parse("2026-09-11T12:00:00Z");

function build(ops: Operation[]) {
  const ws = createWorkspace({ diagramKind: "flowchart" });
  return applyOperations(ws, ops);
}

/** An executable action: the E1 rule — action statement + issue fields. */
function action(id: string, label: string, issue: Record<string, unknown>): Operation[] {
  return [
    { op: "CREATE_NODE", id, nodeType: "action", label },
    { op: "SET_STATEMENT", id, statement: { kind: "action", status: "open" } },
    { op: "SET_ISSUE", id, issue } as Operation,
  ];
}

describe("needsAttention", () => {
  it("an empty board needs nothing", () => {
    const r = needsAttention(createWorkspace(), NOW);
    expect(r.items).toEqual([]);
    expect(r.counts).toEqual({ blocked: 0, overdue: 0, openDecision: 0, newStatement: 0 });
  });

  it("a blocked action names its node and why", () => {
    const ws = build(action("a", "Ship SSO", { type: "task", status: "blocked" }));
    const r = needsAttention(ws, NOW);
    expect(r.counts.blocked).toBe(1);
    const item = r.items.find((i) => i.kind === "blocked")!;
    expect(item.nodeId).toBe("a");
    expect(item.label).toBe("Ship SSO");
    expect(item.reason).toBe("marked blocked");
  });

  it("an overdue action carries its due date; done work carries no trouble", () => {
    const ws = build([
      ...action("late", "Late", { type: "task", status: "in_progress", dueDate: "2026-09-01" }),
      ...action("done", "Done thing", {
        type: "task",
        status: "completed",
        statusCategory: "done",
        dueDate: "2026-09-01",
      }),
    ]);
    const r = needsAttention(ws, NOW);
    expect(r.counts.overdue).toBe(1);
    const item = r.items.find((i) => i.kind === "overdue")!;
    expect(item.nodeId).toBe("late");
    expect(item.reason).toBe("due 2026-09-01");
    // Done work is excluded even though its due date is past.
    expect(r.items.some((i) => i.nodeId === "done")).toBe(false);
  });

  it("an open decision is a pending judgment call, with its meeting when it has one", () => {
    const ws = build([
      { op: "CREATE_NODE", id: "dec", nodeType: "decision", label: "Pricing model" },
      {
        op: "SET_STATEMENT",
        id: "dec",
        // Provenance nests INSIDE the statement (the E3 contract).
        statement: { kind: "decision", status: "open", provenance: { meetingId: "mtg_9" } },
      },
    ]);
    const r = needsAttention(ws, NOW);
    expect(r.counts.openDecision).toBe(1);
    const item = r.items.find((i) => i.kind === "openDecision")!;
    expect(item.nodeId).toBe("dec");
    expect(item.meetingId).toBe("mtg_9");
  });

  it("statements from meetings surface as new, meeting provenance attached", () => {
    const ws = build([
      { op: "CREATE_NODE", id: "st", nodeType: "requirement", label: "Support SSO" },
      {
        op: "SET_STATEMENT",
        id: "st",
        statement: {
          kind: "requirement",
          status: "open",
          provenance: { meetingId: "mtg_3" },
        },
      },
    ]);
    const r = needsAttention(ws, NOW);
    expect(r.counts.newStatement).toBe(1);
    expect(r.items[0]!.meetingId).toBe("mtg_3");
  });

  it("the cap holds: a surface, not a firehose", () => {
    const ops: Operation[] = [];
    for (let i = 0; i < 20; i++) {
      ops.push(...action(`b${i}`, `Blocked ${i}`, { type: "task", status: "blocked" }));
    }
    const r = needsAttention(build(ops), NOW);
    expect(r.counts.blocked).toBe(20); // the COUNT is honest
    expect(r.items.filter((i) => i.kind === "blocked").length).toBe(8); // the LIST is capped
  });

  it("deterministic: the same board yields the same list", () => {
    const ops = action("a", "A", { type: "task", status: "blocked" });
    expect(needsAttention(build(ops), NOW)).toEqual(needsAttention(build(ops), NOW));
  });
});
