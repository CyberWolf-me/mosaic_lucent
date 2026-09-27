import { describe, expect, it } from "vitest";
import {
  applyOperations,
  createWorkspace,
  executionRollup,
  type Operation,
  type Workspace,
} from "@lucent/core";
import {
  busiestBoard,
  dueLabel,
  greetingFor,
  isQuestionText,
  pulseLede,
  timeAgo,
  workspacePulse,
  type PulseBoardInput,
} from "../src/pulse.js";

/**
 * The workspace pulse (Home). Pure over the boards it is handed — the view
 * renders what this module decides, so every count, row, and notice Home
 * shows is pinned here against real board shapes, never sample data.
 */

// Local noon, so calendar-date comparisons don't depend on the runner's zone.
const NOW = new Date(2026, 8, 23, 12, 0).getTime(); // 2026-09-23

function statement(
  id: string,
  kind: "decision" | "proposal" | "question" | "action" | "requirement" | "risk",
  status: "open" | "resolved" | "rejected" | "superseded" = "open",
  topic?: string,
): Operation[] {
  return [
    { op: "CREATE_NODE", id, nodeType: kind, label: id.replace(/-/g, " ") },
    { op: "SET_STATEMENT", id, statement: { kind, status, ...(topic ? { topic } : {}) } },
  ];
}

function action(
  id: string,
  fields: { status?: string; assignee?: string; dueDate?: string } = {},
): Operation[] {
  return [
    ...statement(id, "action"),
    {
      op: "SET_ISSUE",
      id,
      issue: {
        type: "task",
        status: fields.status ?? "open",
        ...(fields.assignee ? { assignee: fields.assignee } : {}),
        ...(fields.dueDate ? { dueDate: fields.dueDate } : {}),
      },
    },
  ];
}

function ws(ops: Operation[]): Workspace {
  return applyOperations(createWorkspace(), ops);
}

function board(
  id: string,
  workspace: Workspace | null,
  extra: Partial<PulseBoardInput> = {},
): PulseBoardInput {
  return { id, name: `Board ${id}`, updatedAt: NOW - 1000, workspace, isCurrent: false, ...extra };
}

