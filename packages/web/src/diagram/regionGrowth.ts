/**
 * Region-growth merge (doc 18 Phase 4): the neighbour-push that keeps a
 * re-laid-out region from overlapping the regions beside it — extracted from
 * the commit path so BOTH layout phases can use it: the synchronous built-in
 * pass and the async ELK refinement, which re-lays the same region and may
 * need MORE room than the built-in geometry did.
 *
 * Every shift one `separateRegions` pass produces is the same horizontal push
 * (dx) for its whole region, so edge routes inside a shifted region move with
 * their nodes — computed per edge from its own endpoints, never from a
 * mutating workspace.
 */

import { applyRoutes, separateRegions, type Workspace } from "@lucent/core";

/** Push only the neighbours a growing region actually overlaps, and carry
 *  their edge routes along. Returns `ws` unchanged when nothing overlaps. */
export function pushRegionNeighbors(ws: Workspace, growerId: string): Workspace {
  const shifts = separateRegions(ws, growerId);
  if (!shifts) return ws;
  let next = ws;
  for (const [id, placed] of Object.entries(shifts)) {
    const node = next.nodes[id];
    if (node) next = { ...next, nodes: { ...next.nodes, [id]: { ...node, ...placed } } };
  }
  // Shifted regions' edge routes move with them — the corridor stays glued to
  // its nodes. The shift is computed per edge from its own endpoints against
  // the PRE-shift workspace (every shift in one pass is the same dx for the
  // whole region, so either endpoint's dx is the edge's dx).
  const shiftedRoutes: Record<string, Array<{ x: number; y: number }>> = {};
  for (const [edgeId, edge] of Object.entries(ws.edges)) {
    if (!edge.route) continue;
    const srcShift = shifts[edge.source];
    const tgtShift = shifts[edge.target];
    if (!srcShift && !tgtShift) continue;
    const dx = (srcShift ?? tgtShift)!.position.x - (ws.nodes[edge.source]?.position?.x ?? 0);
    const dy = (srcShift ?? tgtShift)!.position.y - (ws.nodes[edge.source]?.position?.y ?? 0);
    shiftedRoutes[edgeId] = edge.route.map((p) => ({ x: p.x + dx, y: p.y + dy }));
  }
  return applyRoutes(next, shiftedRoutes);
}
