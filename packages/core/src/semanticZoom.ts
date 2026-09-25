import type { DiagramKind, Workspace } from "./model.js";
import { densityBand, type DensityBand } from "./edgeTiers.js";

/**
 * SEMANTIC ZOOM LADDER (docs/26 §6.5, V5).
 *
 * A big board must stay readable at every zoom. Two forces decide how much
 * detail survives: how MANY objects the board holds (the density band, already
 * defined in edgeTiers.ts) and how far it is zoomed OUT. This module turns the
 * pair into one presentation mode, and computes the per-region summary a
 * collapsed region shows.
 *
 * The ladder, by object count (the spec's rungs):
 *   ≤30 detail · 30–80 grouped · 80–150 regions · 150–300 overview ·
 *   >300 summary cards (each region a card: kind, counts, open decisions/risks).
 *
 * Zoom moves DOWN the ladder too: zooming out on any board summarizes it, and a
 * denser board summarizes at a higher zoom (its band caps the zoom it is read
 * at — the same `min(zoom, cap)` policy edges already follow). So a 300-object
 * board reads as summary cards when zoomed out and reveals its regions' members
 * as you zoom in — "readable at every zoom".
 */

export type PresentationMode = "detail" | "grouped" | "regions" | "overview" | "summary-cards";

const MODE_ORDER: PresentationMode[] = ["detail", "grouped", "regions", "overview", "summary-cards"];

/** The rung a density band sits at when the board is at rest (full zoom). */
const BAND_FLOOR: Record<DensityBand, PresentationMode> = {
  intimate: "detail",
  grouped: "grouped",
  regional: "regions",
  overview: "overview",
  atlas: "summary-cards",
};

/**
 * The rung the zoom alone implies. Thresholds align with the renderer's
 * long-standing zoom tiers (full ≥ 0.8, mid ≥ 0.45) and extend them downward so
 * a deep zoom-out reaches overview and summary cards on any board.
 */
function zoomMode(zoom: number): PresentationMode {
  if (zoom >= 0.8) return "detail";
  if (zoom >= 0.6) return "grouped";
  if (zoom >= 0.45) return "regions";
  if (zoom >= 0.3) return "overview";
  return "summary-cards";
}

/**
 * The presentation mode for a board of `nodeCount` objects at `zoom` (1 = 100%).
 * The more-summarized of the count floor and the zoom rung: a large board never
 * shows full detail when zoomed out, and any board summarizes as it zooms out.
 */
export function presentationMode(nodeCount: number, zoom: number): PresentationMode {
  const floor = BAND_FLOOR[densityBand(nodeCount)];
  const byZoom = zoomMode(zoom);
  const rung = Math.max(MODE_ORDER.indexOf(floor), MODE_ORDER.indexOf(byZoom));
  return MODE_ORDER[rung]!;
}

/** True when regions should render as summary cards rather than their members. */
export function showsSummaryCards(nodeCount: number, zoom: number): boolean {
  return presentationMode(nodeCount, zoom) === "summary-cards";
}

/**
 * What a collapsed region's summary card shows (docs/26 §6.5): its kind, how
 * much it holds, and the open decisions, risks and questions inside it — the
 * signal a reader scanning a 300-object board actually needs.
 */
export interface RegionSummary {
  groupId: string;
  label: string;
  kind?: DiagramKind;
  nodeCount: number;
  /** Edges with both endpoints inside the region. */
  edgeCount: number;
  openDecisions: number;
  openRisks: number;
  openQuestions: number;
  openActions: number;
}

/** Summarize one group by id. Members are nodes whose `groupId` is this group. */
export function regionSummary(ws: Workspace, groupId: string): RegionSummary {
  const group = ws.groups[groupId];
  const memberIds = new Set(
    Object.values(ws.nodes)
      .filter((n) => n.groupId === groupId)
      .map((n) => n.id),
  );
  let openDecisions = 0;
  let openRisks = 0;
  let openQuestions = 0;
  let openActions = 0;
  for (const id of memberIds) {
    const s = ws.nodes[id]?.statement;
    if (!s || s.status !== "open") continue;
    if (s.kind === "decision") openDecisions++;
    else if (s.kind === "risk") openRisks++;
    else if (s.kind === "question") openQuestions++;
    else if (s.kind === "action") openActions++;
  }
  const edgeCount = Object.values(ws.edges).filter(
    (e) => memberIds.has(e.source) && memberIds.has(e.target),
  ).length;
  return {
    groupId,
    label: group?.label ?? "",
    ...(group?.kind ? { kind: group.kind } : {}),
    nodeCount: memberIds.size,
    edgeCount,
    openDecisions,
    openRisks,
    openQuestions,
    openActions,
  };
}

/** Summaries for every group that has at least one member node, in group order. */
export function regionSummaries(ws: Workspace): RegionSummary[] {
  return Object.keys(ws.groups)
    .map((id) => regionSummary(ws, id))
    .filter((s) => s.nodeCount > 0);
}
