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

import type { Edge, Workspace } from "./model.js";
import { computeLayout, type LayoutOptions } from "./layout.js";

/** One line segment in canvas coordinates. */
interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
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
 * browser screenshot argue from one vocabulary.
 */
export function measureVisualMetrics(
  workspace: Workspace,
  options: LayoutOptions = {},
  layout?: ReturnType<typeof computeLayout>,
): VisualMetrics {
  const start = performance.now();
  const placed = layout ?? computeLayout(workspace, options);
  const layoutMs = performance.now() - start;

  const nodes = Object.values(workspace.nodes);
  const edges = Object.values(workspace.edges);

  const boxes = new Map<string, { x: number; y: number; w: number; h: number }>();
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
  for (const edge of edges) {
    const s = centres.get(edge.source);
    const t = centres.get(edge.target);
    if (!s || !t) {
      offscreenEntries++;
      continue;
    }
    const path: Array<{ x: number; y: number }> = [s, ...(edge.route ?? []), t];
    for (let i = 0; i + 1 < path.length; i++) {
      const a = path[i]!;
      const b = path[i + 1]!;
      segments.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
      lengths.push(Math.hypot(b.x - a.x, b.y - a.y));
    }
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
  };
}
