import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  applyLayout,
  applyOperations,
  computeLayout,
  createWorkspace,
  starterFor,
  storyMapGrid,
  type Operation,
  type StoryMapGrid,
  type Workspace,
} from "@lucent/core";
import { diagramScene, groupRegions, placedStoryMap } from "../src/board/culling.js";
import { DiagramLayer } from "../src/ui/DiagramLayer.js";

/**
 * The story map's scaffold on the canvas (docs/27 D3): the backbone cards and
 * release slices DiagramLayer draws come from core's `storyMapGrid` — the same
 * pass that placed the stories — translated to where the cards actually sit.
 * These pin that the grid feeds the drawing, that it follows the cards when
 * applyLayout slides them, and that the activity boxes become whole columns.
 * DiagramLayer is rendered with react-dom/server: the suite runs in node (see
 * vite.config.ts), and static markup is all a positional contract needs.
 */

const laidOut = (ws: Workspace): Workspace => applyLayout(ws, computeLayout(ws));
const board = (ops: Operation[]): Workspace => laidOut(applyOperations(createWorkspace(), ops));
const starterBoard = (): Workspace => board(starterFor("storymap", "s"));

/** The (column, row) of the grid cell a placed card's box lies inside. */
function cellOf(grid: StoryMapGrid, ws: Workspace, id: string): [number, number] {
  const n = ws.nodes[id]!;
  const { x, y } = n.position!;
  const { width, height } = n.size!;
  return [
    grid.columns.findIndex((c) => x >= c.x && x + width <= c.x + c.width),
    grid.rows.findIndex((r) => y >= r.y && y + height <= r.y + r.height),
  ];
}

/** Every `<div class="{cls}…" style="…">text</div>` in static markup. */
function divs(
  html: string,
  cls: string,
): Array<{ cls: string; style: Record<string, number>; text: string }> {
  const re = new RegExp(`<div class="(${cls}[^"]*)" style="([^"]*)"[^>]*>([^<]*)</div>`, "g");
  return [...html.matchAll(re)].map((m) => ({
    cls: m[1]!,
    style: Object.fromEntries(
      m[2]!
        .split(";")
        .filter(Boolean)
        .map((kv) => {
          const [k, v] = kv.split(":");
          return [k!, Number.parseFloat(v!)];
        }),
    ),
    text: m[3]!,
  }));
}

const render = (ws: Workspace) =>
  renderToStaticMarkup(createElement(DiagramLayer, { workspace: ws }));

describe("placedStoryMap: the scaffold where the cards sit", () => {
  it("is null for other kinds and for a story map carrying a region", () => {
    expect(placedStoryMap(board(starterFor("matrix", "m")))).toBeNull();
    expect(placedStoryMap(board(starterFor("timeline", "t")))).toBeNull();
    const withRegion = board([
      ...starterFor("storymap", "s"),
      { op: "CREATE_NODE", id: "f1", nodeType: "step", label: "Step", groupId: "flow" },
      { op: "CREATE_GROUP", id: "flow", label: "Flow", children: ["f1"], kind: "flowchart" },
    ]);
    expect(placedStoryMap(withRegion)).toBeNull();
    expect(diagramScene(withRegion).storyMap).toBeNull();
  });

  it("is the layout's own grid when the board was laid out in place", () => {
    const ws = starterBoard();
    expect(placedStoryMap(ws)).toEqual(storyMapGrid(ws));
    expect(diagramScene(ws).storyMap).toEqual(storyMapGrid(ws));
  });

  it("follows the cards when applyLayout slides them clear of a pinned one", () => {
    // Pin one story on top of another's slot: the next layout pass slides the
    // whole unpinned block down past it, and the scaffold must slide too.
    const base = starterBoard();
    const pinned: Workspace = {
      ...base,
      nodes: {
        ...base.nodes,
        "s-search": {
          ...base.nodes["s-search"]!,
          position: { ...base.nodes["s-cart"]!.position! },
          pinned: true,
        },
      },
    };
    const after = laidOut(pinned);
    const dy = after.nodes["s-cart"]!.position!.y - base.nodes["s-cart"]!.position!.y;
    expect(dy).toBeGreaterThan(0);
    const grid = placedStoryMap(after)!;
    expect(grid.header.y).toBe(storyMapGrid(after).header.y + dy);
    expect(cellOf(grid, after, "s-cart")).toEqual([1, 0]);
    expect(cellOf(grid, after, "s-filter")).toEqual([0, 1]);
    expect(cellOf(grid, after, "s-applepay")).toEqual([1, 1]);
  });
});

