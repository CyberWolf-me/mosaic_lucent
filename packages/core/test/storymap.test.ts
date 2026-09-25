import { describe, expect, it } from "vitest";
import {
  STORY_MAP_OTHER,
  STORY_MAP_UNSCHEDULED,
  applyLayout,
  applyOperations,
  computeLayout,
  createWorkspace,
  layoutStrategyFor,
  relayoutRegion,
  relayoutRegionWithRoutes,
  starterFor,
  storyMapGrid,
  type LayoutResult,
  type Operation,
  type StoryMapGrid,
  type Workspace,
} from "../src/index.js";

/**
 * docs/27 D3: the user story map's real geometry. The model supplies meaning —
 * each group is an activity, a story's first issue label names its release —
 * and these pin that the engine turns it into the map people expect: the
 * backbone across the top, releases sliced down the page, every story in its
 * (activity, release) cell, and a scaffold the canvas can draw that agrees
 * with the cards exactly.
 */

function board(ops: Operation[]): Workspace {
  return applyOperations(createWorkspace({ name: "Map", id: "ws" }), [
    { op: "CREATE_DIAGRAM", kind: "storymap" },
    ...ops,
  ]);
}
const activity = (id: string, label = id): Operation => ({
  op: "CREATE_GROUP",
  id,
  label,
  children: [],
});
/** A story in `groupId` (or none), released in `labels[0]` (or unscheduled). */
const story = (id: string, groupId?: string, ...labels: string[]): Operation[] => [
  {
    op: "CREATE_NODE",
    id,
    nodeType: "story",
    label: `Story ${id}`,
    ...(groupId ? { groupId } : {}),
  },
  ...(labels.length > 0
    ? [{ op: "SET_ISSUE", id, issue: { type: "story", status: "open", labels } } as Operation]
    : []),
];

const cx = (l: LayoutResult, id: string) => l[id]!.position.x + l[id]!.size.width / 2;
const top = (l: LayoutResult, id: string) => l[id]!.position.y;

/** The (column, row) indices of the grid cell a placed story's box lies inside. */
function cellOf(grid: StoryMapGrid, l: LayoutResult, id: string): [number, number] {
  const { position: p, size: s } = l[id]!;
  const col = grid.columns.findIndex((c) => p.x >= c.x && p.x + s.width <= c.x + c.width);
  const row = grid.rows.findIndex((r) => p.y >= r.y && p.y + s.height <= r.y + r.height);
  return [col, row];
}

function overlaps(l: LayoutResult, a: string, b: string): boolean {
  const A = l[a]!;
  const B = l[b]!;
  return (
    A.position.x < B.position.x + B.size.width &&
    B.position.x < A.position.x + A.size.width &&
    A.position.y < B.position.y + B.size.height &&
    B.position.y < A.position.y + A.size.height
  );
}

describe("story map: the registry routes the family to its own geometry", () => {
  it("storymap lays out with the storymap strategy", () => {
    expect(layoutStrategyFor("storymap")).toBe("storymap");
  });

  it("the registry starter lays out as a story map", () => {
    const ws = applyOperations(createWorkspace(), starterFor("storymap", "s"));
    const l = computeLayout(ws);
    const grid = storyMapGrid(ws);
    expect(grid.columns.map((c) => c.label)).toEqual(["Find a product", "Buy it"]);
    expect(grid.rows.map((r) => r.release)).toEqual(["MVP", "Release 2"]);
    expect(cellOf(grid, l, "s-search")).toEqual([0, 0]);
    expect(cellOf(grid, l, "s-filter")).toEqual([0, 1]);
    expect(cellOf(grid, l, "s-cart")).toEqual([1, 0]);
    expect(cellOf(grid, l, "s-applepay")).toEqual([1, 1]);
    // The MVP slice is one straight band: both activities' MVP stories share its top.
    expect(top(l, "s-search")).toBe(top(l, "s-cart"));
    expect(top(l, "s-filter")).toBe(top(l, "s-applepay"));
  });
});

