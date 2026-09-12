/**
 * RELATIONSHIP TIERS (V3, the 2026-09 review's "not every edge deserves
 * equal visual weight"): a deterministic derivation over the workspace that
 * ranks edges into three visual weights — without touching the semantic
 * model, and without the AI emitting anything new.
 *
 *   quiet     — execution metadata edges (depends_on / blocks / drives):
 *               already rendered subtly (the edge-dep dash family); they
 *               are WHY-work-exists, never the board's main flow.
 *   secondary — long/spanning edges: anything the layout engine ROUTED
 *               (Edge.route exists — the V5 corridor is itself the
 *               classifier: a multi-layer skip or a return edge is context,
 *               not the primary path) or that crosses a region boundary.
 *   primary   — everything else: the board's structural flow, one hop at a
 *               time, inside a region or across the ungrouped board.
 *
 * The renderer consumes tiers for zoom-dependent density (V2's
 * "zoomed out → primary relationships" policy); nothing else changes —
 * exports, MCP, and the op contract never see a tier.
 */

import type { Edge, Workspace } from "./model.js";

/** The execution-meaning edges the renderer already draws as quiet dashes. */
const QUIET_RELATIONSHIPS = new Set(["depends_on", "blocks", "drives"]);

export type EdgeTier = "primary" | "secondary" | "quiet";

/**
 * Tier of one edge. Pure: the same workspace always yields the same tier.
 * An edge missing an endpoint reads as secondary (its geometry is suspect —
 * the renderer skips it anyway) — never promoted to primary on bad data.
 */
export function edgeTier(workspace: Workspace, edge: Edge): EdgeTier {
  if (QUIET_RELATIONSHIPS.has(edge.relationship)) return "quiet";
  const source = workspace.nodes[edge.source];
  const target = workspace.nodes[edge.target];
  if (!source || !target) return "secondary";
  // Phase 5 emphasis (doc 18): a node the intent marks salient keeps its
  // structural edges primary — the demotions below exist to make the OVERVIEW
  // readable, and the user explicitly said this part of the story is the
  // point. Quiet edges stay quiet: emphasis is about which structure is
  // salient, never about turning execution metadata into the main flow.
  const emphasized =
    workspace.layoutIntent?.emphasis?.includes(source.id) ||
    workspace.layoutIntent?.emphasis?.includes(target.id);
  if (emphasized) return "primary";
  // Long edges the layout routed, or edges crossing a region boundary:
  // context, not the primary path.
  if (edge.route && edge.route.length > 0) return "secondary";
  if (source.groupId !== target.groupId) return "secondary";
  return "primary";
}

/** Every edge's tier, keyed by edge id — one pass for the render loop. */
export function edgeTiers(workspace: Workspace): Record<string, EdgeTier> {
  const tiers: Record<string, EdgeTier> = {};
  for (const [id, edge] of Object.entries(workspace.edges)) {
    tiers[id] = edgeTier(workspace, edge);
  }
  return tiers;
}

/**
 * The zoom-density POLICY (V2's density table, applied to edges). Returns
 * the opacity an edge of `tier` draws at for the given canvas zoom, plus
 * whether it draws at all. Rules:
 *  - zoomed in (≥ 0.55): everything draws at full weight — detail view.
 *  - mid (0.3 … 0.55): secondary recedes to 0.45; primary and quiet hold.
 *  - far out (< 0.3): the overview shows PRIMARY relationships only —
 *    secondary AND quiet hidden. "Zoomed out → primary relationships."
 * The thresholds sit where the live pass measured readability falling
 * (labels collapse well below 0.5 zoom on the 150-node ladder).
 */
export interface EdgeDensity {
  opacity: number;
  hidden: boolean;
}

/**
 * The density bands (doc 18 Phase 5, the advisory's count-driven policy):
 * how MANY nodes a board holds shifts how much relationship detail survives,
 * independent of zoom. The five advisory bands collapse into three edge
 * policies via a zoom cap — above 30 nodes secondary edges subdue even at
 * full zoom; above 150 only primary structure survives the deep-zoom-out
 * ladder. `intimate` is the exact pre-band behavior (cap 1 = no change), so
 * every existing board renders identically until it grows past 30 nodes.
 */
export type DensityBand = "intimate" | "grouped" | "regional" | "overview" | "atlas";

export function densityBand(nodeCount: number): DensityBand {
  if (nodeCount <= 30) return "intimate";
  if (nodeCount <= 80) return "grouped";
  if (nodeCount <= 150) return "regional";
  if (nodeCount <= 300) return "overview";
  return "atlas";
}

const BAND_ZOOM_CAP: Record<DensityBand, number> = {
  intimate: 1,
  grouped: 0.54,
  regional: 0.54,
  overview: 0.29,
  atlas: 0.29,
};

export function edgeDensity(
  tier: EdgeTier,
  zoom: number,
  band: DensityBand = "intimate",
): EdgeDensity {
  const effective = Math.min(zoom, BAND_ZOOM_CAP[band]);
  if (effective >= 0.55) return { opacity: 1, hidden: false };
  if (effective >= 0.3) {
    if (tier === "secondary") return { opacity: 0.45, hidden: false };
    return { opacity: 1, hidden: false };
  }
  return tier === "primary" ? { opacity: 1, hidden: false } : { opacity: 0, hidden: true };
}
