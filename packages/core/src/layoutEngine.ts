/**
 * The layout-engine boundary (doc 18, Phase 1; ADR 0038): one contract that
 * the hand-written engine and any candidate engine (ELK, Phase 2) both
 * implement, so the benchmark compares engines instead of patching call
 * sites, and a future swap is configuration instead of surgery.
 *
 * The boundary owns GEOMETRY and nothing else:
 *  - a request carries the semantic snapshot (the workspace: nodes, edges,
 *    groups, pinned positions) plus the layout options (direction, spacing,
 *    strategy) — never coordinates the AI emitted, because the op contract
 *    never carries them;
 *  - a result carries node positions/sizes and derived edge routes — it
 *    never mutates the workspace, never holds canonical state, and engine
 *    types never leak past the adapter that produces it.
 *
 * This module has NO runtime dependencies on layout.ts (type imports only),
 * so layout.ts can consult the override seam below without an import cycle:
 * `computeLayoutWithRoutes` routes through a registered override engine when
 * one is set and it supports the request, and falls through to the built-in
 * dispatch otherwise — zero behavior change until an engine deliberately
 * registers (the Phase 2 benchmark harness is the only intended registrant).
 */

import type { Workspace } from "./model.js";
import type { EdgeRoutes, LayoutOptions, LayoutResult } from "./layout.js";

export interface DiagramLayoutRequest {
  workspace: Workspace;
  options: LayoutOptions;
}

export interface DiagramLayoutResult {
  layout: LayoutResult;
  routes: EdgeRoutes;
}

export interface DiagramLayoutEngine {
  readonly id: string;
  supports(request: DiagramLayoutRequest): boolean;
  layout(request: DiagramLayoutRequest): DiagramLayoutResult;
  /**
   * The ADR 0015 seam, optional because the advisory's whole-board contract
   * does not know about it: re-layout ONE group and merge back at the
   * region's current origin, restating every node outside the group. The
   * spatial-additivity invariant ("region out = 0") is pinned in
   * visual-benchmark.test.ts and any engine implementing this method must
   * preserve it.
   */
  relayoutRegion?(
    workspace: Workspace,
    groupId: string,
    options?: LayoutOptions,
  ): { layout: LayoutResult; routes: EdgeRoutes } | null;
}

/**
 * The engine override seam. `null` (the initial state) means the built-in
 * engine handles everything — byte-identical to pre-boundary behavior. The
 * benchmark harness registers a candidate for a run and clears it after;
 * production code never sets it (until a Phase 3 adoption decision says
 * otherwise, and then only through the boundary, never by patching calls).
 */
let override: DiagramLayoutEngine | null = null;

export function setLayoutOverride(engine: DiagramLayoutEngine | null): void {
  override = engine;
}

export function getLayoutOverride(): DiagramLayoutEngine | null {
  return override;
}
