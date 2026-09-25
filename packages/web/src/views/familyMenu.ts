import {
  convertibleKinds,
  getRepresentation,
  regionKinds,
  representationLabel,
  type DiagramKind,
  type RepresentationCategory,
  type Workspace,
} from "@lucent/core";
import type { Camera } from "../ui/atoms.js";
import type { MenuItem } from "./ContextMenu.js";

/**
 * The canvas context menu's diagram-family section (V4): "Convert board to…",
 * a region's kind picker, and "Make <group> a region" — every list generated
 * from the representation registry, so a new family appears in the menus with
 * no edit here. Also the geometry that decides what a right-click landed on.
 *
 * Pure and DOM-free (the node vitest env tests it); CanvasView only wires the
 * callbacks and reads the pointer.
 */

/** Section headings for the family categories, in the order they first appear. */
const CATEGORY_TITLE: Record<RepresentationCategory, string> = {
  flow: "Flow & process",
  structure: "Structure",
  planning: "Planning",
};

export interface FamilySection {
  category: RepresentationCategory;
  title: string;
  kinds: DiagramKind[];
}

/**
 * The "Convert board to…" targets grouped by category. Categories come in the
 * registry's order of first appearance and kinds keep registry order within
 * one, so the picker reads the same way the AI's catalog does.
 */
export function convertSections(): FamilySection[] {
  const byCategory = new Map<RepresentationCategory, DiagramKind[]>();
  for (const kind of convertibleKinds()) {
    const { category } = getRepresentation(kind);
    const list = byCategory.get(category) ?? [];
    list.push(kind);
    byCategory.set(category, list);
  }
  return [...byCategory].map(([category, kinds]) => ({
    category,
    title: CATEGORY_TITLE[category],
    kinds,
  }));
}

const noop = (): void => {};
const SEP: MenuItem = { label: "", onClick: noop, sep: true };

export interface FamilyMenuInput {
  workspace: Workspace;
  /**
   * The semantic group the right-click is about — the node's group, or the
   * region whose label or box was clicked. A group with a kind is a region; a
   * plain one can become one.
   */
  groupId?: string | undefined;
  /** `boardIsBlank(workspace)`: picking a kind seeds its starter. */
  blank: boolean;
  onConvert: (kind: DiagramKind) => void;
  onRegionKind: (groupId: string, kind: DiagramKind | null) => void;
}

/**
 * The family rows of the context menu, each a drill-in submenu:
 *  - on a region: its kind picker (regionKinds — families that can live inside
 *    another board) plus "Back to board layout";
 *  - on a plain group: "Make '<label>' a region", the same picker;
 *  - always: "Convert board to…" (convertibleKinds, grouped by category, each
 *    family's summary as its tooltip).
 * On a blank board the current kind stays pickable — choosing it seeds the
 * starter, which is the only way to get an example of the default family.
 */
export function familyMenuItems(input: FamilyMenuInput): MenuItem[] {
  const { workspace, blank, onConvert, onRegionKind } = input;
  const items: MenuItem[] = [];
  const group = input.groupId ? workspace.groups[input.groupId] : undefined;
  if (group) {
    const name = group.label.trim() || "this group";
    const kindRows: MenuItem[] = regionKinds().map((k) => ({
      label: representationLabel(k),
      title: getRepresentation(k).summary,
      checked: group.kind === k,
      disabled: group.kind === k,
      onClick: () => onRegionKind(group.id, k),
    }));
    if (group.kind) {
      items.push({
        label: `Region "${name}" — ${representationLabel(group.kind)}`,
        onClick: noop,
        submenu: [
          ...kindRows,
          SEP,
          { label: "Back to board layout", onClick: () => onRegionKind(group.id, null) },
        ],
      });
    } else {
      items.push({
        label: `Make "${name}" a region`,
        title: "Lay this group out as its own diagram inside the board",
        onClick: noop,
        submenu: kindRows,
      });
    }
  }
  const convertRows: MenuItem[] = [];
  for (const section of convertSections()) {
    convertRows.push({ label: section.title, onClick: noop, header: true });
    for (const k of section.kinds) {
      const active = workspace.diagramKind === k;
      convertRows.push({
        label: representationLabel(k),
        title: getRepresentation(k).summary,
        checked: active,
        disabled: active && !blank,
        onClick: () => onConvert(k),
      });
    }
  }
  items.push({ label: "Convert board to…", onClick: noop, submenu: convertRows });
  return items;
}

/* -------------------------------------------------------------------------- */
/* What a right-click landed on                                               */
/* -------------------------------------------------------------------------- */

export type CanvasMenuTarget =
  | { kind: "node"; id: string }
  | { kind: "region"; id: string }
  | { kind: "background" };

/** What the DOM says was under the pointer; the geometry says which one. */
export type CanvasHitHint = "node" | "region" | "background";

interface HitNode {
  id: string;
  cx: number;
  cy: number;
  w: number;
  h: number;
}

interface HitGroup {
  id: string;
  label: string;
  kind?: DiagramKind | undefined;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Screen → content coordinates, inverting CanvasViewport's transform exactly
 * (`translate(pan) scale(zoom)` about 50% / 40% of the viewport box). `client`
 * is the pointer's clientX/Y and `box` the viewport element's client rect.
 */
export function clientToContent(
  client: { x: number; y: number },
  box: { left: number; top: number; width: number; height: number },
  camera: Camera,
): { x: number; y: number } {
  const s = camera.zoom / 100;
  const ox = 0.5 * box.width;
  const oy = 0.4 * box.height;
  return {
    x: (client.x - box.left - camera.pan.x - ox) / s + ox,
    y: (client.y - box.top - camera.pan.y - oy) / s + oy,
  };
}

/**
 * Which node or region a right-click at content `point` is about. The DOM
 * classifies the target (a card, a region's box or label pill, the empty
 * canvas) but carries no ids, so the laid-out scene resolves which one — the
 * smallest box containing the point, since a nested region or a card sits on
 * top of the larger box behind it. A region's label pill rides its top edge
 * (DiagramLayer: 9px above the box), so a click on the pill still names it.
 */
export function canvasTargetAt(
  scene: { nodes: readonly HitNode[]; groups: readonly HitGroup[] },
  point: { x: number; y: number },
  hint: CanvasHitHint,
): CanvasMenuTarget {
  if (hint === "node") {
    let best: HitNode | null = null;
    for (const n of scene.nodes) {
      const inside = Math.abs(point.x - n.cx) <= n.w / 2 && Math.abs(point.y - n.cy) <= n.h / 2;
      if (inside && (!best || n.w * n.h < best.w * best.h)) best = n;
    }
    return best ? { kind: "node", id: best.id } : { kind: "background" };
  }
  if (hint === "region") {
    let best: HitGroup | null = null;
    for (const g of scene.groups) {
      const inside =
        point.x >= g.x && point.x <= g.x + g.width && point.y >= g.y && point.y <= g.y + g.height;
      if (inside && (!best || g.width * g.height < best.width * best.height)) best = g;
    }
    if (best) return { kind: "region", id: best.id };
    // The pill poking above the box: same width rule DiagramLayer uses to
    // stack the pills (7px per character plus padding, from 12px in).
    for (const g of scene.groups) {
      const text = [g.label.trim(), g.kind ? representationLabel(g.kind) : ""]
        .filter((s) => s.length > 0)
        .join(" · ");
      const right = g.x + Math.max(g.width, 12 + text.length * 7 + 24);
      if (point.x >= g.x && point.x <= right && point.y >= g.y - 12 && point.y < g.y) {
        return { kind: "region", id: g.id };
      }
    }
  }
  return { kind: "background" };
}
