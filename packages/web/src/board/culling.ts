import type { Shape, Workspace } from "@lucent/core";
import { toScene, type PlacedEdge, type PlacedNode } from "../scene.js";
import type { Box } from "./geometry.js";

/**
 * Viewport culling for the canvas render path (M3 performance).
 *
 * A 1k-object board used to mount 1k DOM subtrees and re-create every one of
 * them on every pan, zoom, hover and selection change. Culling is a *render*
 * optimisation only: everything here derives from the whole workspace and then
 * narrows the list handed to React. Nothing that computes geometry, bounds,
 * hit-testing or exports may consume a culled list — the frame box and the
 * group boxes below are deliberately measured over all members before the
 * visible subset is chosen, and connector anchors resolve through `byId`, which
 * always holds every node.
 *
 * Pure and DOM-free, so the whole thing is testable in the node vitest env
 * (test/perf-culling.test.ts).
 */

/** A content-space rectangle as min/max pairs — the form a hit test wants. */
export interface Rect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Boards smaller than this render in full. Culling costs an O(n) scan plus a
 * few allocations per frame, which is pure overhead on the boards people
 * actually have; the win only appears once the DOM cost dominates. The plan's
 * threshold is ">500 nodes" and nodes are only part of the object count, so
 * this sits below it deliberately.
 */
export const CULL_MIN_OBJECTS = 300;

/**
 * Extra margin around the viewport, as a fraction of its size on each side, so
 * a pan reveals objects that are already mounted instead of flashing empty
 * space. 0.5 keeps a screenful on every side (4x the visible area) — enough
 * that an ordinary drag does not outrun it, small enough that a 1k board still
 * renders a fraction of itself.
 */
export const CULL_MARGIN = 0.5;

/** Padding between a semantic group's member cards and its drawn box. */
const GROUP_PAD = 22;

