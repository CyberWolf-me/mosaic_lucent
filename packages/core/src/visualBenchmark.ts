/**
 * The visual benchmark's measurement layer (the 2026-09 advisory review's
 * Phase-1 ask, answered the repo's way: measure before building). Pure
 * geometry over a laid-out workspace — no DOM, no rendering — so the same
 * numbers run in vitest, in CI, and in the live browser pass.
 *
 * What each metric means, and what it is FOR:
 *
 * - crossings — two edges whose line segments intersect. The single best
 *   mechanical proxy for "the eye must work to follow this" (the live pass's
 *   V-class findings: a return edge crossing the whole canvas). Not every
 *   crossing is a defect — but a layout regression that doubles crossings is
 *   one, and this is how the ELK-vs-ours question gets answered by numbers
 *   instead of taste.
 * - nodeOverlaps — two node boxes intersecting. A layout bug when non-zero:
 *   computeLayout's packing is supposed to prevent it. Surfaced as its own
 *   count because "overlapped" and "hard to follow" are different failures.
 * - edgeLength mean/p95 — long edges span attention across the canvas; the
 *   mean tracks overall sprawl, the p95 catches the one return edge that
 *   crosses everything.
 * - edgeLengthPerNode — the honest comparable: raw means fall with node
 *   count simply because the canvas fills up; per-node normalises scale
 *   away so 20- and 500-node boards can share one column.
 * - offscreenEntries — nodes/edges with no finite geometry: the "label
 *   collapse"/wrap class where content escapes its box.
 * - layoutMs — layout compute time. Recorded, never the success metric
 *   (the review's warning, taken literally: 2–8ms interaction is excellent
 *   and irrelevant if the board is unreadable).
 *
 * Deliberately NOT here: 10-second comprehension and manual-cleanup time —
 * human-judged metrics that belong to the live eval protocol
 * (docs/eval-results), not to a deterministic harness. This module owns the
 * mechanical half; the eval owns the human half; decisions want both.
 */

import type { Edge, Node, Position, Workspace } from "./model.js";
import {
  applyLayout,
  applyRoutes,
  computeLayout,
  computeLayoutWithRoutes,
  relayoutRegionWithRoutes,
  type LayoutOptions,
  type LayoutResult,
} from "./layout.js";
import { routeStyleFor, routedVertices, type RouteStyle } from "./routing.js";

/** One line segment in canvas coordinates. */
interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** A placed node box in canvas coordinates. */
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface VisualMetrics {
  nodeCount: number;
  edgeCount: number;
  /** Edge-segment intersections (node-boundary to node-boundary centres). */
  crossings: number;
  /** Node boxes that intersect each other (a layout defect when > 0). */
  nodeOverlaps: number;
  /** Mean node-centre to node-centre edge length, in canvas units. */
  edgeLengthMean: number;
  /** 95th-percentile edge length — the "one edge crossing everything" tell. */
  edgeLengthP95: number;
  /** edgeLengthMean / nodeCount — scale-normalised, for cross-size columns. */
  edgeLengthPerNode: number;
  /** Nodes/edges lacking finite geometry after layout. */
  offscreenEntries: number;
  /** Wall-clock layout compute, ms (advisory: never the success criterion). */
  layoutMs: number;
  /** Mean routed bend points per edge (0 = straight diagonals dominate). */
  edgeBendsMean: number;
  /**
   * Edges whose drawn polyline enters a node box other than their own
   * endpoints — the mechanical stand-in for the "label/objects collide"
   * readability class: an edge through a card obscures exactly the content
   * the board exists to show.
   */
  edgesThroughNodes: number;
  /** Σ node-box area ÷ layout bounding-box area (packing tightness, 0–1). */
  viewportCoverage: number;
  /**
   * Mean intra-region edge length ÷ mean cross-region edge length. Null
   * when the board has no group membership to compare (the metric asks:
   * does the layout keep a region's own story short?). Board-flow edges
   * (both endpoints ungrouped) belong to neither set.
   */
  cohesionRatio: number | null;
}

/** Orientation-independent segment intersection, endpoints inclusive.
 *
 * The standard orientation-product test, in the form that treats each
 * segment's endpoints symmetrically: a and b intersect (properly) when
 * b's endpoints lie on opposite sides of a's line AND a's endpoints lie on
 * opposite sides of b's line. Shared endpoints produce a zero product on
 * one side and are excluded by the strict `< 0`.
 */