describe("story map columns: the backbone", () => {
  it("orders activity columns by group creation, left to right", () => {
    // Ids that sort differently from creation order, so only creation order
    // can produce this result.
    const ws = board([
      activity("zeta", "Sign up"),
      activity("alpha", "Browse"),
      activity("mid", "Check out"),
      ...story("c", "mid", "MVP"),
      ...story("a", "alpha", "MVP"),
      ...story("z", "zeta", "MVP"),
    ]);
    const grid = storyMapGrid(ws);
    expect(grid.columns.map((c) => c.groupId)).toEqual(["zeta", "alpha", "mid"]);
    expect(grid.columns.map((c) => c.label)).toEqual(["Sign up", "Browse", "Check out"]);
    const l = computeLayout(ws);
    expect(cx(l, "z")).toBeLessThan(cx(l, "a"));
    expect(cx(l, "a")).toBeLessThan(cx(l, "c"));
    // Columns never overlap, and each story is centred in its own column.
    for (let i = 1; i < grid.columns.length; i++) {
      const prev = grid.columns[i - 1]!;
      expect(grid.columns[i]!.x).toBeGreaterThan(prev.x + prev.width);
    }
    const zeta = grid.columns[0]!;
    expect(cx(l, "z")).toBeCloseTo(zeta.x + zeta.width / 2, 0);
  });

  it("puts stories with no activity in a trailing Other column", () => {
    const ws = board([
      ...story("loose1", undefined, "MVP"),
      activity("a", "Browse"),
      ...story("in", "a", "MVP"),
      ...story("loose2", undefined, "MVP"),
    ]);
    const grid = storyMapGrid(ws);
    expect(grid.columns.map((c) => c.groupId)).toEqual(["a", null]);
    expect(grid.columns.at(-1)!.label).toBe(STORY_MAP_OTHER);
    const l = computeLayout(ws);
    expect(cellOf(grid, l, "loose1")).toEqual([1, 0]);
    expect(cellOf(grid, l, "loose2")).toEqual([1, 0]);
    expect(cellOf(grid, l, "in")).toEqual([0, 0]);
  });

  it("has no Other column when every story has an activity", () => {
    const ws = board([activity("a"), ...story("s", "a", "MVP")]);
    expect(storyMapGrid(ws).columns.map((c) => c.groupId)).toEqual(["a"]);
  });

  it("keeps an activity with no stories yet on the backbone", () => {
    const ws = board([activity("a"), activity("empty", "Later step"), ...story("s", "a", "MVP")]);
    const grid = storyMapGrid(ws);
    expect(grid.columns.map((c) => c.groupId)).toEqual(["a", "empty"]);
    expect(grid.columns[1]!.width).toBeGreaterThan(0);
  });

  it("widens a column to fit its activity's name", () => {
    const name = "Discover, compare and shortlist every option";
    const ws = board([activity("a", name), ...story("s", "a", "MVP")]);
    const grid = storyMapGrid(ws);
    const l = computeLayout(ws);
    expect(grid.columns[0]!.width).toBeGreaterThan(l.s!.size.width);
  });
});

