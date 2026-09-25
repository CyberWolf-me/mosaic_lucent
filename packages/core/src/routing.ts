/**
 * ROUTING STYLE PER FAMILY (doc 18, Phase 5, advisory V10): which drawn path
 * a ROUTED edge (one carrying layout-stamped `Edge.route` bend points)
 * takes — polyline / ortho / spline — chosen per diagram kind, never forced
 * globally. Route-less edges (short hops the engine leaves straight, radial /
 * tree / swimlane families where no long-edge routing runs) are untouched:
 * they keep their bezier and this module says nothing about them.
 *
 * The table is DERIVED from the benchmark, not taste: the 2026-09-13 sweep
 * (scripts/visual-benchmark.ts --routing) measured each family's fixtures
 * under each style; see docs/eval-results/2026-09-13-routing-styles.md for
 * the numbers and the deliberately-not-measured list. The policy is a pure
 * function of the kind — nothing is persisted, nothing enters the op
 * contract, and the renderer/export/benchmark all ask the same function so
 * the drawn truth is one truth.
 *
 * Style semantics, over the SAME waypoints (bend points between the anchors):
 *   polyline — straight segments through each waypoint (the pre-Phase-5
 *              drawn corridor; the geometry the crossing metric was
 *              calibrated on)
 *   ortho    — each diagonal segment squared into an L at its dominant-axis
 *              elbow: the BPMN / flow convention for flow edges, and the
 *              measured winner on every routed fixture (see the table)
 *   spline   — Catmull-Rom through the waypoints, rounded corners; the
 *              longest corridors read as curves instead of sawtooth
 */

import { DIAGRAM_KINDS, type DiagramKind, type Position } from "./model.js";
import { getRepresentation } from "./representations.js";

/** The drawn-path vocabulary for routed edges. */
export type RouteStyle = "polyline" | "ortho" | "spline";

/** Which drawn style a routed edge of `kind` takes. Pure, deterministic. */
export function routeStyleFor(kind: DiagramKind): RouteStyle {
  return ROUTE_STYLE_FOR_KIND[kind];
}

/**
 * The measured table (benchmark sweep, 2026-09-13 —
 * `npx tsx scripts/visual-benchmark.ts --routing`). The four LAYERED kinds
 * are the only families whose long edges ever carry routes, and ortho won
 * every routed fixture on the primary metric: crossings 902→668 on the
 * layered ladder at 500 (−26%), 8396→3739 on dense (−55%), 2377→1093 on
 * adversarial (−54%), long-edge a tie. The honest costs, recorded with the
 * win: through-node entries +16% (the vertical elbow drop passes more
 * foreign boxes) and bend mean ~2–2.5× (layered 0.19→0.52, dense 1.20→2.45
 * at 500) — the layered ladder stays under 0.55 bends/edge; dense boards
 * draw more squared corners, the price of halving their crossings.
 * For bpmn/process, squared corners are also the OMG convention — numbers
 * and convention agree.
 *
 * Two measured-truth caveats, both on record in the eval note: (1) part of
 * ortho's crossing win rides on the vocabulary's recorded judgment that
 * collinear overlap is not a crossing failure — orthogonal corridors share
 * row/column lines and overlap instead of X-crossing — so the verdict is
 * provisional on the human-half pass, exactly as ADR 0039's is; (2) the
 * eMean column is per-SEGMENT, so more vertices mechanically shorten it —
 * not a fair cross-style comparison, which is why the decision cites
 * crossings and through-nodes only.
 *
 * spline stays in the vocabulary (the renderer draws it) but NO family
 * selects it today: its vertex skeleton is identical to polyline's, so the
 * mechanical half cannot see curvature at all — a spline verdict would
 * have to come from the human pass, and none is claimed here.
 *
 * The never-routing families (mindmap, decisiontree, orgchart, process
 * boards under the swimlane strategy) hold polyline as the inert default —
 * their edges carry no route, so routeStyleFor is never consulted for them.
 *
 * The values themselves now live in the representation registry
 * (`representations.ts`, docs/26 §6.1) — one table per family — and this map is
 * derived from it, so the benchmark verdict recorded here is applied from the
 * same place layout, labels and the convert menu read.
 */
const ROUTE_STYLE_FOR_KIND: Record<DiagramKind, RouteStyle> = Object.fromEntries(
  DIAGRAM_KINDS.map((kind) => [kind, getRepresentation(kind).route]),
) as Record<DiagramKind, RouteStyle>;

/**
 * The vertices an edge actually draws between its two anchors, under
 * `style` — the ONE drawn-truth derivation shared by the canvas path
 * (makePath), the edge-label midpoint, culling spans, the SVG export, and
 * the visual benchmark's crossing count. All consumers must use this (not
 * their own ad-hoc point list) so what is measured is what is drawn.
 *
 *   polyline — [a, ...waypoints, b]
 *   ortho    — each diagonal segment squared into an L (see orthoVertices)
 *   spline   — [a, ...waypoints, b]; the CURVATURE is the renderer's stroke
 *              (Catmull-Rom through the same vertices), so the vertex list
 *              matches polyline. Crossings/length measured on the vertices
 *              are the spline's control skeleton — the honest approximation,
 *              stated in the eval record.
 */
export function routedVertices(
  a: Position,
  b: Position,
  waypoints: readonly Position[],
  style: RouteStyle,
): Position[] {
  if (waypoints.length === 0) return [a, b];
  if (style === "ortho") return orthoVertices([a, ...waypoints, b]);
  return [a, ...waypoints, b];
}

/**
 * Orthogonalize the vertex list: every diagonal segment u→v becomes an L —
 * travel the DOMINANT axis first, then square the corner at the elbow.
 * (u.x, v.y) for a mostly-vertical hop, (v.x, u.y) for a mostly-horizontal
 * one: the elbow lands at the receiving row, hugging the corridor the
 * engine routed, so routed corridors (already near-column-aligned) gain
 * small local jogs instead of detours. An earlier corner rule that took
 * the NEXT vertex's coordinate on the incoming axis measurably overshot —
 * each bend doubled back past its waypoint and multiplied dense-board
 * crossings by 2.4× (the 2026-09-13 sweep caught it; this rule is the
 * fix, pinned by the routing tests).
 */
function orthoVertices(pts: Position[]): Position[] {
  const out: Position[] = [pts[0]!];
  for (let i = 1; i < pts.length; i++) {
    const u = pts[i - 1]!;
    const v = pts[i]!;
    const dx = v.x - u.x;
    const dy = v.y - u.y;
    if (dx === 0 || dy === 0) {
      out.push(v);
      continue;
    }
    if (Math.abs(dy) >= Math.abs(dx)) out.push({ x: u.x, y: v.y }, v);
    else out.push({ x: v.x, y: u.y }, v);
  }
  return out;
}