describe("workspacePulse", () => {
  it("collects open statements across boards with their board and node pointers", () => {
    const a = ws([
      ...statement("use-stripe", "decision", "resolved", "payments"),
      ...statement("cash-on-delivery", "question", "open", "payments"),
      ...statement("driver-supply", "risk"),
      ...action("onboarding", { status: "assigned", assignee: "Sam" }),
    ]);
    const b = ws([
      ...statement("pick-a-region", "decision"),
      ...statement("try-usage-pricing", "proposal"),
    ]);
    const pulse = workspacePulse(
      [board("a", a, { isCurrent: true }), board("b", b, { updatedAt: NOW - 5000 })],
      NOW,
    );
    expect(pulse.counts).toEqual({
      openQuestions: 1,
      pendingDecisions: 1,
      openProposals: 1,
      openActions: 1,
      overdue: 0,
      blocked: 0,
      openRisks: 1,
    });
    // The resolved decision is the record, not something that needs anyone.
    expect(pulse.items.map((i) => i.nodeId)).not.toContain("use-stripe");
    const q = pulse.items.find((i) => i.nodeId === "cash-on-delivery")!;
    expect(q).toMatchObject({
      boardId: "a",
      boardName: "Board a",
      isCurrent: true,
      kind: "question",
    });
    const act = pulse.items.find((i) => i.nodeId === "onboarding")!;
    expect(act).toMatchObject({ assignee: "Sam", executionStatus: "assigned", signal: "open" });
    expect(pulse.boardsWithItems).toBe(2);
    expect(pulse.boardsWithContent).toBe(2);
  });

  it("orders late and blocked work first, then decisions, questions, proposals, risks", () => {
    const a = ws([
      ...statement("risky", "risk"),
      ...statement("which-db", "question"),
      ...statement("proposal-x", "proposal"),
      ...statement("pending-call", "decision"),
      ...action("late", { dueDate: "2026-09-20" }),
      ...action("stuck", { status: "blocked" }),
      ...action("fine"),
    ]);
    const kinds = workspacePulse([board("a", a)], NOW).items.map((i) => i.nodeId);
    expect(kinds).toEqual([
      "late",
      "stuck",
      "pending-call",
      "which-db",
      "proposal-x",
      "risky",
      "fine",
    ]);
  });

  it("agrees with the execution rollup on overdue and blocked work", () => {
    const a = ws([
      ...action("design", { status: "blocked", dueDate: "2026-09-01" }),
      ...action("build"),
      ...action("ship", { status: "completed", dueDate: "2026-09-01" }),
      { op: "CONNECT_NODES", source: "build", target: "design", relationship: "depends_on" },
    ]);
    const pulse = workspacePulse([board("a", a)], NOW);
    const rollup = executionRollup(a, NOW);
    expect(pulse.counts.overdue).toBe(rollup.overdue);
    expect(pulse.counts.blocked).toBe(rollup.blocked);
    expect(pulse.counts.openActions).toBe(rollup.total - rollup.completed);
    // Completed work is never "needs you", even with a past due date.
    expect(pulse.items.map((i) => i.nodeId)).not.toContain("ship");
    // Derived-blocked (upstream) counts, and the row says why.
    expect(pulse.items.find((i) => i.nodeId === "build")).toMatchObject({
      blocked: true,
      signal: "blocked",
    });
  });

  it("leaves bare action statements and requirements out (not tracked work)", () => {
    const a = ws([
      ...statement("we-should-redesign", "action"),
      ...statement("gdpr", "requirement"),
    ]);
    const pulse = workspacePulse([board("a", a)], NOW);
    expect(pulse.items).toEqual([]);
    expect(pulse.counts.openActions).toBe(0);
    expect(pulse.boardsWithContent).toBe(1);
  });

  it("carries meeting provenance so a row can jump to the words", () => {
    const a = ws([
      {
        op: "CREATE_NODE",
        id: "q",
        nodeType: "question",
        label: "Launch in EU?",
        provenance: { meetingId: "mtg_1", turnRange: [3, 4] },
      },
      { op: "SET_STATEMENT", id: "q", statement: { kind: "question", status: "open" } },
    ]);
    const [item] = workspacePulse([board("a", a)], NOW).items;
    expect(item).toMatchObject({ fromMeeting: "mtg_1", turnRange: [3, 4] });
  });

  it("keeps fromMeeting meeting-only and carries a request's origin separately", () => {
    const a = ws([
      {
        op: "CREATE_NODE",
        id: "r",
        nodeType: "risk",
        label: "Vendor lock-in",
        provenance: { conversation: { at: NOW - 60_000, by: "Test User" } },
      },
      { op: "SET_STATEMENT", id: "r", statement: { kind: "risk", status: "open" } },
    ]);
    const [item] = workspacePulse([board("a", a)], NOW).items;
    expect(item!.fromMeeting).toBeUndefined();
    expect(item!.fromRequest).toEqual({ at: NOW - 60_000, by: "Test User" });
  });

  it("lists name-only server boards as recent but never invents their contents", () => {
    const pulse = workspacePulse(
      [
        board("cloud", null, { updatedAt: NOW - 10 }),
        board("local", ws(statement("q", "question")), { updatedAt: NOW - 20 }),
      ],
      NOW,
    );
    expect(pulse.boards.map((b) => b.id)).toEqual(["cloud", "local"]);
    expect(pulse.boards[0]).toMatchObject({ hasContent: null, openItems: null, statements: null });
    expect(pulse.boards[1]).toMatchObject({ hasContent: true, openItems: 1, statements: 1 });
    expect(pulse.items.every((i) => i.boardId === "local")).toBe(true);
  });

  it("is empty — no items, no notices, no content — for a first run", () => {
    const pulse = workspacePulse([board("a", createWorkspace(), { isCurrent: true })], NOW);
    expect(pulse.items).toEqual([]);
    expect(pulse.noticed).toEqual([]);
    expect(pulse.boardsWithContent).toBe(0);
    expect(pulseLede(pulse)).toBeNull();
  });
});