describe("story map rows: the release slices", () => {
  it("orders releases by first appearance in story creation order, Unscheduled last", () => {
    const ws = board([
      activity("a"),
      activity("b"),
      ...story("u", "a"), // unscheduled, created first — still the last row
      ...story("r2", "a", "Release 2"),
      ...story("mvp", "b", "MVP"),
      ...story("r2b", "b", "Release 2"),
      ...story("r3", "a", "Release 3"),
    ]);
    const grid = storyMapGrid(ws);
    expect(grid.rows.map((r) => r.release)).toEqual(["Release 2", "MVP", "Release 3", null]);
    expect(grid.rows.map((r) => r.label)).toEqual([
      "Release 2",
      "MVP",
      "Release 3",
      STORY_MAP_UNSCHEDULED,
    ]);
    // Rows run top to bottom without overlapping.
    for (let i = 1; i < grid.rows.length; i++) {
      const prev = grid.rows[i - 1]!;
      expect(grid.rows[i]!.y).toBeGreaterThan(prev.y + prev.height);
    }
    const l = computeLayout(ws);
    expect(cellOf(grid, l, "r2")).toEqual([0, 0]);
    expect(cellOf(grid, l, "r2b")).toEqual([1, 0]);
    expect(cellOf(grid, l, "mvp")).toEqual([1, 1]);
    expect(cellOf(grid, l, "r3")).toEqual([0, 2]);
    expect(cellOf(grid, l, "u")).toEqual([0, 3]);
  });

  it("reads the release from the FIRST label only, trimmed", () => {
    const ws = board([
      activity("a"),
      ...story("s1", "a", "MVP", "backend"),
      ...story("s2", "a", " MVP "),
      ...story("s3", "a", "backend"),
    ]);
    const grid = storyMapGrid(ws);
    expect(grid.rows.map((r) => r.release)).toEqual(["MVP", "backend"]);
  });

  it("has no Unscheduled row when every story has a release", () => {
    const ws = board([activity("a"), ...story("s", "a", "MVP")]);
    expect(storyMapGrid(ws).rows.map((r) => r.release)).toEqual(["MVP"]);
  });

  it("shares each row's height across its cells, so a slice is one straight band", () => {
    const ws = board([
      activity("a"),
      activity("b"),
      ...story("a1", "a", "MVP"),
      ...story("a2", "a", "MVP"),
      ...story("a3", "a", "MVP"),
      ...story("b1", "b", "MVP"),
      ...story("b2", "b", "Release 2"),
      ...story("a4", "a", "Release 2"),
    ]);
    const grid = storyMapGrid(ws);
    const l = computeLayout(ws);
    // Release 2 starts below the tallest MVP cell (activity a's three stories)
    // in EVERY column — b's short MVP cell does not pull b2 up.
    expect(top(l, "b2")).toBe(top(l, "a4"));
    expect(top(l, "b2")).toBeGreaterThan(l.a3!.position.y + l.a3!.size.height);
    expect(grid.rows[0]!.height).toBeGreaterThanOrEqual(
      l.a3!.position.y + l.a3!.size.height - grid.rows[0]!.y,
    );
  });
});

describe("story map cells", () => {
  const busy = () =>
    board([
      activity("find", "Find a product"),
      activity("buy", "Buy it"),
      activity("track", "Track the order"),
      ...story("s1", "find", "MVP"),
      ...story("s2", "find", "MVP"),
      ...story("s3", "buy", "MVP"),
      ...story("s4", "find", "Release 2"),
      ...story("s5", "buy", "Release 2"),
      ...story("s6", "buy", "Release 2"),
      ...story("s7", "track"),
      ...story("s8", undefined, "MVP"),
      {
        op: "CHANGE_TEXT",
        id: "s2",
        text: "A much longer story title that wraps onto a second line of its card",
      },
    ]);

  it("stacks a cell's stories top-down in creation order, without overlap", () => {
    const l = computeLayout(busy());
    expect(top(l, "s1")).toBeLessThan(top(l, "s2"));
    expect(l.s1!.position.y + l.s1!.size.height).toBeLessThan(top(l, "s2"));
    expect(top(l, "s5")).toBeLessThan(top(l, "s6"));
  });

  it("puts every story in its (activity, release) cell and no two cards overlap", () => {
    const ws = busy();
    const l = computeLayout(ws);
    const grid = storyMapGrid(ws);
    const expected: Record<string, [number, number]> = {
      s1: [0, 0],
      s2: [0, 0],
      s3: [1, 0],
      s4: [0, 1],
      s5: [1, 1],
      s6: [1, 1],
      s7: [2, 2],
      s8: [3, 0],
    };
    for (const [id, cell] of Object.entries(expected))
      expect(cellOf(grid, l, id), id).toEqual(cell);
    const ids = Object.keys(ws.nodes);
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        expect(overlaps(l, ids[i]!, ids[j]!), `${ids[i]} × ${ids[j]}`).toBe(false);
      }
    }
  });

  it("leaves the backbone band and the release gutter clear of stories", () => {
    const ws = busy();
    const l = computeLayout(ws);
    const grid = storyMapGrid(ws);
    for (const placed of Object.values(l)) {
      expect(placed.position.y).toBeGreaterThan(grid.header.y + grid.header.height);
      expect(placed.position.x).toBeGreaterThan(grid.gutter.x + grid.gutter.width);
      // And the whole map's bounds hold every card.
      expect(placed.position.x + placed.size.width).toBeLessThanOrEqual(
        grid.bounds.x + grid.bounds.width,
      );
      expect(placed.position.y + placed.size.height).toBeLessThanOrEqual(
        grid.bounds.y + grid.bounds.height,
      );
    }
  });

  it("is deterministic, and edges never move a card", () => {
    const ws = busy();
    const once = computeLayout(ws);
    expect(computeLayout(structuredClone(ws))).toEqual(once);
    const linked = applyOperations(ws, [
      { op: "CONNECT_NODES", source: "s1", target: "s5", relationship: "enables" },
      { op: "CONNECT_NODES", source: "s7", target: "s1", relationship: "needs" },
    ]);
    expect(computeLayout(linked)).toEqual(once);
  });
});

