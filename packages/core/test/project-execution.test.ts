import { describe, expect, it } from "vitest";
import {
  applyOperations,
  createWorkspace,
  projectExecution,
  stampAuthorship,
  type Operation,
} from "../src/index.js";

/**
 * A project's execution across its boards (docs/26 §8): progress, each
 * workstream, and every blocker as a story — what it waits on and who owns
 * each step, the decision that drove it, the meeting turns behind that.
 */

const NOW = new Date(2026, 8, 27, 12, 0).getTime();

function board(ops: Operation[]) {
  return applyOperations(createWorkspace(), stampAuthorship(ops, "u"));
}
const action = (
  id: string,
  fields: { status?: string; assignee?: string; dueDate?: string; meetingId?: string } = {},
): Operation[] => [
  {
    op: "CREATE_NODE",
    id,
    nodeType: "process",
    label: id.replace(/-/g, " "),
    ...(fields.meetingId ? { provenance: { meetingId: fields.meetingId, turnRange: [2, 4] } } : {}),
  } as Operation,
  { op: "SET_STATEMENT", id, statement: { kind: "action", status: "open" } } as Operation,
  {
    op: "SET_ISSUE",
    id,
    issue: {
      type: "task",
      status: fields.status ?? "open",
      ...(fields.assignee ? { assignee: fields.assignee } : {}),
      ...(fields.dueDate ? { dueDate: fields.dueDate } : {}),
    },
  } as Operation,
];

describe("projectExecution", () => {
  it("sums progress across boards and by workstream", () => {
    const a = board([
      ...action("design", { status: "completed" }),
      ...action("build"),
      { op: "CREATE_GROUP", id: "g1", label: "Launch", children: ["design", "build"] } as Operation,
      ...action("loose-end"),
    ]);
    const b = board([...action("announce", { status: "completed" })]);
    const out = projectExecution(
      [
        { id: "A", name: "Plan", workspace: a },
        { id: "B", name: "Comms", workspace: b },
      ],
      NOW,
    );
    expect(out.rollup).toMatchObject({ total: 4, completed: 2, percent: 50 });
    expect(out.workstreams.map((w) => [w.label, w.completed, w.total])).toEqual([
      ["Launch", 1, 2],
      ["Plan — outside any workstream", 0, 1],
      ["Comms", 1, 1],
    ]);
  });

  it("tells each blocker as a story: what it waits on, who owns it, why it exists", () => {
    const ws = board([
      {
        op: "CREATE_NODE",
        id: "go-annual",
        nodeType: "process",
        label: "Offer annual plans",
        provenance: { meetingId: "mtg_9", turnRange: [5, 6] },
      } as Operation,
      {
        op: "SET_STATEMENT",
        id: "go-annual",
        statement: { kind: "decision", status: "resolved" },
      } as Operation,
      ...action("pricing-page", { status: "blocked", assignee: "Ada" }),
      ...action("billing-change", { assignee: "Bo", meetingId: "mtg_1" }),
      {
        op: "CONNECT_NODES",
        source: "billing-change",
        target: "pricing-page",
        relationship: "depends_on",
      } as Operation,
      {
        op: "CONNECT_NODES",
        source: "go-annual",
        target: "billing-change",
        relationship: "drives",
      } as Operation,
    ]);
    const out = projectExecution([{ id: "A", name: "Plan", workspace: ws }], NOW);
    const story = out.blockers.find((b) => b.target.id === "billing-change")!;
    expect(story.target).toMatchObject({ owner: "Bo" });
    expect(story.waitsOn).toEqual([
      expect.objectContaining({ id: "pricing-page", owner: "Ada", status: "blocked" }),
    ]);
    expect(story.decisions).toEqual([
      {
        id: "go-annual",
        label: "Offer annual plans",
        evidence: { meetingId: "mtg_9", turnRange: [5, 6] },
      },
    ]);
    expect(story.evidence).toEqual({ meetingId: "mtg_1", turnRange: [2, 4] });
    // Work blocked by hand is a blocker too, with nothing behind it.
    expect(out.blockers.find((b) => b.target.id === "pricing-page")!.waitsOn).toEqual([]);
  });

  it("lists late work, oldest first, and never finished work", () => {
    const ws = board([
      ...action("late", { dueDate: "2026-09-01", assignee: "Ada" }),
      ...action("later", { dueDate: "2026-09-20" }),
      ...action("done-late", { dueDate: "2026-09-01", status: "completed" }),
      ...action("future", { dueDate: "2026-12-01" }),
    ]);
    const out = projectExecution([{ id: "A", name: "Plan", workspace: ws }], NOW);
    expect(out.overdue.map((o) => [o.id, o.owner ?? null])).toEqual([
      ["late", "Ada"],
      ["later", null],
    ]);
  });
});
