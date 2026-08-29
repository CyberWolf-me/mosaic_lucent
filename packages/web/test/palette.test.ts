import { describe, expect, it } from "vitest";
import {
  buildResults,
  filterBoard,
  filterItems,
  moveIndex,
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