function segmentsCross(a: Segment, b: Segment): boolean {
  // Cross product sign of a's direction against the b→endpoint arms.
  const o1 = (b.x1 - a.x1) * (a.y2 - a.y1) - (b.y1 - a.y1) * (a.x2 - a.x1);
  const o2 = (b.x2 - a.x1) * (a.y2 - a.y1) - (b.y2 - a.y1) * (a.x2 - a.x1);
  // And b's direction against the a→endpoint arms.
  const o3 = (a.x1 - b.x1) * (b.y2 - b.y1) - (a.y1 - b.y1) * (b.x2 - b.x1);
  const o4 = (a.x2 - b.x1) * (b.y2 - b.y1) - (a.y2 - b.y1) * (b.x2 - b.x1);
  // Strict signs on both: proper crossing only — shared endpoints and
  // collinear overlap do not count (they are not readability failures).
  return o1 * o2 < 0 && o3 * o4 < 0;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx] ?? 0;
}

/**
 * Measure a workspace's layout. `layout` may be pre-supplied (a real board's
 * geometry) or computed here from `options` (the benchmark path) — the metrics
 * are the same either way, which is what lets a synthetic run and a live
 * browser screenshot argue from one vocabulary. `routeStyleOverride` forces
 * the drawn style for routed edges (the --routing sweep's controlled
 * variable): the default is the board kind's own policy, exactly what the
 * renderer draws.
 */
export function measureVisualMetrics(
  workspace: Workspace,
  options: LayoutOptions = {},
  layout?: ReturnType<typeof computeLayout>,
  routeStyleOverride?: RouteStyle,
): VisualMetrics {
  const start = performance.now();
  const placed = layout ?? computeLayout(workspace, options);
  const layoutMs = performance.now() - start;

  const nodes = Object.values(workspace.nodes);
  const edges = Object.values(workspace.edges);
  const groupOf = new Map<string, string | null>();
  for (const node of nodes) groupOf.set(node.id, node.groupId ?? null);

  const boxes = new Map<string, Box>();
  let offscreenEntries = 0;
  for (const node of nodes) {
    const entry = placed[node.id];
    if (
      !entry ||
      !Number.isFinite(entry.position.x) ||
      !Number.isFinite(entry.position.y) ||
      !Number.isFinite(entry.size.width) ||
      !Number.isFinite(entry.size.height)
    ) {
      offscreenEntries++;
      continue;
    }
    boxes.set(node.id, {
      x: entry.position.x,
      y: entry.position.y,
      w: entry.size.width,
      h: entry.size.height,
    });
  }

  // Node-box overlaps: n² over boxes, fine at benchmark scales (500² = 250k
  // cheap intersection tests).
  let nodeOverlaps = 0;
  const boxList = [...boxes.values()];
  for (let i = 0; i < boxList.length; i++) {
    for (let j = i + 1; j < boxList.length; j++) {
      const a = boxList[i]!;
      const b = boxList[j]!;
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
        nodeOverlaps++;
      }
    }
  }

  // Edge segments: the DRAWN truth. An edge carrying a route draws as a
  // polyline (anchor → waypoints → anchor — each consecutive pair is a
  // segment); a route-less edge is the one straight centre-to-centre line
  // as before. The benchmark must measure what the renderer draws, or a
  // routing change reads as no change.
  const centres = new Map<string, { x: number; y: number }>();
  for (const [id, box] of boxes) centres.set(id, { x: box.x + box.w / 2, y: box.y + box.h / 2 });

  const segments: Segment[] = [];
  const lengths: number[] = [];
  const intraRegionLengths: number[] = [];
  const crossRegionLengths: number[] = [];
  let edgesThroughNodes = 0;
  let bendsTotal = 0;
  let edgesCounted = 0;
  for (const edge of edges) {
    const s = centres.get(edge.source);
    const t = centres.get(edge.target);
    if (!s || !t) {
      offscreenEntries++;
      continue;
    }
    edgesCounted++;
    // Phase 5 routing styles: the drawn vertices come from the shared
    // drawn-truth helper (routedVertices), which squares ortho corners —
    // the crossing/bend/through metrics must count what the renderer draws
    // per family, not the raw waypoint list. Route-less edges (no route)
    // keep the single centre-to-centre segment.
    const path =
      edge.route && edge.route.length > 0
        ? routedVertices(s, t, edge.route, routeStyleOverride ?? routeStyleFor(workspace.diagramKind))
        : [s, t];
    bendsTotal += path.length - 2;
    let edgeLength = 0;
    const edgeSegments: Segment[] = [];
    for (let i = 0; i + 1 < path.length; i++) {
      const a = path[i]!;
      const b = path[i + 1]!;
      const segment = { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
      edgeSegments.push(segment);
      segments.push(segment);
      const segLength = Math.hypot(b.x - a.x, b.y - a.y);
      // Per-segment `lengths` is the established edgeLength vocabulary (the
      // 2026-09-11 baseline); the per-edge total feeds only the new cohesion
      // metric, so the two scales stay comparable across reports.
      lengths.push(segLength);
      edgeLength += segLength;
    }
    // Through-node test: any drawn segment of this edge entering a node box
    // other than its own endpoints. Endpoints are node CENTRES, so the
    // source/target boxes are excluded by identity — everything else counts.
    const sourceGroup = groupOf.get(edge.source);
    const targetGroup = groupOf.get(edge.target);
    if (sourceGroup && targetGroup && sourceGroup === targetGroup) {
      intraRegionLengths.push(edgeLength);
    } else if (sourceGroup || targetGroup) {
      crossRegionLengths.push(edgeLength);
    }
    let through = false;
    for (const [nodeId, box] of boxes) {
      if (nodeId === edge.source || nodeId === edge.target) continue;
      if (edgeSegments.some((seg) => segmentHitsBox(seg, box))) {
        through = true;
        break;
      }
    }
    if (through) edgesThroughNodes++;
  }
  let crossings = 0;
  for (let i = 0; i < segments.length; i++) {
    for (let j = i + 1; j < segments.length; j++) {
      const s1 = segments[i];
      const s2 = segments[j];
      if (s1 && s2 && segmentsCross(s1, s2)) crossings++;
    }
  }
  lengths.sort((a, b) => a - b);
  const edgeLengthMean = lengths.length > 0 ? lengths.reduce((a, b) => a + b, 0) / lengths.length : 0;

  // Viewport coverage: how much of the layout's bounding box is actual node
  // content vs empty canvas the eye must cross. 1 = perfectly tight packing.
  let contentArea = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const box of boxes.values()) {
    contentArea += box.w * box.h;
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.w);
    maxY = Math.max(maxY, box.y + box.h);
  }
  const bboxArea = boxes.size > 0 ? (maxX - minX) * (maxY - minY) : 0;
  const mean = (xs: number[]) => (xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const cohesionRatio =
    intraRegionLengths.length > 0 && crossRegionLengths.length > 0
      ? mean(intraRegionLengths) / mean(crossRegionLengths)
      : null;

  return {
    nodeCount: nodes.length,
    edgeCount: edges.length,
    crossings,
    nodeOverlaps,
    edgeLengthMean,
    edgeLengthP95: percentile(lengths, 95),
    edgeLengthPerNode: nodes.length > 0 ? edgeLengthMean / nodes.length : 0,
    offscreenEntries,
    layoutMs,
    edgeBendsMean: edgesCounted > 0 ? bendsTotal / edgesCounted : 0,
    edgesThroughNodes,
    viewportCoverage: bboxArea > 0 ? contentArea / bboxArea : 0,
    cohesionRatio,
  };
}

