import { describe, it, expect } from "vitest";
import { applyOperations, createWorkspace, type Operation } from "@lucent/core";
import {
  BRIEF_ORDER,
  TOPIC_BREAK_LINE,
  citationTurns,
  formatElapsed,
  meetingBrief,
  speakersOf,
} from "../src/meetingBrief.js";

/**
 * The meeting brief: the statements a meeting produced, grouped by kind and
 * ordered by the turn they were first heard at — read off the board, never
 * generated. What's under test:
 *
 * - GROUPING in the brief's reading order (decisions, actions, questions,
 *   risks, proposals, requirements), empty kinds omitted.
 * - ORDERING by first turn; range-less statements after, in board order.
 * - BOTH PROVENANCE LOCATIONS count (node.provenance and
 *   node.statement.provenance), the statement's own evidence preferred.
 * - ISOLATION: another meeting's statements, and plain nodes, never appear.
 * - THE LIVE PLACEHOLDER: "live-session" has no stored transcript, so a
 *   stamp only counts when its quote matches the caller's live turns.
 */

function board(ops: Operation[]) {
  return applyOperations(createWorkspace(), ops);
}

const statementNode = (
  id: string,
  kind: "decision" | "proposal" | "question" | "action" | "requirement" | "risk",
  meetingId: string,
  turnRange?: [number, number],
  extra: Partial<{ status: "open" | "resolved" | "rejected" | "superseded"; quote: string }> = {},
): Operation[] => [
  {
    op: "CREATE_NODE",
    id,
    nodeType: kind,
    label: `${kind} ${id}`,
  },
  {
    op: "SET_STATEMENT",
    id,
    statement: {
      kind,
      status: extra.status ?? "open",
      provenance: {
        meetingId,
        ...(turnRange ? { turnRange } : {}),
        ...(extra.quote ? { quote: extra.quote } : {}),
      },
    },
  },
];

