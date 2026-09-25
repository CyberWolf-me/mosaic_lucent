/**
 * The production layout seam (doc 18, Phase 4; ADR 0039): routes each layout
 * request to the engine its shape deserves, and never lets an engine failure
 * blank the canvas.
 *
 * Routing (ADR 0039's hybrid selection):
 *  - flat graph families (the registry's `elk` families — flowchart,
 *    architecture, journey, bpmn, … — on boards with no foreign-kind
 *    regions) → ELK, behind the Phase 1 boundary;
 *  - everything else (mind maps, trees, swimlanes, mixed-region boards) →
 *    the built-in engines, which the Phase 2 comparison shows ELK cannot
 *    beat there;
 *  - ANY engine failure → fall back down the chain, and if that fails too,
 *    return the workspace GEOMETRY UNCHANGED with `degraded: true` — the
 *    caller shows "Layout couldn't be updated" and the board keeps its
 *    previous, valid layout. Never an exception into the render path, never
 *    a blank canvas.
 *
 * The seam is async because ELK is; the app's synchronous commit path keeps
 * calling the built-in engine directly until the integration step lands —
 * this module is the seam that integration will call (and the seam a Web
 * Worker implementation would sit behind).
 */

import {
  applyLayout,
  applyRoutes,
  CURRENT_LAYOUT_ENGINE,
  elkKinds,
  type DiagramLayoutEngine,
  type LayoutOptions,
  type Workspace,
} from "@lucent/core";
import { ELK_LAYOUT_ENGINE, WORKER_ELK_ENGINE } from "./elk/index.js";

/**
 * The families ELK may lay out — the registry's `elk` flag (V4), the one list
 * this service and the ELK engine's region seam both read. They used to keep
 * two hand lists that had to be edited together (a bpmn region fell to the
 * built-in engine inside an ELK board until the second list caught up).
 */
export const ELK_KINDS: ReadonlySet<string> = new Set<string>(elkKinds());

export interface LayoutOutcome {
  workspace: Workspace;
  /** The engine that produced the geometry; null when everything failed. */
  engineId: string | null;
  /** True when every engine failed and the previous geometry was retained. */
  degraded: boolean;
}

export interface LayoutEngines {
  /** The preferred engine (default: ELK worker — main-thread ELK breaches
   * the interactive budget at scale; the proxy falls back to built-in on
   * worker failure, never freezes). */
  primary?: DiagramLayoutEngine;
  /** The safety net (default: the built-in engine; also used when the
   * worker cannot spawn / dies / hangs — a frozen UI is worse than quieter
   * geometry). */
  fallback?: DiagramLayoutEngine;
  /** The worker proxy (optional override — reaches ELK off the main thread
   * behind the Phase 1 boundary, matching ADR 0039). */
  worker?: DiagramLayoutEngine;
}

/** ADR 0039 routing: ELK only for the flat graph families it won. */
export function elkEligible(workspace: Workspace): boolean {
  if (!ELK_KINDS.has(workspace.diagramKind)) return false;
  for (const group of Object.values(workspace.groups)) {
    // A region laid out by another family (a mind map inside a flowchart
    // board) makes this a mixed board — the comparison says keep it ours.
    if (group.kind && !ELK_KINDS.has(group.kind)) return false;
  }
  return true;
}

/**
 * ADR 0039 routing, region form: a region re-flows through ELK exactly when
 * its effective kind (the group's, falling back to the board's) is one of
 * the families ELK won. The async refinement uses this to decline BEFORE
 * running a wasted built-in region pass inside the service.
 */
export function elkRegionEligible(workspace: Workspace, groupId: string): boolean {
  const group = workspace.groups[groupId];
  if (!group) return false;
  return ELK_KINDS.has(group.kind ?? workspace.diagramKind);
}

function stamp(
  ws: Workspace,
  out: {
    layout: Record<
      string,
      { position: { x: number; y: number }; size: { width: number; height: number } }
    >;
    routes: Record<string, Array<{ x: number; y: number }>>;
  },
): Workspace {
  return applyRoutes(applyLayout(ws, out.layout), out.routes);
}

export async function layoutBoard(
  workspace: Workspace,
  options: LayoutOptions = {},
  engines: LayoutEngines = {},
): Promise<LayoutOutcome> {
  const primary = engines.primary ?? engines.worker ?? WORKER_ELK_ENGINE ?? ELK_LAYOUT_ENGINE;
  const fallback = engines.fallback ?? CURRENT_LAYOUT_ENGINE;

  if (elkEligible(workspace)) {
    try {
      const out = await primary.layout({ workspace, options });
      return { workspace: stamp(workspace, out), engineId: primary.id, degraded: false };
    } catch {
      // Primary failed — fall through. The workspace's existing geometry is
      // still intact; the fallback rebuilds from the semantic model.
    }
  }
  try {
    const out = fallback.layout({ workspace, options });
    // Guard the sync seam's async rejection clause (async fallback engines
    // must be awaited by their own consumers, never routed through here).
    if (out instanceof Promise) return { workspace, engineId: null, degraded: true };
    return { workspace: stamp(workspace, out), engineId: fallback.id, degraded: false };
  } catch {
    return { workspace, engineId: null, degraded: true };
  }
}

/**
 * The scoped path (ADR 0015): re-layout ONE region and leave the rest of the
 * board pixel-identical. Routes to ELK when the region's kind is one of its
 * families, to the built-in engine otherwise; a region-less board falls back
 * to a full-board pass (the correct behaviour for whole-board transforms).
 */
export async function relayoutRegionScoped(
  workspace: Workspace,
  groupId: string,
  options: LayoutOptions = {},
  engines: LayoutEngines = {},
): Promise<LayoutOutcome> {
  const primary = engines.primary ?? ELK_LAYOUT_ENGINE;
  const fallback = engines.fallback ?? CURRENT_LAYOUT_ENGINE;
  const group = workspace.groups[groupId];
  const kind = group?.kind ?? workspace.diagramKind;

  if (group && ELK_KINDS.has(kind)) {
    try {
      const out = await primary.relayoutRegion?.(workspace, groupId, options);
      if (out) {
        return { workspace: stamp(workspace, out), engineId: primary.id, degraded: false };
      }
    } catch {
      // Fall through to the built-in engine's region pass.
    }
  }
  try {
    const out = fallback.relayoutRegion?.(workspace, groupId, options);
    if (out instanceof Promise) return { workspace, engineId: null, degraded: true };
    if (!out) return layoutBoard(workspace, options, engines);
    return { workspace: stamp(workspace, out), engineId: fallback.id, degraded: false };
  } catch {
    return { workspace, engineId: null, degraded: true };
  }
}