/** A drawn box around one semantic group's laid-out members. */
export interface GroupRegion {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The live drag delta shared by every node in the dragged selection. */
export interface DragDelta {
  ids: ReadonlySet<string>;
  dx: number;
  dy: number;
}

/**
 * Everything the diagram render path needs that depends only on the workspace,
 * so a caller can memoise it and stop re-deriving it per frame.
 */
export interface DiagramScene {
  nodes: PlacedNode[];
  edges: PlacedEdge[];
  /** Every node by id — connector anchors must never see a culled set. */
  byId: Map<string, PlacedNode>;
  groups: GroupRegion[];
  /** Bounds over *all* nodes; null on an empty board. */
  bounds: Box | null;
}

/**
 * Bounding box over the given placed nodes. A loop rather than
 * `Math.min(...nodes.map(...))`: the spread form allocates four arrays per call
 * and throws RangeError once a board is big enough to pass the argument limit,
 * which is the opposite of what a large-board path should do.
 */
export function nodeBounds(nodes: readonly PlacedNode[]): Box | null {
  if (nodes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    const l = n.cx - n.w / 2;
    const t = n.cy - n.h / 2;
    if (l < minX) minX = l;
    if (t < minY) minY = t;
    if (l + n.w > maxX) maxX = l + n.w;
    if (t + n.h > maxY) maxY = t + n.h;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Group boxes, measured over every member the lookup resolves. `lookup` exists
 * so a drag can feed shifted positions in without rebuilding the scene. Groups
 * whose members are not laid out yet are skipped rather than drawn at the origin.
 */
export function groupRegions(
  workspace: Workspace,
  lookup: (id: string) => PlacedNode | undefined,
): GroupRegion[] {
  const regions: GroupRegion[] = [];
  for (const g of Object.values(workspace.groups)) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let members = 0;
    for (const id of g.children) {
      const n = lookup(id);
      if (!n) continue;
      members++;
      const l = n.cx - n.w / 2;
      const t = n.cy - n.h / 2;
      if (l < minX) minX = l;
      if (t < minY) minY = t;
      if (l + n.w > maxX) maxX = l + n.w;
      if (t + n.h > maxY) maxY = t + n.h;
    }
    if (members === 0) continue;
    regions.push({
      id: g.id,
      label: g.label,
      x: minX - GROUP_PAD,
      y: minY - GROUP_PAD,
      width: maxX - minX + GROUP_PAD * 2,
      height: maxY - minY + GROUP_PAD * 2,
    });
  }
  return regions;
}

/** Derive the whole-workspace scene: placed nodes, edges, group boxes, bounds. */
export function diagramScene(workspace: Workspace): DiagramScene {
  const { nodes, edges } = toScene(workspace);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return {
    nodes,
    edges,
    byId,
    groups: groupRegions(workspace, (id) => byId.get(id)),
    bounds: nodeBounds(nodes),
  };
}

/**
 * The rectangle to cull against, or null meaning "render everything". Null is
 * the safe answer and is returned whenever culling would be a guess: no
 * viewport reported yet (the first paint, and every read-only preview that
 * mounts a diagram without a camera), a degenerate box, or a board small enough
 * that the scan is not worth it.
 */
export function cullRect(
  viewport: Box | null | undefined,
  objectCount: number,
  margin = CULL_MARGIN,
): Rect | null {
  if (!viewport) return null;
  if (objectCount < CULL_MIN_OBJECTS) return null;
  if (!(viewport.width > 0) || !(viewport.height > 0)) return null;
  const mx = viewport.width * margin;
  const my = viewport.height * margin;
  return {
    minX: viewport.x - mx,
    minY: viewport.y - my,
    maxX: viewport.x + viewport.width + mx,
    maxY: viewport.y + viewport.height + my,
  };
}

/** Does an axis-aligned box overlap the cull rect? Touching edges do not count. */
export function overlaps(view: Rect, x: number, y: number, width: number, height: number): boolean {
  return x < view.maxX && x + width > view.minX && y < view.maxY && y + height > view.minY;
}

/**
 * Nodes worth mounting. `keep` forces ids to stay mounted wherever they are —
 * the selection, the drag group, an open rename editor — because unmounting the
 * node under the pointer mid-gesture would drop the gesture.
 */
export function visibleNodes(
  nodes: PlacedNode[],
  view: Rect | null,
  keep?: ReadonlySet<string>,
): PlacedNode[] {
  if (!view) return nodes;
  return nodes.filter(
    (n) => keep?.has(n.id) || overlaps(view, n.cx - n.w / 2, n.cy - n.h / 2, n.w, n.h),
  );
}

/**
 * Edges worth drawing. Tested against the box spanning both endpoint *cards*,
 * not against the endpoints' own visibility: an edge whose two nodes are both
 * off-screen on opposite sides still crosses the viewport and must draw. The pad
 * covers the fan offset a parallel edge's control points add (`makePath`'s
 * spread — a cubic bezier stays inside its control hull) plus the arrow marker.
 */
export function visibleEdges(
  edges: PlacedEdge[],
  byId: ReadonlyMap<string, PlacedNode>,
  view: Rect | null,
): PlacedEdge[] {
  if (!view) return edges;
  return edges.filter((e) => {
    const a = byId.get(e.source);
    const b = byId.get(e.target);
    if (!a || !b) return false;
    const pad = 8 + Math.ceil(e.parallelIndex / 2) * 18;
    const minX = Math.min(a.cx - a.w / 2, b.cx - b.w / 2) - pad;
    const minY = Math.min(a.cy - a.h / 2, b.cy - b.h / 2) - pad;
    const maxX = Math.max(a.cx + a.w / 2, b.cx + b.w / 2) + pad;
    const maxY = Math.max(a.cy + a.h / 2, b.cy + b.h / 2) + pad;
    return overlaps(view, minX, minY, maxX - minX, maxY - minY);
  });
}

/** Group boxes worth drawing; their extents were measured over all members. */
export function visibleGroups(groups: GroupRegion[], view: Rect | null): GroupRegion[] {
  if (!view) return groups;
  return groups.filter((g) => overlaps(view, g.x, g.y, g.width, g.height));
}

/** Manual shapes worth mounting, with the same `keep` escape hatch as nodes. */
export function visibleShapes(
  shapes: Shape[],
  view: Rect | null,
  keep?: ReadonlySet<string>,
): Shape[] {
  if (!view) return shapes;
  return shapes.filter(
    (s) =>
      keep?.has(s.id) || overlaps(view, s.position.x, s.position.y, s.size.width, s.size.height),
  );
}

/**
 * Move one node by the live drag delta, or hand it back untouched. Shifting only
 * the dragged ids keeps the memoised scene objects intact for everything else,
 * instead of re-mapping the whole node array on every pointer move.
 */
export function withDrag(n: PlacedNode, drag: DragDelta | null | undefined): PlacedNode {
  if (!drag || !drag.ids.has(n.id)) return n;
  return { ...n, cx: n.cx + drag.dx, cy: n.cy + drag.dy };
}

/**
 * Whole-board bounds with an in-flight drag applied. Only the dragged boxes are
 * re-measured and unioned in, so the frame still grows to follow a node pulled
 * past the old edge without rescanning every node per frame.
 */
export function boundsWithDrag(
  bounds: Box | null,
  byId: ReadonlyMap<string, PlacedNode>,
  drag: DragDelta | null | undefined,
): Box | null {
  if (!bounds || !drag || drag.ids.size === 0) return bounds;
  let minX = bounds.x;
  let minY = bounds.y;
  let maxX = bounds.x + bounds.width;
  let maxY = bounds.y + bounds.height;
  for (const id of drag.ids) {
    const n = byId.get(id);
    if (!n) continue;
    const l = n.cx - n.w / 2 + drag.dx;
    const t = n.cy - n.h / 2 + drag.dy;
    if (l < minX) minX = l;
    if (t < minY) minY = t;
    if (l + n.w > maxX) maxX = l + n.w;
    if (t + n.h > maxY) maxY = t + n.h;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
