import { describe, expect, it } from "vitest";
import {
  citationTarget,
  classifiedTurns,
  chronologyByDay,
  depthBanner,
  groupHistoryByDay,
  mergeChronology,
} from "../src/historyTimeline.js";
import type { BoardHistoryItem } from "../src/boards.js";

/**
 * The server-timeline presentation helpers (Stage C1). The web suite runs
 * node-only, so the history view's decisions live in these pure functions:
 * day grouping (wall-clock, "yesterday's meeting" is a local-time question),
 * the honest depth banner (never "the board begins here"), and the citation
 * → navigation contract the chips, the history rows, and workspace.onCitation
 * all share.
 */

const NOW = Date.UTC(2026, 8, 3, 12, 0); // 2026-09-03 12:00 UTC

function item(seq: number, at: number, overrides: Partial<BoardHistoryItem> = {}): BoardHistoryItem {
  return {
    seq,
    at,
    label: `change ${seq}`,
    opCount: 1,
    actor: { type: "user", name: "Alex", id: "usr_1" },
    touched: [`n${seq}`],
    ...overrides,
  };
}

describe("groupHistoryByDay", () => {
  it("groups by local calendar day, newest day first, entries in arrival order", () => {
    // Two days back, one day back, today — with local-time boundaries, the
    // 23:30 entry on "yesterday" must not spill into today's bucket.
    const items = [
      item(3, NOW - 60_000),
      item(2, NOW - 26 * 3_600_000),
      item(1, NOW - 50 * 3_600_000),
    ];
    const days = groupHistoryByDay(items, NOW);
    expect(days.map((d) => d.label)).toEqual(["Today", "Yesterday", "Sep 1"]);
    expect(days[0]!.items.map((i) => i.seq)).toEqual([3]);
    expect(days[2]!.items.map((i) => i.seq)).toEqual([1]);
  });

  it("keeps a day's entries newest-first as the route sent them", () => {
    const items = [
      item(5, NOW - 60_000),
      item(4, NOW - 2 * 60_000),
      item(3, NOW - 3 * 60_000),
    ];
    const days = groupHistoryByDay(items, NOW);
    expect(days).toHaveLength(1);
    expect(days[0]!.items.map((i) => i.seq)).toEqual([5, 4, 3]);
  });

  it("appends the year only for days outside this year", () => {
    const old = item(1, NOW - 400 * 24 * 3_600_000);
    const days = groupHistoryByDay([old], NOW);
    expect(days[0]!.label).toMatch(/2025/);
  });

  it("an empty timeline groups to nothing", () => {
    expect(groupHistoryByDay([], NOW)).toEqual([]);
  });
});

describe("depthBanner — the honest window", () => {
  it("says what is hidden and that it is kept, when the window truncates", () => {
    const banner = depthBanner({ hasMore: true, historyDepth: 25, items: [] });
    expect(banner).toContain("latest 25 revisions");
    expect(banner).toContain("kept");
    expect(banner).toContain("upgrade");
  });

  it("stays silent when the window is everything, or the plan is unlimited", () => {
    expect(depthBanner({ hasMore: false, historyDepth: 25, items: [] })).toBeNull();
    // Unlimited plan, response-ceiling truncation: historyDepth is null, and
    // the banner has no plan to sell — silence beats a confusing message.
    expect(depthBanner({ hasMore: true, historyDepth: null, items: [] })).toBeNull();
  });
});

describe("citationTarget — the navigation contract", () => {
  it("a node citation reveals on the canvas", () => {
    expect(citationTarget({ kind: "node", id: "pricing" })).toEqual({
      view: "canvas",
      param: ["reveal", "pricing"],
    });
  });

  it("a meeting citation opens the transcript, with the turn range when known", () => {
    expect(citationTarget({ kind: "meeting", id: "mtg_7" })).toEqual({
      view: "meeting",
      params: [["meeting", "mtg_7"]],
    });
    expect(citationTarget({ kind: "meeting", id: "mtg_7", turnRange: [4, 6] })).toEqual({
      view: "meeting",
      params: [
        ["meeting", "mtg_7"],
        ["turn", "4"],
      ],
    });
  });

  it("a revision citation deep-links the history view", () => {
    expect(citationTarget({ kind: "revision", id: "42" })).toEqual({
      view: "history",
      param: ["rev", "42"],
    });
  });

  it("an unknown kind is inert, not a guess", () => {
    expect(citationTarget({ kind: "url", id: "https://x" })).toBeNull();
  });
});

describe("mergeChronology + chronologyByDay (Stage C3)", () => {
  const meetingAt = (id: string, at: number, turns = 2): import("../src/meetings.js").MeetingTranscript => ({
    id,
    boardId: "brd_1",
    orgId: "org_1",
    startedAt: at,
    endedAt: null,
    turns: Array.from({ length: turns }, (_, i) => ({
      speaker: "Alex",
      at: at + i,
      text: "words",
      ...(i === 0 ? { kind: "decision" as const } : {}),
    })),
    createdBy: null,
    createdAt: at,
  });

  it("interleaves the three streams newest-first", () => {
    const rows = mergeChronology(
      [
        item(3, NOW - 60_000),
        item(1, NOW - 3 * 3_600_000),
      ],
      [meetingAt("mtg_mid", NOW - 2 * 3_600_000)],
    );
    expect(rows.map((r) => r.kind)).toEqual(["revision", "meeting", "revision"]);
    expect(rows[1]).toMatchObject({ kind: "meeting", meeting: { id: "mtg_mid" } });
  });

  it("a statement-carrying revision yields its semantic row first, then the revision row", () => {
    const withStatement = {
      ...item(5, NOW - 60_000),
      statementEvent: {
        kind: "decision" as const,
        status: "resolved" as const,
        topic: "pricing",
        nodeId: "d1",
      },
    };
    const rows = mergeChronology([withStatement], []);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ kind: "statement" });
    expect(rows[1]).toMatchObject({ kind: "revision" });
    // Both rows point at the same item — the event is the point, the
    // revision line the detail.
    const statementRow = rows[0];
    const revisionRow = rows[1];
    if (statementRow?.kind !== "statement" || revisionRow?.kind !== "revision") {
      throw new Error("expected a statement row followed by its revision row");
    }
    expect(statementRow.item.seq).toBe(revisionRow.item.seq);
  });

  it("groups by local calendar day, newest day first, order preserved within", () => {
    const rows = mergeChronology(
      [item(9, NOW - 60_000), item(8, NOW - 26 * 3_600_000)],
      [meetingAt("mtg_y", NOW - 25 * 3_600_000)],
    );
    const days = chronologyByDay(rows, NOW);
    expect(days.map((d) => d.label)).toEqual(["Today", "Yesterday"]);
    expect(days[1]!.rows.map((r) => r.kind)).toEqual(["meeting", "revision"]);
  });

  it("classifiedTurns counts only the kinds", () => {
    expect(classifiedTurns(meetingAt("mtg_k", NOW, 4))).toBe(1);
    expect(classifiedTurns(meetingAt("mtg_z", NOW, 0))).toBe(0);
  });
});