describe("meetingBrief", () => {
  it("groups statements by kind in reading order and omits empty kinds", () => {
    const ws = board([
      ...statementNode("r1", "risk", "mtg_1", [5, 5]),
      ...statementNode("q1", "question", "mtg_1", [3, 3]),
      ...statementNode("a1", "action", "mtg_1", [2, 2]),
      ...statementNode("d1", "decision", "mtg_1", [1, 1], { status: "resolved" }),
    ]);
    const brief = meetingBrief(ws, { id: "mtg_1" });
    expect(brief.sections.map((s) => s.kind)).toEqual(["decision", "action", "question", "risk"]);
    expect(brief.total).toBe(4);
    expect(brief.provisional).toBe(false);
    expect(brief.sections[0]!.items[0]).toMatchObject({
      nodeId: "d1",
      kind: "decision",
      status: "resolved",
      label: "decision d1",
      turnRange: [1, 1],
    });
    // The order constant is the contract the view renders headings from.
    expect(BRIEF_ORDER).toEqual([
      "decision",
      "action",
      "question",
      "risk",
      "proposal",
      "requirement",
    ]);
  });

  it("orders items by first turn, range-less items last in board order", () => {
    const ws = board([
      ...statementNode("late", "decision", "mtg_1", [9, 10]),
      ...statementNode("whole-a", "decision", "mtg_1"),
      ...statementNode("early", "decision", "mtg_1", [2, 4]),
      ...statementNode("whole-b", "decision", "mtg_1"),
      ...statementNode("tie", "decision", "mtg_1", [2, 3]),
    ]);
    const ids = meetingBrief(ws, { id: "mtg_1" }).sections[0]!.items.map((i) => i.nodeId);
    expect(ids).toEqual(["tie", "early", "late", "whole-a", "whole-b"]);
  });

  it("reads provenance from the node's creation record too", () => {
    const ws = board([
      {
        op: "CREATE_NODE",
        id: "created",
        nodeType: "action",
        label: "Draft onboarding flow",
        provenance: { meetingId: "mtg_1", turnRange: [4, 6], quote: "Sam will draft it" },
      },
      {
        op: "SET_ISSUE",
        id: "created",
        issue: {
          type: "task",
          status: "assigned",
          statusCategory: "todo",
          assignee: "Sam",
          dueDate: "2026-09-30",
        },
      },
      { op: "SET_STATEMENT", id: "created", statement: { kind: "action", status: "open" } },
    ]);
    const [item] = meetingBrief(ws, { id: "mtg_1" }).sections[0]!.items;
    expect(item).toEqual({
      nodeId: "created",
      kind: "action",
      status: "open",
      label: "Draft onboarding flow",
      assignee: "Sam",
      dueDate: "2026-09-30",
      turnRange: [4, 6],
      quote: "Sam will draft it",
    });
  });

  it("prefers the statement's own evidence over the creation record", () => {
    const ws = board([
      {
        op: "CREATE_NODE",
        id: "n",
        nodeType: "decision",
        label: "Use Stripe",
        provenance: { meetingId: "mtg_1", turnRange: [0, 8], quote: "whole batch" },
      },
      {
        op: "SET_STATEMENT",
        id: "n",
        statement: {
          kind: "decision",
          status: "resolved",
          provenance: { meetingId: "mtg_1", turnRange: [3, 3], quote: "we'll use Stripe" },
        },
      },
    ]);
    const [item] = meetingBrief(ws, { id: "mtg_1" }).sections[0]!.items;
    expect(item!.turnRange).toEqual([3, 3]);
    expect(item!.quote).toBe("we'll use Stripe");
  });

  it("excludes other meetings' statements and plain nodes", () => {
    const ws = board([
      ...statementNode("mine", "decision", "mtg_1", [0, 0]),
      ...statementNode("theirs", "decision", "mtg_2", [0, 0]),
      {
        op: "CREATE_NODE",
        id: "plain",
        nodeType: "process",
        label: "No statement",
        provenance: { meetingId: "mtg_1", turnRange: [0, 0] },
      },
    ]);
    const brief = meetingBrief(ws, { id: "mtg_1" });
    expect(brief.total).toBe(1);
    expect(brief.sections[0]!.items.map((i) => i.nodeId)).toEqual(["mine"]);
    expect(meetingBrief(ws, { id: "mtg_2" }).sections[0]!.items[0]!.nodeId).toBe("theirs");
  });

  it("ignores statements that came from the board conversation, not a meeting", () => {
    // ADR 0042: chat-born statements carry provenance.conversation and no
    // meetingId. They are real, but no meeting said them.
    const ws = board([
      {
        op: "CREATE_NODE",
        id: "chat-decision",
        nodeType: "decision",
        label: "Use Stripe for payments",
        provenance: { conversation: { at: 1_790_000_000_000, by: "Test User" } },
      },
      {
        op: "SET_STATEMENT",
        id: "chat-decision",
        statement: {
          kind: "decision",
          status: "resolved",
          provenance: { conversation: { at: 1_790_000_000_000 } },
        },
      },
      ...statementNode("meeting-decision", "decision", "mtg_1", [0, 0]),
    ]);
    const brief = meetingBrief(ws, { id: "mtg_1" });
    expect(brief.sections.flatMap((s) => s.items.map((i) => i.nodeId))).toEqual([
      "meeting-decision",
    ]);
  });

  it("is empty for a meeting nothing cites, and for an empty board", () => {
    expect(meetingBrief(createWorkspace(), { id: "mtg_1" })).toEqual({
      meetingId: "mtg_1",
      provisional: false,
      sections: [],
      total: 0,
    });
    const ws = board(statementNode("d", "decision", "mtg_1", [0, 0]));
    expect(meetingBrief(ws, { id: "mtg_9" }).total).toBe(0);
  });

  it("keeps only superseded ids that still exist on the board", () => {
    const ws = board([
      ...statementNode("old", "decision", "mtg_1", [0, 0]),
      {
        op: "CREATE_NODE",
        id: "new",
        nodeType: "decision",
        label: "New call",
      },
      {
        op: "SET_STATEMENT",
        id: "new",
        statement: {
          kind: "decision",
          status: "resolved",
          supersedes: ["old"],
          provenance: { meetingId: "mtg_1", turnRange: [2, 2] },
        },
      },
    ]);
    const items = meetingBrief(ws, { id: "mtg_1" }).sections[0]!.items;
    expect(items.map((i) => [i.nodeId, i.status])).toEqual([
      ["old", "superseded"],
      ["new", "resolved"],
    ]);
    expect(items[1]!.supersedes).toEqual(["old"]);
    expect(items[0]!.supersedes).toBeUndefined();
  });

  it("clamps turn ranges to the transcript the caller holds", () => {
    const ws = board([
      ...statementNode("inside", "decision", "mtg_1", [1, 7]),
      ...statementNode("past", "decision", "mtg_1", [12, 13]),
    ]);
    const turns = Array.from({ length: 4 }, (_, i) => ({ text: `turn ${i}` }));
    const items = meetingBrief(ws, { id: "mtg_1", turns }).sections[0]!.items;
    expect(items.find((i) => i.nodeId === "inside")!.turnRange).toEqual([1, 3]);
    // A range past the end cannot be cited — the item stays, the pill goes.
    expect(items.find((i) => i.nodeId === "past")!.turnRange).toBeUndefined();
  });

  describe("the live-session placeholder", () => {
    const turns = [
      { text: "Let's use Stripe for payments." },
      { text: "Sam, can you draft the onboarding flow?" },
    ];

    it("attributes nothing without the live turns to check against", () => {
      const ws = board(
        statementNode("d", "decision", "live-session", [0, 0], {
          quote: "Let's use Stripe for payments.",
        }),
      );
      const brief = meetingBrief(ws, { id: "live-session" });
      expect(brief.total).toBe(0);
      expect(brief.provisional).toBe(true);
    });

    it("keeps stamps whose quote matches the live turns, drops stale ones", () => {
      const ws = board([
        ...statementNode("this-capture", "decision", "live-session", [0, 1], {
          quote: "Let's use Stripe for payments. Sam, can you draft the onboarding flow?",
        }),
        ...statementNode("after-break", "action", "live-session", [1, 1], {
          quote: `${TOPIC_BREAK_LINE} Sam, can you draft the onboarding flow?`,
        }),
        // An earlier capture also stamped "live-session" at turn 0.
        ...statementNode("stale", "decision", "live-session", [0, 0], {
          quote: "Pricing stays per seat.",
        }),
        ...statementNode("no-quote", "risk", "live-session", [0, 0]),
      ]);
      const brief = meetingBrief(ws, { id: "live-session", turns });
      expect(brief.provisional).toBe(true);
      expect(brief.sections.flatMap((s) => s.items.map((i) => i.nodeId))).toEqual([
        "this-capture",
        "after-break",
      ]);
    });

    it("never lets a saved meeting claim live-session stamps", () => {
      const ws = board(
        statementNode("d", "decision", "live-session", [0, 0], { quote: turns[0]!.text }),
      );
      expect(meetingBrief(ws, { id: "mtg_1", turns }).total).toBe(0);
    });
  });
});

describe("brief helpers", () => {
  it("lists speakers once, in order of first appearance", () => {
    expect(
      speakersOf([
        { speaker: "Sam" },
        { speaker: "You" },
        { speaker: "Sam" },
        { speaker: "  " },
        { speaker: "Riley" },
      ]),
    ).toEqual(["Sam", "You", "Riley"]);
  });

  it("formats elapsed time as a transcript stamp", () => {
    expect(formatElapsed(0)).toBe("00:00");
    expect(formatElapsed(247_000)).toBe("04:07");
    expect(formatElapsed(3_729_000)).toBe("1:02:09");
    expect(formatElapsed(-5)).toBe("00:00");
  });

  it("prints one pill per turn for short ranges and a span for long ones", () => {
    expect(citationTurns([3, 5])).toEqual({ kind: "turns", turns: [3, 4, 5] });
    expect(citationTurns([0, 39])).toEqual({ kind: "span", from: 0, to: 39 });
  });
});