describe("story map with hand-placed stories", () => {
  it("keeps a pinned story where the user put it, and its slot in the grid", () => {
    const ws = board([activity("a"), ...story("s1", "a", "MVP"), ...story("s2", "a", "MVP")]);
    const before = computeLayout(ws);
    const placed = applyLayout(ws, before);
    const pinned: Workspace = {
      ...placed,
      nodes: {
        ...placed.nodes,
        s1: { ...placed.nodes.s1!, position: { x: -900, y: -900 }, pinned: true },
      },
    };
    // The pinned card still holds its slot: the grid does not reshuffle.
    expect(computeLayout(pinned)).toEqual(before);
    const after = applyLayout(pinned, computeLayout(pinned));
    expect(after.nodes.s1!.position).toEqual({ x: -900, y: -900 });
    expect(after.nodes.s2!.position).toEqual(before.s2!.position);
  });

  it("declines a single-column relayout, so callers run the board pass", () => {
    // Re-laying out one activity alone would stack its stories against its
    // own releases and misalign them with the other columns' rows.
    const ws = board([
      activity("a"),
      activity("b"),
      ...story("a1", "a", "MVP"),
      ...story("b1", "b", "Release 2"),
    ]);
    const placed = applyLayout(ws, computeLayout(ws));
    expect(relayoutRegion(placed, "a")).toBeNull();
    expect(relayoutRegionWithRoutes(placed, "b")).toBeNull();
  });
});

describe("story map with a region on the board", () => {
  it("lays the board's own stories out as a map beside the region", () => {
    const ws = board([
      activity("a"),
      ...story("s1", "a", "MVP"),
      ...story("s2", "a", "Release 2"),
      { op: "CREATE_NODE", id: "f1", nodeType: "step", label: "Step one", groupId: "flow" },
      { op: "CREATE_NODE", id: "f2", nodeType: "step", label: "Step two", groupId: "flow" },
      {
        op: "CREATE_GROUP",
        id: "flow",
        label: "Checkout flow",
        children: ["f1", "f2"],
        kind: "flowchart",
      },
      { op: "CONNECT_NODES", source: "f1", target: "f2", relationship: "then" },
    ]);
    const l = computeLayout(ws);
    for (const id of ["s1", "s2", "f1", "f2"]) expect(l[id]?.position, id).toBeDefined();
    // The map part still slices by release.
    expect(top(l, "s1")).toBeLessThan(top(l, "s2"));
    expect(cx(l, "s1")).toBeCloseTo(cx(l, "s2"), 5);
  });
});
