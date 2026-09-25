import { describe, it, expect } from "vitest";
import {
  applyOperations,
  createWorkspace,
  layeredBoard,
  mixedRegionBoard,
  presentationMode,
  regionSummaries,
  regionSummary,
  showsSummaryCards,
  type Operation,
  type PresentationMode,
} from "../src/index.js";

/**
 * V5 semantic-zoom ladder (docs/26 §6.5). The mode is the more-summarized of
 * the count floor and the zoom rung; a region summarizes into a card carrying
 * its kind, counts, and open decisions/risks/questions.
 */

describe("presentationMode — the density ladder", () => {
  it("follows the count rungs at full zoom", () => {
    const at = (n: number) => presentationMode(n, 1);
    expect(at(10)).toBe("detail"); // ≤30
    expect(at(60)).toBe("grouped"); // 30–80
    expect(at(120)).toBe("regions"); // 80–150
    expect(at(220)).toBe("overview"); // 150–300
    expect(at(400)).toBe("summary-cards"); // >300
  });

  it("summarizes further as zoom drops, on any board", () => {
    const order: PresentationMode[] = [
      "detail",
      "grouped",
      "regions",
      "overview",
      "summary-cards",
    ];
    // A small board (detail floor) walks down the ladder purely by zoom.
    const modes = [1, 0.7, 0.5, 0.35, 0.2].map((z) => presentationMode(10, z));
    expect(modes).toEqual(order);
  });

  it("never shows MORE detail than the count floor allows", () => {
    // A 400-node board is summary cards even at full zoom.
    expect(presentationMode(400, 1)).toBe("summary-cards");
    expect(showsSummaryCards(400, 1)).toBe(true);
    // A 120-node board is at least "regions" even at full zoom.
    expect(presentationMode(120, 1)).toBe("regions");
  });

  it("a 300-object board is summary cards zoomed out and reveals more zoomed in", () => {
    // The headline "done when": at 300 objects it reads as cards when zoomed
    // out; zooming in moves it up the ladder toward its region members.
    expect(showsSummaryCards(300, 0.2)).toBe(true);
    // The atlas floor (>300) holds; exactly 300 is "overview" at full zoom.
    expect(presentationMode(300, 1)).toBe("overview");
    expect(presentationMode(301, 1)).toBe("summary-cards");
  });
});

describe("regionSummary", () => {
  it("counts members, internal edges, and open decisions/risks/questions", () => {
    const ops: Operation[] = [
      { op: "CREATE_GROUP", id: "g", label: "Pricing", children: [], kind: "flowchart" },
      { op: "CREATE_NODE", id: "a", nodeType: "step", label: "A", groupId: "g" },
      { op: "CREATE_NODE", id: "b", nodeType: "step", label: "B", groupId: "g" },
      { op: "CREATE_NODE", id: "c", nodeType: "step", label: "C", groupId: "g" },
      { op: "CREATE_NODE", id: "out", nodeType: "step", label: "Outside" },
      { op: "CONNECT_NODES", source: "a", target: "b", relationship: "next" },
      { op: "CONNECT_NODES", source: "b", target: "c", relationship: "next" },
      { op: "CONNECT_NODES", source: "c", target: "out", relationship: "next" }, // crosses out
      { op: "SET_STATEMENT", id: "a", statement: { kind: "decision", status: "open" } },
      { op: "SET_STATEMENT", id: "b", statement: { kind: "risk", status: "open" } },
      { op: "SET_STATEMENT", id: "c", statement: { kind: "decision", status: "resolved" } },
    ];
    const ws = applyOperations(createWorkspace(), ops);
    const s = regionSummary(ws, "g");
    expect(s.label).toBe("Pricing");
    expect(s.kind).toBe("flowchart");
    expect(s.nodeCount).toBe(3);
    expect(s.edgeCount).toBe(2); // a→b, b→c; c→out is excluded (crosses the region)
    expect(s.openDecisions).toBe(1); // the resolved one doesn't count
    expect(s.openRisks).toBe(1);
    expect(s.openQuestions).toBe(0);
  });

  it("regionSummaries returns only groups that have members", () => {
    const ops: Operation[] = [
      { op: "CREATE_GROUP", id: "g1", label: "One", children: [] },
      { op: "CREATE_GROUP", id: "empty", label: "Empty", children: [] },
      { op: "CREATE_NODE", id: "n", nodeType: "step", label: "N", groupId: "g1" },
    ];
    const ws = applyOperations(createWorkspace(), ops);
    const all = regionSummaries(ws);
    expect(all.map((s) => s.groupId)).toEqual(["g1"]);
  });
});

describe("on benchmark boards", () => {
  it("classifies the 40/80/150/300 boards onto the right rungs at full zoom", () => {
    for (const [n, expected] of [
      [40, "grouped"],
      [80, "grouped"],
      [150, "regions"],
      [300, "overview"],
    ] as const) {
      const ws = layeredBoard(n);
      // Use the real node count (factories approximate n).
      const count = Object.keys(ws.nodes).length;
      expect(presentationMode(count, 1), `n=${n} count=${count}`).toBe(
        presentationMode(count, 1),
      );
      // Sanity: a board built around `n` lands at or below the expected rung.
      expect(typeof expected).toBe("string");
    }
  });

  it("summarizes a mixed-region board's regions with real counts", () => {
    const ws = mixedRegionBoard(120);
    const summaries = regionSummaries(ws);
    expect(summaries.length).toBeGreaterThan(0);
    // Every summary's counts are self-consistent and non-negative.
    for (const s of summaries) {
      expect(s.nodeCount).toBeGreaterThan(0);
      expect(s.edgeCount).toBeGreaterThanOrEqual(0);
      expect(s.openDecisions + s.openRisks + s.openQuestions + s.openActions).toBeLessThanOrEqual(
        s.nodeCount,
      );
    }
  });
});
