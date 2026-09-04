import { describe, it, expect } from "vitest";
import { applyOperations, createWorkspace } from "@lucent/core";
import type { Operation } from "@lucent/core";
import { buildAnswerRequest, renderBoardDigest, projectMeetings } from "../src/askContext.js";
import type { LoggedOpEntry } from "../src/boards.js";
import type { MeetingTranscript } from "../src/meetings.js";

/**
 * The Ask context projection (Stage C1). The projection is the only code that
 * decides what the model may see, so the tests are the security boundary's
 * unit tests:
 *
 * - CONTEXT SCOPE (review amendment 2): a 30-entry Free board produces a
 *   digest whose history cites exactly the latest 25 — the entitlement
 *   reached the model's context or it reached nowhere.
 * - The board digest carries provenance (the thing Build's summary omits)
 *   and renders hostile metadata inertly.
 * - Meetings project classified turns only.
 * - Truncation honesty: historyTruncated is exactly the route's hasMore.
 */

const T0 = Date.UTC(2026, 8, 2, 9, 0);

function entry(seq: number, label: string, actorType: "user" | "ai" | "system" = "user"): LoggedOpEntry {
  const ops: Operation[] = [{ op: "CREATE_NODE", id: `n${seq}`, nodeType: "step", label: `N${seq}` }];
  return {
    seq,
    ops,
    by: `usr_${seq}`,
    label,
    at: T0 + seq * 60_000,
    actor: { actorType, actorId: `usr_${seq}`, initiatedBy: `usr_${seq}` },
  };
}

function baseInput(overrides: Record<string, unknown> = {}) {
  const ws = applyOperations(createWorkspace(), [
    { op: "CREATE_NODE", id: "pricing", nodeType: "decision", label: "Pricing ($15/month)" },
  ]);
  return {
    question: "what changed?",
    boardName: "Q3 launch",
    workspace: ws,
    log: [entry(42, "proposal approved"), entry(41, "added pricing region")],
    actorNames: new Map([["usr_42", "Sarah"], ["usr_41", "Alex"]]),
    meetings: [] as MeetingTranscript[],
    window: { depth: 25, hasMore: false },
    ...overrides,
  };
}

describe("buildAnswerRequest: the context-scope guarantee", () => {
  it("carries exactly the log the route passed — 30 entries in, the same 30 out", () => {
    // The projection itself never widens; the ROUTE does the windowing (see
    // ask-route tests for the 30→25 cut). What is asserted here is that what
    // the route hands over is what the model gets, no more.
    const log = Array.from({ length: 30 }, (_, i) => entry(30 - i, `rev ${30 - i}`)).reverse();
    const request = buildAnswerRequest(baseInput({ log: [...log].reverse() }));
    expect(request.history.map((h) => h.seq)).toEqual(Array.from({ length: 30 }, (_, i) => 30 - i));
  });

  it("marks the context truncated exactly when the route says so", () => {
    const truncated = buildAnswerRequest(baseInput({ window: { depth: 25, hasMore: true } }));
    expect(truncated.historyTruncated).toBe(true);
    expect(truncated.historyDepth).toBe(25);

    const full = buildAnswerRequest(baseInput({ window: { depth: null, hasMore: false } }));
    expect(full.historyTruncated).toBe(false);
    expect(full.historyDepth).toBeNull();
  });

  it("resolves actor display names and marks AI actors as Lucent", () => {
    const log = [
      entry(42, "proposal approved", "ai"),
      { ...entry(41, "added pricing region"), actor: { actorType: "ai", actorId: "lucent", initiatedBy: "usr_41", approvedBy: "usr_42" } },
    ];
    const request = buildAnswerRequest(baseInput({ log }));
    expect(request.history[0]).toMatchObject({ seq: 42, actorName: "Lucent", actorType: "ai" });
    expect(request.history[1]).toMatchObject({ seq: 41, actorName: "Lucent", actorType: "ai" });
  });

  it("carries the question through untouched", () => {
    const request = buildAnswerRequest(baseInput({ question: "who moved the pricing node?" }));
    expect(request.question).toBe("who moved the pricing node?");
  });
});

describe("renderBoardDigest: provenance is the point", () => {
  it("renders a node's meeting provenance with quote and stable turn range", () => {
    const ws = applyOperations(createWorkspace(), [
      { op: "CREATE_NODE", id: "pricing", nodeType: "decision", label: "Pricing ($15/month)" },
    ]);
    ws.nodes.pricing!.metadata = {
      meeting: {
        meetingId: "mtg_7",
        quote: "Let's price it at $15/month.",
        extractedAt: T0,
        turnRange: [4, 6],
        turnKinds: ["decision"],
      },
    };
    const digest = renderBoardDigest(baseInput({ workspace: ws }));
    expect(digest).toContain("pricing (decision): Pricing ($15/month)");
    expect(digest).toContain("[from meeting mtg_7 turns 4–6: \"Let's price it at $15/month.\"]");
  });

  it("renders hostile metadata inertly rather than crashing", () => {
    const ws = applyOperations(createWorkspace(), [
      { op: "CREATE_NODE", id: "evil", nodeType: "step", label: "Evil" },
    ]);
    ws.nodes.evil!.metadata = {
      meeting: { meetingId: { toString: () => "boom" }, quote: 42, turnRange: "nope" },
    };
    const digest = renderBoardDigest(baseInput({ workspace: ws }));
    // No throw; the junk fields are dropped, the id object degrades to "?".
    expect(digest).toContain("[from meeting ?]");
  });

  it("includes work-tracking fields so 'who owns the actions?' answers", () => {
    const ws = applyOperations(createWorkspace(), [
      { op: "CREATE_NODE", id: "brief", nodeType: "task", label: "Launch brief" },
      {
        op: "SET_ISSUE",
        id: "brief",
        issue: { type: "task", status: "In Progress", statusCategory: "in_progress", assignee: "Sarah" },
      },
    ]);
    const digest = renderBoardDigest(baseInput({ workspace: ws }));
    expect(digest).toContain("[issue: task · In Progress · @Sarah]");
  });
});

