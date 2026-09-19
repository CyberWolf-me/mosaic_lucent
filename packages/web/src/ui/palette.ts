import type { View } from "../workspace.js";
import type { BoardSearchHit } from "../boards.js";

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
 *
 * Stage C4: on a shared board, the board family becomes SERVER search results
 * (nodes, transcript turns, revisions — the corpus the local scan cannot
 * see), grouped through groupSearchHits below.
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

/* -------------------------------------------------------------------------- */
/* Server search results (Stage C4)                                           */
/* -------------------------------------------------------------------------- */

export interface SearchGroup {
  nodes: BoardSearchHit[];
  turns: BoardSearchHit[];
  revisions: BoardSearchHit[];
  total: number;
}

/**
 * Group server search hits into the three render families, in arrival order
 * (the route already ranked them: score desc, node > turn > revision). Pure,
 * so the grouping decision is testable without the overlay.
 */
export function groupSearchHits(hits: readonly BoardSearchHit[]): SearchGroup {
  const nodes = hits.filter((h) => h.kind === "node");
  const turns = hits.filter((h) => h.kind === "turn");
  const revisions = hits.filter((h) => h.kind === "revision");
  return { nodes, turns, revisions, total: hits.length };
}

/** The hint line under a search hit: what it is, plus where it came from. */
export function searchHitHint(hit: BoardSearchHit): string {
  if (hit.kind === "node") {
    // With a statement, the kind is the chip the row shows anyway; the hint
    // carries status and topic — the fields the label does not.
    const statement = hit.statement
      ? ` · ${hit.statement.status}${hit.statement.topic ? ` · ${hit.statement.topic}` : ""}`
      : "";
    return `Node · ${hit.nodeType ?? "object"}${statement}`;
  }
  if (hit.kind === "turn") {
    const turn = hit.turnIndex !== undefined ? ` · turn ${hit.turnIndex}` : "";
    return `Transcript · ${hit.meetingId ?? hit.id}${turn}`;
  }
  const actor = hit.actorName ? ` · ${hit.actorName}` : "";
  return `Revision · ${hit.seq ?? hit.id}${actor}`;
}

/** The primary line of a search hit. */
export function searchHitTitle(hit: BoardSearchHit): string {
  if (hit.kind === "node") return hit.label ?? hit.id;
  if (hit.kind === "turn") return `${hit.speaker ?? "Speaker"}: "${hit.snippet ?? ""}"`;
  return `${hit.label ?? "Revision"}${hit.at ? ` (${new Date(hit.at).toISOString().slice(0, 10)})` : ""}`;
}

/**
 * The citation a search hit navigates through — the SAME handler and URL
 * params the AI pill's citations use (Stage C1): node → ?reveal, turn →
 * ?meeting + ?turn, revision → ?rev. Search never invents a fourth
 * navigation; it rides the existing one so the flash/highlight behavior
 * comes for free.
 */
export function searchHitTarget(
  hit: BoardSearchHit,
): { kind: "node" | "meeting" | "revision"; id: string; turnRange?: [number, number] } | null {
  if (hit.kind === "node") return { kind: "node", id: hit.id };
  if (hit.kind === "turn") {
    if (!hit.meetingId) return null;
    return {
      kind: "meeting",
      id: hit.meetingId,
      ...(hit.turnIndex !== undefined ? { turnRange: [hit.turnIndex, hit.turnIndex] } : {}),
    };
  }
  return { kind: "revision", id: String(hit.seq ?? hit.id) };
}