/** Strict interior test — boundary contact is not "through". */
function pointInBox(p: { x: number; y: number }, b: Box): boolean {
  return p.x > b.x && p.x < b.x + b.w && p.y > b.y && p.y < b.y + b.h;
}

/** Does a drawn segment enter this node box (interior or boundary crossing)? */
function segmentHitsBox(seg: Segment, b: Box): boolean {
  if (pointInBox({ x: seg.x1, y: seg.y1 }, b) || pointInBox({ x: seg.x2, y: seg.y2 }, b)) {
    return true;
  }
  const edgesOfBox: Segment[] = [
    { x1: b.x, y1: b.y, x2: b.x + b.w, y2: b.y },
    { x1: b.x + b.w, y1: b.y, x2: b.x + b.w, y2: b.y + b.h },
    { x1: b.x, y1: b.y + b.h, x2: b.x + b.w, y2: b.y + b.h },
    { x1: b.x, y1: b.y, x2: b.x, y2: b.y + b.h },
  ];
  return edgesOfBox.some((boxEdge) => segmentsCross(seg, boxEdge));
}

/**
 * MOVEMENT AFTER EDIT (Phase 0): the spatial-additivity measurement. One
 * probe node is attached to the board's highest-degree node and the layout
 * re-runs; the metric is how much of the EXISTING board moves.
 *
 * Two paths, because Lucent has two truths about relayout:
 *  - fullRelayout — the whole board recomputed (the worst case; what a
 *    whole-graph engine like ELK does by default, and what Phase 4's
 *    acceptance test ("100 nodes + 1 → ≥98 pixel-identical") exists to
 *    prevent).
 *  - regionScoped — the app's actual commit path (ADR 0015): only the
 *    anchor's group re-lays out and everything outside restates its
 *    position, so movedOutsideRegion > 0 is a bug by construction. Recorded
 *    here so the baseline PROVES the invariant holds today, and so any
 *    future engine must preserve it. Undefined when the anchor is ungrouped.
 *
 * Half a pixel of float drift is not a "move" (MOVE_EPSILON).
 */