describe("diagramScene: an activity's box is its whole column", () => {
  const withEmptyActivity = () =>
    board([
      ...starterFor("storymap", "s"),
      { op: "CREATE_GROUP", id: "s-track", label: "Track the order", children: [] },
    ]);

  it("gives every activity the same full-height band, an empty one included", () => {
    const ws = withEmptyActivity();
    const scene = diagramScene(ws);
    const grid = scene.storyMap!;
    expect(scene.groups.map((g) => g.id)).toEqual(["s-find", "s-buy", "s-track"]);
    expect(new Set(scene.groups.map((g) => g.height)).size).toBe(1);
    for (const box of scene.groups) {
      const col = grid.columns.find((c) => c.groupId === box.id)!;
      expect(box.x).toBeLessThan(col.x);
      expect(box.x + box.width).toBeGreaterThan(col.x + col.width);
      // From above the backbone card to below the last release.
      expect(box.y).toBeLessThan(grid.header.y);
      expect(box.y + box.height).toBeGreaterThan(grid.bounds.y + grid.bounds.height);
    }
    // Neighbouring columns' bands never touch.
    for (let i = 1; i < scene.groups.length; i++) {
      const prev = scene.groups[i - 1]!;
      expect(scene.groups[i]!.x).toBeGreaterThan(prev.x + prev.width);
    }
  });

  it("still holds a card dragged out of the grid inside its activity's box", () => {
    // The live-drag path: DiagramLayer re-measures the boxes through a
    // drag-shifted lookup, handing the scene's scaffold back in.
    const ws = starterBoard();
    const scene = diagramScene(ws);
    const search = scene.byId.get("s-search")!;
    const dragged = { ...search, cy: search.cy + 5000 };
    const lookup = (id: string) => (id === "s-search" ? dragged : scene.byId.get(id));
    const find = groupRegions(ws, lookup, scene.storyMap).find((g) => g.id === "s-find")!;
    expect(find.y + find.height).toBeGreaterThan(dragged.cy + dragged.h / 2);
    // The band still starts above the backbone card: the column stays whole.
    expect(find.y).toBeLessThan(scene.storyMap!.header.y);
  });
});

describe("DiagramLayer draws the backbone and the release slices from the grid", () => {
  it("puts one backbone card over each column, named for its activity", () => {
    const ws = starterBoard();
    const grid = placedStoryMap(ws)!;
    const cards = divs(render(ws), "storymap-activity");
    expect(cards.map((c) => c.text)).toEqual(["Find a product", "Buy it"]);
    cards.forEach((card, i) => {
      expect(card.style.left).toBe(grid.columns[i]!.x);
      expect(card.style.width).toBe(grid.columns[i]!.width);
      expect(card.style.top).toBe(grid.header.y);
      expect(card.style.height).toBe(grid.header.height);
    });
  });

  it("names each release in the gutter and cuts a slice line above it", () => {
    const ws = board([
      ...starterFor("storymap", "s"),
      { op: "CREATE_NODE", id: "later", nodeType: "story", label: "Gift wrap", groupId: "s-buy" },
    ]);
    const grid = placedStoryMap(ws)!;
    const html = render(ws);
    const labels = divs(html, "storymap-release");
    expect(labels.map((l) => l.text)).toEqual(["MVP", "Release 2", "Unscheduled"]);
    expect(labels.at(-1)!.cls).toContain("unscheduled");
    labels.forEach((label, i) => {
      expect(label.style.top).toBe(grid.rows[i]!.y);
      expect(label.style.left).toBe(grid.gutter.x);
      expect(label.style.width).toBe(grid.gutter.width);
    });
    const slices = divs(html, "storymap-slice");
    expect(slices).toHaveLength(grid.rows.length);
    slices.forEach((slice, i) => {
      const row = grid.rows[i]!;
      const prev = grid.rows[i - 1];
      const above = prev ? prev.y + prev.height : grid.header.y + grid.header.height;
      // In the gap above its release, clear of every card.
      expect(slice.style.top).toBeGreaterThan(above);
      expect(slice.style.top).toBeLessThan(row.y);
      // Across the whole map, gutter included.
      expect(slice.style.left).toBe(grid.gutter.x);
      expect(slice.style.left! + slice.style.width!).toBeGreaterThan(
        grid.bounds.x + grid.bounds.width,
      );
    });
  });

  it("gives stories with no activity a quieter Other card", () => {
    const ws = board([
      ...starterFor("storymap", "s"),
      { op: "CREATE_NODE", id: "loose", nodeType: "story", label: "Loose story" },
    ]);
    const cards = divs(render(ws), "storymap-activity");
    expect(cards.at(-1)!.text).toBe("Other");
    expect(cards.at(-1)!.cls).toContain("other");
  });

  it("drops the activity pills the backbone cards replace, and frames the gutter", () => {
    const ws = starterBoard();
    const grid = placedStoryMap(ws)!;
    const html = render(ws);
    expect(html).not.toContain("group-region-label");
    const frame = divs(html.replace(/<div class="frame-label">[^<]*<\/div>/, ""), "frame")[0]!;
    expect(frame.style.left).toBeLessThan(grid.gutter.x);
    expect(frame.style.top).toBeLessThan(grid.header.y);
  });

  it("draws no scaffold on any other board", () => {
    for (const kind of ["matrix", "timeline", "process"] as const) {
      expect(render(board(starterFor(kind, "k")))).not.toContain("storymap-");
    }
  });
});
