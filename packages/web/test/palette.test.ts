import { describe, expect, it } from "vitest";
import {
  buildResults,
  filterBoard,
  filterItems,
  groupSearchHits,
  moveIndex,
  searchHitHint,
  searchHitTarget,
  searchHitTitle,
  type PaletteItem,
} from "../src/ui/palette.js";

/**
 * The command palette's core (M7): pure functions, DOM-free. These tests pin
 * the decisions a palette gets wrong — matching, grouping order, cursor
 * arithmetic — so the overlay is only ever a rendering bug, never a behaviour
 * one.
 */

const items: PaletteItem[] = [
  { id: "undo", label: "Undo", hint: "⌘Z · History", group: "action", run: { kind: "undo" } },
  {
    id: "new",
    label: "New workspace",
    hint: "Board · Start over",
    group: "action",
    run: { kind: "newWorkspace" },
  },
  {
    id: "v-canvas",
    label: "Open canvas",
    hint: "Semantic diagram",
    group: "view",
    run: { kind: "view", view: "canvas" },
  },
  {
    id: "v-history",
    label: "Open workspace history",
    hint: "Version timeline",
    group: "view",
    run: { kind: "view", view: "history" },
  },
];

const board = [
  { id: "n1", title: "Customer", hint: "Node · actor" },
  { id: "s1", title: "blueprint", hint: "sticky" },
];

describe("filterItems", () => {
  it("returns everything with no query", () => {
    expect(filterItems(items, "   ")).toHaveLength(items.length);
  });

  it("matches on label and hint, case-insensitively", () => {
    expect(filterItems(items, "history")).toHaveLength(2); // Undo hint + history view
    expect(filterItems(items, "NEW WORKSPACE")).toHaveLength(1);
    expect(filterItems(items, "zzz")).toHaveLength(0);
  });
});

describe("buildResults", () => {
  it("groups actions before views, and shows board hits only under a query", () => {
    const empty = buildResults(items, board, "");
    expect(empty.actions.map((a) => a.id)).toEqual(["undo", "new"]);
    expect(empty.views.map((v) => v.id)).toEqual(["v-canvas", "v-history"]);
    expect(empty.board).toEqual([]);

    const hit = buildResults(items, board, "customer");
    expect(hit.board).toEqual([board[0]]);
    expect(hit.total).toBe(hit.actions.length + hit.views.length + hit.board.length);
  });

  it("the cursor counts across all groups, not per group", () => {
    const r = buildResults(items, board, "");
    expect(r.total).toBe(4);
    // Down from the last item wraps to the first (moveIndex's own rule).
    expect(moveIndex(3, 1, 4)).toBe(0);
    expect(moveIndex(0, -1, 4)).toBe(3);
  });
});

describe("filterBoard", () => {
  it("caps results at the limit", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      id: `n${i}`,
      title: `Node ${i}`,
      hint: "x",
    }));
    expect(filterBoard(many, "node", 8)).toHaveLength(8);
  });

  it("matches hint text too", () => {
    expect(filterBoard(board, "actor")).toEqual([board[0]]);
  });
});

describe("moveIndex", () => {
  it("is safe on an empty list", () => {
    expect(moveIndex(0, 1, 0)).toBe(0);
    expect(moveIndex(0, -1, 0)).toBe(0);
  });
  it("wraps in both directions", () => {
    expect(moveIndex(0, -1, 3)).toBe(2);
    expect(moveIndex(2, 1, 3)).toBe(0);
    expect(moveIndex(1, 1, 3)).toBe(2);
  });
});