describe("projectMeetings: classified turns only", () => {
  it("keeps classified turns and drops unclassified chatter", () => {
    const meeting: MeetingTranscript = {
      id: "mtg_7",
      boardId: "brd_1",
      orgId: "org_1",
      startedAt: T0,
      endedAt: T0 + 3600_000,
      turns: [
        { speaker: "Alex", at: T0, text: "Hi everyone." },
        { speaker: "Sarah", at: T0 + 60_000, text: "Let's price it at $15/month.", kind: "decision" },
        { speaker: "Alex", at: T0 + 120_000, text: "I'll prepare the brief.", kind: "action" },
        { speaker: "Sarah", at: T0 + 180_000, text: "Weather looks nice today." },
      ],
      createdBy: null,
      createdAt: T0,
    };
    const projected = projectMeetings([meeting]);
    expect(projected).toHaveLength(1);
    expect(projected[0]!.turns.map((t) => t.kind)).toEqual(["decision", "action"]);
    expect(projected[0]!.speakers).toEqual(["Alex", "Sarah"]);
  });

  it("caps meetings and turn text", () => {
    const many = Array.from({ length: 15 }, (_, i) => ({
      id: `mtg_${i}`,
      boardId: "brd_1",
      orgId: "org_1",
      startedAt: T0 + i,
      endedAt: null,
      turns: [
        { speaker: "A", at: T0, text: "x".repeat(2000), kind: "decision" as const },
      ],
      createdBy: null,
      createdAt: T0,
    }));
    const projected = projectMeetings(many);
    expect(projected).toHaveLength(10);
    expect(projected[0]!.turns[0]!.text.length).toBe(400);
  });
});

describe("the projection stays a projection", () => {
  it("is deterministic — same inputs, byte-identical request", () => {
    const input = baseInput();
    expect(buildAnswerRequest(input)).toEqual(buildAnswerRequest(input));
  });

  it("never invents nodes the board does not carry", () => {
    const request = buildAnswerRequest(baseInput());
    expect(request.nodeIndex).toEqual([{ id: "pricing", label: "Pricing ($15/month)" }]);
    // And the digest's provenance comes from metadata, not from the meetings
    // list: a meeting with no stamped node renders in the meetings section,
    // not as board state.
    const meeting: MeetingTranscript = {
      id: "mtg_9",
      boardId: "brd_1",
      orgId: "org_1",
      startedAt: T0,
      endedAt: null,
      turns: [{ speaker: "A", at: T0, text: "Add a risk register.", kind: "requirement" }],
      createdBy: null,
      createdAt: T0,
    };
    const withMeeting = buildAnswerRequest(baseInput({ meetings: [meeting] }));
    expect(withMeeting.nodeIndex).toEqual(request.nodeIndex);
    expect(withMeeting.meetings[0]!.id).toBe("mtg_9");
  });
});

describe("renderBoardDigest: statements and op-level provenance (Stage C2)", () => {
  it("renders the statement bracket the historian prompt teaches the model to read", () => {
    const ws = applyOperations(createWorkspace(), [
      { op: "CREATE_NODE", id: "pricing", nodeType: "decision", label: "Pricing ($15/month)" },
      {
        op: "SET_STATEMENT",
        id: "pricing",
        statement: { kind: "decision", status: "resolved", topic: "pricing" },
      },
      { op: "CREATE_NODE", id: "old", nodeType: "decision", label: "Old plan" },
      {
        op: "SET_STATEMENT",
        id: "old",
        statement: { kind: "proposal", status: "superseded", topic: "pricing", supersedes: [] },
      },
    ]);
    const digest = renderBoardDigest(baseInput({ workspace: ws }));
    expect(digest).toContain("[decision · resolved · topic: pricing]");
    expect(digest).toContain("[proposal · superseded · topic: pricing]");
  });

  it("prefers the op-level provenance over the legacy metadata stamp", () => {
    const ws = applyOperations(createWorkspace(), [
      {
        op: "CREATE_NODE",
        id: "pricing",
        nodeType: "decision",
        label: "Pricing",
        provenance: { meetingId: "mtg_new", quote: "op-level evidence" },
      },
    ]);
    // A legacy stamp still present on the node loses to the canonical field.
    ws.nodes.pricing!.metadata = { meeting: { meetingId: "mtg_old", quote: "legacy" } };
    const digest = renderBoardDigest(baseInput({ workspace: ws }));
    expect(digest).toContain("mtg_new");
    expect(digest).toContain("op-level evidence");
    expect(digest).not.toContain("mtg_old");
  });

  it("falls back to the legacy metadata stamp for pre-C2 boards", () => {
    const ws = applyOperations(createWorkspace(), [
      { op: "CREATE_NODE", id: "old-board", nodeType: "decision", label: "Old" },
    ]);
    ws.nodes["old-board"]!.metadata = {
      meeting: { meetingId: "mtg_legacy", quote: "the old stamp" },
    };
    const digest = renderBoardDigest(baseInput({ workspace: ws }));
    expect(digest).toContain("mtg_legacy");
    expect(digest).toContain("the old stamp");
  });
});