export interface MovementMetrics {
  nodeCount: number;
  fullRelayout: {
    movedCount: number;
    identicalCount: number;
    maxDisplacement: number;
  };
  regionScoped?: {
    groupId: string;
    movedOutsideRegion: number;
    movedInsideRegion: number;
    maxDisplacement: number;
  };
}

const MOVE_EPSILON = 0.5;

function displacementSummary(
  before: Map<string, Position>,
  nodesAfter: Workspace["nodes"],
): { movedCount: number; identicalCount: number; maxDisplacement: number } {
  let movedCount = 0;
  let compared = 0;
  let maxDisplacement = 0;
  for (const [id, pos] of before) {
    const after = nodesAfter[id]?.position;
    if (!after) continue;
    compared++;
    const d = Math.hypot(after.x - pos.x, after.y - pos.y);
    if (d > MOVE_EPSILON) {
      movedCount++;
      maxDisplacement = Math.max(maxDisplacement, d);
    }
  }
  return { movedCount, identicalCount: compared - movedCount, maxDisplacement };
}

export function measureMovementAfterEdit(
  workspace: Workspace,
  options: LayoutOptions = {},
): MovementMetrics {
  // The committed board: layout and routes stamped, exactly the state the
  // app's canvas renders from.
  const beforeOut = computeLayoutWithRoutes(workspace, options);
  const committed = applyRoutes(applyLayout(workspace, beforeOut.layout), beforeOut.routes);
  const before = new Map<string, Position>();
  for (const [id, entry] of Object.entries(beforeOut.layout)) before.set(id, entry.position);

  // The probe edit: one node attached to the highest-degree existing node
  // (deterministic tiebreak: lexicographically first id). It joins the
  // anchor's group when there is one — a new node lands where the work is.
  const degree = new Map<string, number>();
  for (const edge of Object.values(committed.edges)) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  let anchor: Node | undefined;
  for (const node of Object.values(committed.nodes)) {
    const d = degree.get(node.id) ?? 0;
    const anchorDegree = anchor ? (degree.get(anchor.id) ?? 0) : -1;
    if (!anchor || d > anchorDegree || (d === anchorDegree && node.id < anchor.id)) anchor = node;
  }
  if (!anchor) throw new Error("movement benchmark needs a non-empty board");

  const probeId = "probe-added-node";
  const edited: Workspace = {
    ...committed,
    nodes: {
      ...committed.nodes,
      [probeId]: {
        id: probeId,
        nodeType: "service",
        label: "Added step",
        groupId: anchor.groupId,
      },
    },
    edges: {
      ...committed.edges,
      "e-probe": { id: "e-probe", source: anchor.id, target: probeId, relationship: "calls" },
    },
  };

  // Path 1 — the worst case: the whole board recomputed.
  const fullOut = computeLayoutWithRoutes(edited, options);
  const fullRelayout = displacementSummary(before, applyLayout(edited, fullOut.layout).nodes);

  // Path 2 — the app's invariant: only the anchor's group re-lays out.
  let regionScoped: MovementMetrics["regionScoped"];
  if (anchor.groupId) {
    const regionOut = relayoutRegionWithRoutes(edited, anchor.groupId, options);
    if (regionOut) {
      const relaid = applyRoutes(applyLayout(edited, regionOut.layout), regionOut.routes);
      const members = new Set(
        Object.values(relaid.nodes)
          .filter((n) => n.groupId === anchor!.groupId)
          .map((n) => n.id),
      );
      let movedOutside = 0;
      let movedInside = 0;
      let maxDisplacement = 0;
      for (const [id, pos] of before) {
        const after = relaid.nodes[id]?.position;
        if (!after) continue;
        const d = Math.hypot(after.x - pos.x, after.y - pos.y);
        if (d > MOVE_EPSILON) {
          if (members.has(id)) movedInside++;
          else movedOutside++;
          maxDisplacement = Math.max(maxDisplacement, d);
        }
      }
      regionScoped = {
        groupId: anchor.groupId,
        movedOutsideRegion: movedOutside,
        movedInsideRegion: movedInside,
        maxDisplacement,
      };
    }
  }

  return { nodeCount: Object.keys(workspace.nodes).length, fullRelayout, regionScoped };
}
