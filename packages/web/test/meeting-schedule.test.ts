import { describe, expect, it } from "vitest";
import { createWorkspace, type Workspace } from "@lucent/core";
import { contextBrief, CONTEXT_LIMIT } from "../src/meetingContext.js";
import { isUpcoming, startsIn, type MeetingTranscript } from "../src/meetings.js";

/** docs/28 A3.4 (S3): what a scheduled meeting walks into. */

function board(
  nodes: Array<{
    id: string;
    label: string;
    kind: "decision" | "action" | "question" | "risk" | "proposal";
    status: "open" | "resolved";
    assignee?: string;
    dueDate?: string;
    meetingId?: string;
  }>,
): Workspace {
  const ws = createWorkspace();
  for (const n of nodes) {
    (ws.nodes as Record<string, unknown>)[n.id] = {
      id: n.id,
      label: n.label,
      type: "process",
      statement: {
        kind: n.kind,
        status: n.status,
        ...(n.meetingId ? { provenance: { meetingId: n.meetingId } } : {}),
      },
      ...(n.assignee || n.dueDate
        ? {
            issue: {
              ...(n.assignee ? { assignee: n.assignee } : {}),
              ...(n.dueDate ? { dueDate: n.dueDate } : {}),
            },
          }
        : {}),
    };
  }
  return ws;
}

const meeting = (id: string, extra: Partial<MeetingTranscript>): MeetingTranscript => ({
  id,
  boardId: "b",
  orgId: "o",
  startedAt: 0,
  endedAt: null,
  turns: [],
  createdBy: "u",
  createdAt: 0,
  ...extra,
});

describe("the context brief", () => {
  it("lists what's still open, what was decided, and orders actions by when they're due", () => {
    const ws = board([
      { id: "a1", label: "Write docs", kind: "action", status: "open" },
      {
        id: "a2",
        label: "Ship beta",
        kind: "action",
        status: "open",
        dueDate: "2026-10-09",
        assignee: "Bo",
      },
      { id: "a3", label: "Fix login", kind: "action", status: "open", dueDate: "2026-10-02" },
      { id: "a4", label: "Old task", kind: "action", status: "resolved" },
      { id: "q1", label: "Which region?", kind: "question", status: "open", meetingId: "m0" },
      { id: "r1", label: "Vendor lock-in", kind: "risk", status: "open" },
      { id: "d1", label: "Use Postgres", kind: "decision", status: "resolved" },
      { id: "d2", label: "Ship in October", kind: "decision", status: "resolved" },
      { id: "p1", label: "Maybe GraphQL", kind: "proposal", status: "open" },
    ]);
    const brief = contextBrief(ws, []);
    expect(brief.actions.map((a) => a.label)).toEqual(["Fix login", "Ship beta", "Write docs"]);
    expect(brief.actions[1]).toMatchObject({ assignee: "Bo", dueDate: "2026-10-09" });
    expect(brief.questions).toEqual([{ nodeId: "q1", label: "Which region?", meetingId: "m0" }]);
    expect(brief.risks.map((r) => r.label)).toEqual(["Vendor lock-in"]);
    // Newest decision first (board order is the order they were made).
    expect(brief.decisions.map((d) => d.label)).toEqual(["Ship in October", "Use Postgres"]);
    expect(brief.total).toBe(7);
    expect(brief.lastTime).toBeNull();
  });

  it("caps each list, and says what the last summarized meeting ended with", () => {
    const many = Array.from({ length: CONTEXT_LIMIT + 3 }, (_, i) => ({
      id: `q${i}`,
      label: `Q${i}`,
      kind: "question" as const,
      status: "open" as const,
    }));
    const recap = (text: string) => ({
      sections: [{ title: "Decisions", items: [{ text, source: "ai" as const }] }],
      generatedAt: 1,
      by: "fallback" as const,
    });
    const brief = contextBrief(board(many), [
      meeting("older", { endedAt: 10, recap: recap("Old line") }),
      meeting("newer", { endedAt: 20, title: "Kickoff", recap: recap("We chose Postgres") }),
      meeting("unsummarized", { endedAt: 30 }),
    ]);
    expect(brief.questions).toHaveLength(CONTEXT_LIMIT);
    expect(brief.total).toBe(CONTEXT_LIMIT + 3);
    expect(brief.lastTime).toMatchObject({
      meetingId: "newer",
      title: "Kickoff",
      lines: ["We chose Postgres"],
    });
  });
});

describe("when a scheduled meeting is", () => {
  it("is upcoming until it starts, and speaks relative time", () => {
    const planned = meeting("m", {
      schedule: { scheduledFor: 100, durationMin: 30, invitees: [] },
    });
    expect(isUpcoming(planned)).toBe(true);
    expect(isUpcoming({ ...planned, turns: [{ speaker: "A", at: 1, text: "hi" }] })).toBe(false);
    expect(isUpcoming({ ...planned, endedAt: 5 })).toBe(false);
    expect(isUpcoming(meeting("n", {}))).toBe(false);
    const now = 1_000_000_000;
    expect(startsIn(now + 2 * 60 * 60_000, now)).toBe("in 2 h");
    expect(startsIn(now + 5 * 60_000, now)).toBe("in 5 min");
    expect(startsIn(now + 10_000, now)).toBe("now");
    expect(startsIn(now - 10 * 60_000, now)).toBe("started 10 min ago");
    expect(startsIn(now + 3 * 24 * 60 * 60_000, now)).toBe("in 3 days");
  });
});