describe("server search hits (Stage C4)", () => {
  const node = {
    kind: "node" as const,
    id: "pricing",
    nodeType: "decision",
    label: "Pricing decision $15",
    statement: { kind: "decision", status: "resolved", topic: "pricing" },
    matched: ["pricing"],
    score: 12,
  };
  const turn = {
    kind: "turn" as const,
    id: "mtg_a",
    meetingId: "mtg_a",
    turnIndex: 4,
    speaker: "Maya",
    snippet: "…maybe $20 for the pro tier…",
    matched: ["pro", "tier"],
    score: 2,
  };
  const revision = {
    kind: "revision" as const,
    id: "41",
    seq: 41,
    label: "added pricing region",
    at: 1_700_000_000_000,
    actorName: "Alex",
    matched: ["pricing"],
    score: 2,
  };

  it("groups hits into nodes, turns, revisions in arrival order", () => {
    const g = groupSearchHits([node, revision, turn]);
    expect(g.nodes).toEqual([node]);
    expect(g.turns).toEqual([turn]);
    expect(g.revisions).toEqual([revision]);
    expect(g.total).toBe(3);
  });

  it("renders a node hint with its statement, a turn hint with meeting and turn, a revision hint with actor", () => {
    expect(searchHitHint(node)).toBe("Node · decision · resolved · pricing");
    expect(searchHitHint(turn)).toBe("Transcript · mtg_a · turn 4");
    expect(searchHitHint(revision)).toBe("Revision · 41 · Alex");
  });

  it("titles: node label, speaker-quoted snippet, revision label with date", () => {
    expect(searchHitTitle(node)).toBe("Pricing decision $15");
    expect(searchHitTitle(turn)).toBe('Maya: "…maybe $20 for the pro tier…"');
    expect(searchHitTitle(revision)).toContain("added pricing region");
    expect(searchHitTitle(revision)).toMatch(/\(\d{4}-\d{2}-\d{2}\)$/);
  });

  it("maps every hit kind onto the existing citation navigation", () => {
    expect(searchHitTarget(node)).toEqual({ kind: "node", id: "pricing" });
    // A turn navigates to its MEETING at its turn — ?meeting= + ?turn=, the
    // C3 coordinates, never a fourth navigation kind.
    expect(searchHitTarget(turn)).toEqual({ kind: "meeting", id: "mtg_a", turnRange: [4, 4] });
    expect(searchHitTarget(revision)).toEqual({ kind: "revision", id: "41" });
    // A malformed turn hit (no meeting) is not navigable — null, not a guess.
    expect(searchHitTarget({ ...turn, meetingId: undefined })).toBeNull();
  });
});

describe("the C4 scenario shapes, as the definition e2e drives them", () => {
  // The shapes from the stageC4 definition scenario: Monday's unclassified
  // mumble and the extraction's statement. The server e2e drives the route;
  // these pin the palette's grouping + navigation on the exact results it
  // returns, in the package the functions live in.
  const mumble = {
    kind: "turn" as const,
    id: "mtg_monday",
    meetingId: "mtg_monday",
    turnIndex: 0,
    speaker: "Maya",
    snippet: "Maybe $20 for the pro tier?",
    matched: ["pro", "tier"],
    score: 2,
  };
  const statement = {
    kind: "node" as const,
    id: "pricing-decision",
    nodeType: "decision",
    label: "Pricing decision $15",
    statement: { kind: "decision", status: "resolved", topic: "pricing" },
    matched: ["pricing"],
    score: 12,
  };
  const hidden = {
    kind: "revision" as const,
    id: "1",
    seq: 1,
    label: "pricing retro before the launch",
    at: 1_700_000_000_000,
    matched: ["retro"],
    score: 2,
  };

  it("groups the mumble and the statement; the navigation rides C1 for both", () => {
    // What the route returns for the scenario's queries, merged as the
    // overlay receives them (the route ranked; the palette only groups).
    const g = groupSearchHits([statement, mumble, hidden]);
    expect(g.nodes).toEqual([statement]);
    expect(g.turns).toEqual([mumble]);
    expect(g.revisions).toEqual([hidden]);

    // The unclassified mumble navigates to its MEETING at its exact turn —
    // the same ?meeting + ?turn jump a citation uses.
    expect(searchHitTarget(mumble)).toEqual({
      kind: "meeting",
      id: "mtg_monday",
      turnRange: [0, 0],
    });
    // The statement node navigates to the canvas selection.
    expect(searchHitTarget(statement)).toEqual({ kind: "node", id: "pricing-decision" });
    // The revision navigates to history.
    expect(searchHitTarget(hidden)).toEqual({ kind: "revision", id: "1" });
  });
});