describe("noticed", () => {
  it("names nothing when there is no real signal", () => {
    const a = ws([...statement("q", "question", "open", "pricing"), ...action("do-it")]);
    expect(workspacePulse([board("a", a)], NOW).noticed).toEqual([]);
  });

  it("derives a blocking chain blocker-first", () => {
    const a = ws([
      ...action("design", { status: "blocked" }),
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
    const notice = workspacePulse([board("a", a)], NOW).noticed[0]!;
    expect(notice).toMatchObject({ kind: "blocked-chain", boardId: "a", nodeId: "qa" });
    expect(notice.kind === "blocked-chain" && notice.chain.map((c) => c.id)).toEqual([
      "design",
      "implementation",
      "qa",
    ]);
  });

  it("names the oldest overdue action and counts the rest", () => {
    const a = ws([
      ...action("recent-late", { dueDate: "2026-09-21", assignee: "Ada" }),
      ...action("oldest-late", { dueDate: "2026-09-02", assignee: "Sam" }),
    ]);
    const b = ws(action("other-late", { dueDate: "2026-09-10" }));
    const noticed = workspacePulse([board("a", a), board("b", b)], NOW).noticed;
    expect(noticed.find((n) => n.kind === "overdue")).toMatchObject({
      nodeId: "oldest-late",
      assignee: "Sam",
      dueDate: "2026-09-02",
      others: 2,
    });
  });

  it("does not name the same late action twice when a chain already tells its story", () => {
    const a = ws([
      ...action("design", { status: "blocked" }),
      ...action("launch", { dueDate: "2026-09-01" }),
      { op: "CONNECT_NODES", source: "launch", target: "design", relationship: "depends_on" },
    ]);
    const noticed = workspacePulse([board("a", a)], NOW).noticed;
    expect(noticed.map((n) => n.kind)).toEqual(["blocked-chain"]);
  });

  it("flags an open question on a topic that already has a decision", () => {
    const a = ws([
      ...statement("use-stripe", "decision", "resolved", "payments"),
      ...statement("cash-on-delivery", "question", "open", "payments"),
    ]);
    expect(workspacePulse([board("a", a)], NOW).noticed).toEqual([
      expect.objectContaining({
        kind: "open-on-decided-topic",
        questionId: "cash-on-delivery",
        decisionId: "use-stripe",
        topic: "payments",
      }),
    ]);
  });

  it("surfaces a topic authored two ways (the Intelligence inbox's merge signal)", () => {
    const a = ws([
      ...statement("p1", "decision", "open", "pricing"),
      ...statement("p2", "question", "open", "pricing-model"),
    ]);
    const dup = workspacePulse([board("a", a)], NOW).noticed.find(
      (n) => n.kind === "duplicate-topic",
    );
    expect(dup).toMatchObject({ dup: "pricing-model", existing: "pricing", statements: 2 });
  });
});

describe("busiestBoard", () => {
  it("picks the board with the most matches, the open board winning ties", () => {
    const a = ws([...statement("q1", "question"), ...statement("q2", "question")]);
    const b = ws(statement("q3", "question"));
    const c = ws(statement("q4", "question"));
    const { items } = workspacePulse(
      [board("a", a), board("b", b, { isCurrent: true }), board("c", c)],
      NOW,
    );
    expect(busiestBoard(items, (i) => i.kind === "question")).toBe("a");
    const tie = workspacePulse([board("b", b, { isCurrent: true }), board("c", c)], NOW).items;
    expect(busiestBoard(tie, (i) => i.kind === "question")).toBe("b");
    expect(busiestBoard(items, (i) => i.kind === "risk")).toBeNull();
  });
});

describe("words", () => {
  it("summarises real counts, naming the board when there is one", () => {
    const a = ws([
      ...statement("q1", "question"),
      ...statement("q2", "question"),
      ...action("late", { dueDate: "2026-09-01" }),
    ]);
    const one = workspacePulse([board("a", a, { name: "Checkout" })], NOW);
    expect(pulseLede(one)).toBe("2 open questions and 1 overdue action on “Checkout”.");
    const b = ws(statement("d", "decision"));
    const three = workspacePulse(
      [board("a", a), board("b", b), board("c", ws(statement("r", "risk")))],
      NOW,
    );
    expect(pulseLede(three)).toBe(
      "2 open questions, 1 pending decision and 1 overdue action across 3 boards.",
    );
  });

  it("says plainly when nothing is waiting", () => {
    const calm = workspacePulse(
      [board("a", ws(statement("d", "decision", "resolved")), { name: "Roadmap" })],
      NOW,
    );
    expect(pulseLede(calm)).toMatch(/^Nothing is waiting on you on “Roadmap”/);
  });

  it("greets by the actual time of day", () => {
    const at = (h: number) => greetingFor(new Date(2026, 8, 23, h, 0));
    expect(at(9)).toBe("Good morning");
    expect(at(12)).toBe("Good afternoon");
    expect(at(17)).toBe("Good afternoon");
    expect(at(18)).toBe("Good evening");
    expect(at(22)).toBe("Good evening"); // the old Home said "Good morning" here
    expect(at(2)).toBe("Good evening");
  });

  it("routes questions to Ask and descriptions to a new board", () => {
    expect(isQuestionText("Who owns the driver onboarding?")).toBe(true);
    expect(isQuestionText("why did we pick Stripe")).toBe(true);
    expect(isQuestionText("Should we support cash on delivery")).toBe(true);
    expect(isQuestionText("A checkout flow with Stripe and Apple Pay")).toBe(false);
    expect(isQuestionText("Can you draw a login flow?")).toBe(false);
    expect(isQuestionText("What if we split the payment service")).toBe(false);
    expect(isQuestionText("   ")).toBe(false);
  });

  it("formats relative times and due dates", () => {
    expect(timeAgo(NOW - 20_000, NOW)).toBe("just now");
    expect(timeAgo(NOW - 12 * 60_000, NOW)).toBe("12m ago");
    expect(timeAgo(NOW - 3 * 3_600_000, NOW)).toBe("3h ago");
    expect(timeAgo(NOW - 26 * 3_600_000, NOW)).toBe("yesterday");
    expect(timeAgo(NOW - 4 * 86_400_000, NOW)).toBe("4d ago");
    expect(dueLabel("2026-09-23", NOW)).toBe("due today");
    expect(dueLabel("2026-09-24", NOW)).toBe("due tomorrow");
    expect(dueLabel("2026-09-22", NOW)).toBe("due yesterday");
    expect(dueLabel("2026-09-02", NOW)).toMatch(/^was due /);
    expect(dueLabel("2026-09-02", NOW)).not.toMatch(/2026/);
    // A year-old deadline must not read like last week's.
    expect(dueLabel("2025-06-13", NOW)).toMatch(/^was due .*2025/);
  });
});

describe("workspacePulse over the workspace index (ADR 0046)", () => {
  it("counts a server board from its indexed rows, by the same rules as a loaded one", () => {
    const pulse = workspacePulse(
      [
        board("srv", null, {
          indexed: [
            {
              id: "which-tier",
              kind: "question",
              status: "open",
              label: "which tier",
              blocked: false,
            },
            {
              id: "go-annual",
              kind: "decision",
              status: "resolved",
              label: "go annual",
              blocked: false,
            },
            {
              id: "late-work",
              kind: "action",
              status: "open",
              label: "late work",
              blocked: false,
              executionStatus: "assigned",
              dueDate: "2026-09-01",
              assignee: "Sam",
            },
            {
              id: "stuck",
              kind: "action",
              status: "open",
              label: "stuck",
              blocked: true,
              executionStatus: "open",
            },
            {
              id: "done",
              kind: "action",
              status: "open",
              label: "done",
              blocked: false,
              executionStatus: "completed",
            },
            // A bare "we should…" is a statement, not work.
            { id: "idea", kind: "action", status: "open", label: "idea", blocked: false },
          ],
        }),
      ],
      NOW,
    );
    expect(pulse.counts).toMatchObject({
      openQuestions: 1,
      openActions: 2,
      overdue: 1,
      blocked: 1,
    });
    expect(pulse.items.map((i) => [i.nodeId, i.signal])).toEqual([
      ["late-work", "overdue"],
      ["stuck", "blocked"],
      ["which-tier", "open"],
    ]);
    expect(pulse.items[0]).toMatchObject({
      boardId: "srv",
      boardName: "Board srv",
      assignee: "Sam",
    });
    expect(pulse.boardsWithContent).toBe(1);
    expect(pulse.boards[0]).toMatchObject({ hasContent: true, statements: 6, openItems: 3 });
  });

  it("still names a board it knows only by name, uncounted", () => {
    const pulse = workspacePulse([board("srv", null)], NOW);
    expect(pulse.items).toEqual([]);
    expect(pulse.boards[0]).toMatchObject({ hasContent: null, openItems: null });
  });
});
