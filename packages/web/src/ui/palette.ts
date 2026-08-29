import type { View } from "../workspace.js";

/**
 * The command palette's core (M7): pure functions, no DOM — the same testing
 * model as http.ts and geometry. The overlay is only the rendering; every
 * decision that can be wrong (what matches, what arrow keys do, what Enter
 * runs) lives here and is unit-tested.
 *
 * Three result families, in the order a user reaches for them:
 *   1. actions — the things a palette is for (undo/redo, navigate, new
 *      workspace, settings, export)
 *   2. views — the secondary surfaces, grouped under their header
 *   3. board hits — nodes and shapes on the open board, so the palette also
 *      doubles as jump-to-object search.
 * With no query at all, only actions + views show: a palette that dumps the
 * whole board on open is a list, not a palette.
 */

export type PaletteAction =
  | { kind: "undo" }
  | { kind: "redo" }
  | { kind: "newWorkspace" }
  | { kind: "settings"; section?: string }
  | { kind: "export" }
  | { kind: "view"; view: View };

export interface PaletteItem {
  id: string;
  label: string;
  hint: string;
  group: "action" | "view" | "board";
  run: PaletteAction;
}

export interface PaletteBoardHit {
  id: string;
  title: string;
  hint: string;
}

/** Case-insensitive substring match, diacritic-blind to match keyboard intent. */
function matches(text: string, needle: string): boolean {
  return text.toLowerCase().includes(needle);
}

export function filterItems(items: readonly PaletteItem[], query: string): PaletteItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...items];
  return items.filter(
    (it) => matches(it.label.toLowerCase(), q) || matches(it.hint.toLowerCase(), q),
  );
}

export function filterBoard(
  hits: readonly PaletteBoardHit[],
  query: string,
  limit = 8,
): PaletteBoardHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return hits
    .filter((h) => matches(h.title.toLowerCase(), q) || matches(h.hint.toLowerCase(), q))
    .slice(0, limit);
}

/**
 * One list to render, in the order it renders: matching actions, then views,
 * then board hits. `activeIndex` counts across the whole list — the overlay
 * owns one cursor, not one per group.
 */
export function buildResults(
  items: readonly PaletteItem[],
  boardHits: readonly PaletteBoardHit[],
  query: string,
): { actions: PaletteItem[]; views: PaletteItem[]; board: PaletteBoardHit[]; total: number } {
  const filtered = filterItems(items, query);
  const actions = filtered.filter((it) => it.group === "action");
  const views = filtered.filter((it) => it.group === "view");
  const board = filterBoard(boardHits, query);
  return { actions, views, board, total: actions.length + views.length + board.length };
}

/** Keyboard cursor arithmetic; clamps so an empty list can never go out of range. */
export function moveIndex(index: number, delta: number, total: number): number {
  if (total <= 0) return 0;
  return (index + delta + total) % total;
}
