import { useMemo } from "react";
import {
  densityBand,
  edgeDensity,
  regionSummary,
  routedVertices,
  showsSummaryCards,
  timelineTicks,
  type DensityBand,
  type Workspace,
  type Node,
} from "@lucent/core";
import { anchor, ConnectorDefs, makePath, NodeCard, type NodeState } from "./atoms.js";
import { NodeAiToolbar } from "./NodeAiToolbar.js";
import { autoIconFor } from "../icons/auto.js";
import { KIND_TINT } from "../statementUi.js";
import { DIAGRAM_LABELS, bpmnShapeFor, facesFor } from "../scene.js";
import {
  GROUP_PAD,
  boundsWithDrag,
  cullRect,
  diagramScene,
  groupRegions,
  visibleEdges,
  visibleGroups,
  visibleNodes,
  withDrag,
} from "../board/culling.js";
import { focusSet, focusOpacity, focusEdgeOpacity } from "../board/focus.js";
import type { Box } from "../board/geometry.js";

/**
 * Renders a laid-out semantic Workspace as the reference node/connector visual
 * language. Pure presentation: positions already come from computeLayout.
 * `overrides` can force a node state (e.g. selected/proposed) by id.
 */
/** Sketch-reveal pacing: ms between successive nodes, and how long after a
 * node lands its connector begins to draw. ~12 nodes ≈ 2.9s — a deliberate,
 * crafted build without feeling slow. */
const SKETCH_STEP = 240;
const SKETCH_EDGE_LAG = 140;

export function DiagramLayer({
  workspace,
  selected,
  selectedNodes,
  proposedIds,
  deletedNodeIds,
  onSelect,
  frameLabel,
  spotlightId,
  scale = 1,
  showEdgeLabels = true,
  useElkRoutes = false,
  onMoveNode,
  onRenameNode,
  renameNodeId,
  onRenameConsumed,
  dragOverride,
  viewport,
  collapsedRegions,
  onToggleCollapse,
  expandedRegions,
  onToggleExpand,
  sketchOrder,
  onAiElaborate,
  onAiErrorHandling,
  onConvertNodeType,
  onAiExplain,
  onAiCustomPrompt,
}: {
  workspace: Workspace;
  selected?: string | null;
  /** All nodes in a multi-selection; `selected` is the focused one within it. */
  selectedNodes?: Set<string>;
  proposedIds?: Set<string>;
  /** Nodes slated for deletion in a proposal, rendered as ghost cards. */
  deletedNodeIds?: Set<string>;
  onSelect?: (id: string, additive: boolean) => void;
  frameLabel?: string;
  /** When set, dim every node except this one (Presentation/Focus mode, docs/12). */
  spotlightId?: string | null;
  /** Viewport zoom, so a drag translates correctly into content space. */
  scale?: number;
  /** Draw each edge's relationship verb at its midpoint. */
  showEdgeLabels?: boolean;
  /** Whether to draw orthogonal ELK routes. When false (default), connectors render as smooth curves. */
  useElkRoutes?: boolean;
  /** Supplied when nodes should be draggable; omit for read-only previews. */
  onMoveNode?: (id: string, x: number, y: number, commit: boolean) => void;
  /** Supplied when a node label may be edited in place (double-click). */
  onRenameNode?: (id: string, label: string) => void;
  /** Node whose rename editor the keyboard (Enter) asked to open. */
  renameNodeId?: string | null;
  /** Called when that request has been handed to the node. */
  onRenameConsumed?: () => void;
  /** Live delta for the node(s) currently being dragged. */
  dragOverride?: { ids: Set<string>; dx: number; dy: number } | null;
  /**
   * Visible content region, as CanvasViewport reports it. Supplied only by the
   * live canvas; a preview leaves it out and every object renders.
   */
  viewport?: Box | null;
  /**
   * Google-Stitch-style reveal: nodeId → its index in the just-generated flow
   * sequence. When present, those nodes animate in one-by-one (and their
   * connectors draw after) instead of all at once. Absent on every render but
   * the one right after a generation, so pans and edits stay instant.
   */
  sketchOrder?: Record<string, number> | null;
  /**
   * Region collapse (P1, docs/15 M3.3): ids of groups whose members render
   * as one summary card instead of their nodes and connectors. Render-local
   * state owned by the caller — the MODEL never changes: expand returns the
   * exact prior geometry because member positions were never touched.
   */
  collapsedRegions?: ReadonlySet<string>;
  /** Toggle a region's collapsed state (the summary card's button). */
  onToggleCollapse?: (groupId: string) => void;
  /**
   * V5 semantic zoom (docs/26 §6.5): at the summary-cards rung (a 300+ board,
   * or any board zoomed far out) every region auto-collapses to a summary card.
   * `expandedRegions` are the ones the reader has explicitly opened back up in
   * that mode; `onToggleExpand` flips one. Kept separate from `collapsedRegions`
   * so the two modes never reinterpret the same set.
   */
  expandedRegions?: ReadonlySet<string>;
  onToggleExpand?: (groupId: string) => void;
  /** In-canvas AI micro-action to elaborate/decompose selected node (Initiative 3) */
  onAiElaborate?: (node: Node) => void;
  /** In-canvas AI micro-action to attach error-handling / decision branch (Initiative 3) */
  onAiErrorHandling?: (node: Node) => void;
  /** In-canvas instant semantic node type conversion (Initiative 3) */
  onConvertNodeType?: (node: Node, newType: string) => void;
  /** In-canvas AI micro-action to explain selected node (Initiative 3) */
  onAiExplain?: (node: Node) => void;
  /** In-canvas AI micro-action with freeform prompt scoped to selected node (Initiative 3) */
  onAiCustomPrompt?: (node: Node, prompt: string) => void;
}) {
  // Derived once per workspace instead of once per render: on a large board the
  // scene mapping, the id index, the group boxes and the frame bounds were all
  // being rebuilt for every hover, selection change and pan frame.
  const scene = useMemo(() => diagramScene(workspace), [workspace]);
  // A timeline board's date axis (docs/27 D1), from the same scale the layout
  // placed its cards with — board-level only: a timeline region is laid out
  // at an offset the axis would not share.
  const ticks = useMemo(
    () =>
      workspace.diagramKind === "timeline" && !Object.values(workspace.groups).some((g) => g.kind)
        ? timelineTicks(workspace)
        : [],
    [workspace],
  );
  if (scene.nodes.length === 0) return null;
  const { byId, edges, storyMap } = scene;
  // A story map's activity boxes ARE its backbone columns (scene.groups): the
  // backbone card at the top of each one names the activity, so its pill
  // would say the same thing twice.
  const storyColumns = new Set(storyMap?.columns.map((c) => c.groupId) ?? []);

  // Semantic zoom (UX-4): the detail tier follows the viewport zoom so a
  // zoomed-out board stays readable — mid zoom drops secondary text, far zoom
  // keeps only structure. The tier also lands as a zoom-mid/zoom-far class on
  // the root for CSS, while the expensive labels are gated directly here.
  const zoomTier = scale >= 0.8 ? "full" : scale >= 0.45 ? "mid" : "far";
  const zoomClass = zoomTier === "mid" ? "zoom-mid" : zoomTier === "far" ? "zoom-far" : "";
  const hideNodeDetail = zoomTier === "far";

  // Count-driven density (doc 18 Phase 5): the band rides alongside the zoom
  // tier — a 300-node board behaves like a zoomed-out board even at full
  // zoom, so secondary and quiet edges recede by the same measured policy.
  const band: DensityBand = densityBand(scene.nodes.length);

  // The in-flight drag is applied per node rather than by re-mapping the whole
  // array, so the cards and their connectors still track the cursor together
  // (endpoints resolve through `byId`, which holds every node) without throwing
  // the memoised scene away on every pointer move.
  const nodeAt = (id: string) => {
    const n = byId.get(id);
    return n ? withDrag(n, dragOverride) : undefined;
  };

  // Bounding frame around the whole diagram: every node, on-screen or not, plus
  // whatever a drag is currently pulling past the old edge.
  const nodeFrame = boundsWithDrag(scene.bounds, byId, dragOverride);
  const pad = 40;
  const label = frameLabel ?? `${DIAGRAM_LABELS[workspace.diagramKind]}`;

  // Group boxes are measured over all of a group's members, so only a drag can
  // change one — every other re-render reuses the memoised regions.
  const regions = dragOverride ? groupRegions(workspace, nodeAt, storyMap) : scene.groups;

  // The frame holds the regions too, not only the cards: a matrix cell or a
  // swimlane is wider than the items in it (docs/27 D1). A story map's
  // release gutter and backbone band lie outside every card, so it holds
  // those as well.
  const framed: Box[] = storyMap ? [...regions, storyMap.bounds] : regions;
  const bounds =
    nodeFrame && framed.length > 0
      ? (() => {
          const x = Math.min(nodeFrame.x, ...framed.map((r) => r.x));
          const y = Math.min(nodeFrame.y, ...framed.map((r) => r.y));
          const right = Math.max(
            nodeFrame.x + nodeFrame.width,
            ...framed.map((r) => r.x + r.width),
          );
          const bottom = Math.max(
            nodeFrame.y + nodeFrame.height,
            ...framed.map((r) => r.y + r.height),
          );
          return { x, y, width: right - x, height: bottom - y };
        })()
      : nodeFrame;

  // Selection focus (P1): the selected node plus its direct neighbours stay
  // at full strength while the rest of a busy board recedes. Derived per
  // render from the graph; no data or geometry changes. Spotlight remains
  // the stronger, exclusive dim of Focus/Present mode.
  const focus = focusSet(workspace, selected ?? null);

  // Viewport culling (M3). Below the object threshold, or with no viewport
  // reported, `view` is null and each list below is handed back untouched, so a
  // normal-sized board pays nothing for this path.
  const view = cullRect(viewport, scene.nodes.length + scene.edges.length);
  let keep: Set<string> | undefined;
  if (view) {
    // Whatever a gesture or the keyboard is attached to stays mounted wherever
    // it sits: unmounting the card under the pointer would drop the drag.
    keep = new Set(selectedNodes);
    if (selected) keep.add(selected);
    if (spotlightId) keep.add(spotlightId);
    if (renameNodeId) keep.add(renameNodeId);
    if (dragOverride) for (const id of dragOverride.ids) keep.add(id);
  }
  const drawNodes = visibleNodes(scene.nodes, view, keep);
  // Edges keep the same gesture-mounted ids the cards do, and their span test
  // runs against drag-shifted endpoints — a dragged node's connectors must
  // follow it to the viewport edge, not vanish because the pre-drag box fell
  // outside the cull rect (M3 follow-up found live).
  const drawEdges = visibleEdges(edges, byId, view, keep, dragOverride);
  const groups = visibleGroups(regions, view);

  // Region label pills all anchor at their box's top-left (CSS: top -9px, left
  // 12px). Overlapping region boxes — nested or duplicate groups out of one
  // generation — used to stack every pill on the same point: the labels read
  // as one jumbled line. Assign each label the first 20px row whose rect no
  // earlier label occupies. Deterministic in region order. The FRAME label
  // ("Board · Kind", anchored at the frame's top-left + 8px) occupies the
  // first row too — the outermost region hugs the frame's bounds, so its
  // pill would otherwise land on the same line (found live: the stacked-
  // nodes fix made the geometry real and the two labels collided).
  const LABEL_ROW = 20;
  const labelSlots = new Map<string, number>();
  {
    const placed: Array<{ x: number; y: number; w: number }> = [];
    // The frame label's row, when the frame label will render (bounds exist
    // — the same condition as the frame's render below).
    if (bounds) {
      placed.push({ x: bounds.x - pad + 14, y: bounds.y - pad + 8, w: label.length * 7 + 24 });
    }
    for (const g of groups) {
      if (storyColumns.has(g.id)) continue; // no pill: its backbone card names it
      const text = [g.label.trim(), g.kind ? DIAGRAM_LABELS[g.kind] : ""]
        .filter((s) => s.length > 0)
        .join(" · ");
      if (text.length === 0) continue;
      const w = text.length * 7 + 24; // 9.5px mono + tracking + pill padding, padded
      const x = g.x + 12;
      const baseY = g.y - 9;
      let slot = 0;
      const hits = (y: number) =>
        placed.some((p) => Math.abs(p.y - y) < LABEL_ROW - 2 && x < p.x + p.w && p.x < x + w);
      while (hits(baseY + slot * LABEL_ROW)) slot += 1;
      labelSlots.set(g.id, slot);
      placed.push({ x, y: baseY + slot * LABEL_ROW, w });
    }
  }

  // Region collapse (P1): a collapsed group's members and their edges are
  // filtered from the draw lists — the model keeps everything, so expanding
  // restores the exact prior render. Edges fully inside a collapsed region
  // go; cross-region edges stay (they connect the collapsed region's card
  // to the rest of the board, and their far endpoint still draws).
  //
  // V5 semantic zoom (docs/26 §6.5): at the summary-cards rung — a 300+ board,
  // or any board zoomed far out — every region with members auto-collapses to a
  // summary card, except the ones the reader has explicitly expanded. Below
  // that rung the manual `collapsedRegions` set decides.
  const regionOf = (id: string) => workspace.nodes[id]?.groupId;
  const autoSummary = showsSummaryCards(scene.nodes.length, scale);
  const groupsWithMembers = new Set(
    groups.filter((g) => scene.nodes.some((n) => regionOf(n.id) === g.id)).map((g) => g.id),
  );
  const expandedSet = expandedRegions ?? new Set<string>();
  const collapsedSet: ReadonlySet<string> = autoSummary
    ? new Set([...groupsWithMembers].filter((id) => !expandedSet.has(id)))
    : (collapsedRegions ?? new Set<string>());
  const isCollapsedMember = (id: string) => {
    const gid = regionOf(id);
    return gid !== undefined && collapsedSet.has(gid);
  };
  // The BPMN lens is per-region (ADR 0014): a node renders BPMN shapes when
  // its region's kind — else the board kind — is "bpmn". Everything else on
  // the board renders exactly as before.
  const regionKindOf = new Map(groups.filter((g) => g.kind).map((g) => [g.id, g.kind] as const));
  const lensKindOf = (id: string) => regionKindOf.get(regionOf(id) ?? "") ?? workspace.diagramKind;
  const finalNodes =
    collapsedSet.size > 0 ? drawNodes.filter((n) => !isCollapsedMember(n.id)) : drawNodes;
  const finalEdges =
    collapsedSet.size > 0
      ? drawEdges.filter((e) => !(isCollapsedMember(e.source) && isCollapsedMember(e.target)))
      : drawEdges;
  // A collapsed group's summary card: its bounds plus the counts the card
  // shows — members, internal edges, and the open decisions/risks/questions
  // inside it (docs/26 §6.5 region summary). Kept as a local type so the
  // render branch reads cleanly.
  type CollapsedGroup = {
    id: string;
    label: string;
    kind?: (typeof groups)[number]["kind"];
    x: number;
    y: number;
    width: number;
    height: number;
    collapsed: true;
    memberCount: number;
    edgeCount: number;
    openDecisions: number;
    openRisks: number;
    openQuestions: number;
  };
  const finalGroups: Array<(typeof groups)[number] | CollapsedGroup> =
    collapsedSet.size > 0
      ? groups.map((g) => {
          if (!collapsedSet.has(g.id)) return g;
          const summary = regionSummary(workspace, g.id);
          return {
            ...g,
            collapsed: true,
            memberCount: summary.nodeCount,
            edgeCount: summary.edgeCount,
            openDecisions: summary.openDecisions,
            openRisks: summary.openRisks,
            openQuestions: summary.openQuestions,
          } satisfies CollapsedGroup;
        })
      : groups;

  return (
    <div
      className={["density-" + band, zoomClass].filter(Boolean).join(" ")}
      style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
    >
      {/* Semantic groups, drawn behind everything. CREATE_GROUP has always been
          part of the operation schema and the model emits it (process maps depend
          on it for swimlanes), but the canvas never rendered groups — so "group
          these ideas" produced no visible result. */}
      {finalGroups.map((g) => {
        // The label pill: "Name · Kind" when a kind exists, but a kindless
        // group with an empty name renders nothing rather than a lone "·
        // Kind" pill floating on the canvas (found live: unlabeled groups
        // from AI output stacked bare-kind pills on unlabeled groups').
        const labelBits = [g.label.trim(), g.kind ? DIAGRAM_LABELS[g.kind] : ""].filter(
          (s) => s.length > 0,
        );
        const pill = labelBits.join(" · ");
        return "collapsed" in g && g.collapsed ? (
          // A collapsed region renders as a summary card at the region's
          // original bounds (P1): label, node/edge counts, one expand button.
          // The members are untouched in the model — expanding filters
          // nothing and the exact prior geometry returns.
          <div
            key={g.id}
            className="group-region collapsed"
            style={{ left: g.x, top: g.y, width: g.width, height: g.height }}
          >
            {pill.length > 0 && <span className="group-region-label">{pill}</span>}
            <div className="mono" style={{ fontSize: 11.5, color: "var(--ink-3)", marginTop: 10 }}>
              {g.memberCount} node{g.memberCount === 1 ? "" : "s"} · {g.edgeCount} edge
              {g.edgeCount === 1 ? "" : "s"}
            </div>
            {(g.openDecisions > 0 || g.openRisks > 0 || g.openQuestions > 0) && (
              <div
                className="mono"
                style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 4, opacity: 0.9 }}
              >
                {[
                  g.openDecisions > 0
                    ? `${g.openDecisions} open decision${g.openDecisions === 1 ? "" : "s"}`
                    : "",
                  g.openRisks > 0 ? `${g.openRisks} risk${g.openRisks === 1 ? "" : "s"}` : "",
                  g.openQuestions > 0
                    ? `${g.openQuestions} question${g.openQuestions === 1 ? "" : "s"}`
                    : "",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
            )}
            <button
              className="icon-btn"
              style={{ marginTop: 10, height: 26, padding: "0 10px" }}
              onClick={() => (autoSummary ? onToggleExpand?.(g.id) : onToggleCollapse?.(g.id))}
            >
              Expand
            </button>
          </div>
        ) : (
          <div
            key={g.id}
            className="group-region"
            style={{ left: g.x, top: g.y, width: g.width, height: g.height }}
            {...(autoSummary && onToggleExpand
              ? {
                  // In summary-cards mode this region was expanded by the reader;
                  // double-click summarizes it back into its card.
                  onDoubleClick: (e: React.MouseEvent) => {
                    e.stopPropagation();
                    onToggleExpand(g.id);
                  },
                  title:
                    pill.length > 0
                      ? `${pill} — double-click to summarize`
                      : "Double-click to summarize",
                }
              : onToggleCollapse && g.kind
                ? {
                    onDoubleClick: (e: React.MouseEvent) => {
                      e.stopPropagation();
                      onToggleCollapse(g.id);
                    },
                    title: pill.length > 0 ? pill : "Double-click to collapse this region",
                  }
                : pill.length > 0
                  ? { title: pill }
                  : {})}
          >
            {pill.length > 0 && !storyColumns.has(g.id) && (
              <span
                className="group-region-label"
                style={{ top: (labelSlots.get(g.id) ?? 0) * LABEL_ROW - 9 }}
              >
                {pill}
              </span>
            )}
          </div>
        );
      })}

      {/* A story map's scaffold (docs/27 D3), from the same grid the layout
          placed the stories by: a hairline slice above each release — under
          the backbone for the first — with the release named in the left
          gutter, and the backbone of activity cards across the top. Drawn
          over the activity columns and behind the stories, never
          interactive. */}
      {storyMap && (
        <div className="storymap-scaffold" aria-hidden>
          {storyMap.rows.map((r, i) => {
            const prev = storyMap.rows[i - 1];
            const above = prev ? prev.y + prev.height : storyMap.header.y + storyMap.header.height;
            // Past the last column's box, so the slice cuts the whole map.
            const right = storyMap.bounds.x + storyMap.bounds.width + GROUP_PAD;
            return (
              <div
                key={`slice-${r.release ?? "\u0000unscheduled"}`}
                className="storymap-slice"
                style={{
                  left: storyMap.gutter.x,
                  top: (above + r.y) / 2,
                  width: right - storyMap.gutter.x,
                }}
              />
            );
          })}
          {storyMap.rows.map((r) => (
            <div
              key={`release-${r.release ?? "\u0000unscheduled"}`}
              className={r.release === null ? "storymap-release unscheduled" : "storymap-release"}
              style={{ left: storyMap.gutter.x, top: r.y, width: storyMap.gutter.width }}
            >
              {r.label}
            </div>
          ))}
          {storyMap.columns.map((c) => (
            <div
              key={c.groupId ?? "\u0000other"}
              className={c.groupId === null ? "storymap-activity other" : "storymap-activity"}
              style={{
                left: c.x,
                top: storyMap.header.y,
                width: c.width,
                height: storyMap.header.height,
              }}
            >
              {c.label.trim() || "Untitled activity"}
            </div>
          ))}
        </div>
      )}

      {ticks.length > 0 && scene.bounds && (
        <div className="timeline-axis" aria-hidden>
          {ticks.map((t) => (
            <div
              key={`${t.x}-${t.label}`}
              className="timeline-tick"
              style={{
                left: t.x,
                top: scene.bounds!.y - 44,
                height: scene.bounds!.height + 64,
              }}
            >
              <span>{t.label}</span>
            </div>
          ))}
        </div>
      )}

      <svg
        className="connectors"
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          overflow: "visible",
        }}
      >
        <ConnectorDefs />
        {finalEdges.map((e) => {
          const from = nodeAt(e.source);
          const to = nodeAt(e.target);
          if (!from || !to) return null;
          // UX-P1-003: When either endpoint is actively being dragged, dynamically
          // re-evaluate faces and anchors from live card positions so connectors never lag
          // or detach by 1 frame during rapid pointer motion.
          const isDragging =
            dragOverride != null &&
            (dragOverride.ids.has(e.source) || dragOverride.ids.has(e.target));
          const faces = isDragging
            ? facesFor(from, to)
            : { dir: e.dir, fromSide: e.fromSide, toSide: e.toSide };
          const a = anchor(from, faces.fromSide);
          const b = anchor(to, faces.toSide);
          // Fan parallel relationships apart: 0, +18, -18, +36, -36 …
          const step = Math.ceil(e.parallelIndex / 2) * 18;
          const spread = e.parallelIndex === 0 ? 0 : e.parallelIndex % 2 === 1 ? step : -step;
          const proposed = proposedIds?.has(e.id);
          // Stage D3: dependency edges (depends_on/blocks) render subtly
          // distinct — a quiet dash, never high-salience (the review's
          // rendering restraint). related_to renders like any structural
          // edge (it IS structural context, not execution). Stage E1:
          // drives joins the quiet family — causality is metadata about
          // why work exists, one dash family for all execution meaning.
          const isQuiet =
            e.relationship === "depends_on" ||
            e.relationship === "blocks" ||
            e.relationship === "drives";
          // Zoom-density policy (V2/V3): at deep zoom-out only PRIMARY
          // relationships draw — secondary (long/cross-region context) and
          // quiet (execution metadata) recede, so the overview reads as the
          // board's flow, not a wall of connectors. Mid zoom: secondary dims
          // to 0.45. Zoomed in: everything at full weight.
          const density = edgeDensity(e.tier, scale, band);
          if (density.hidden) return null;
          const cls = [proposed ? "dashed emerging" : isQuiet ? "edge-dep" : "", "appear"]
            .filter(Boolean)
            .join(" ");
          // Sketch reveal: a connector draws in just after the LATER of its two
          // endpoints has appeared, so a line never reaches for a node that is
          // not on the board yet. 0 (the normal immediate draw) once the sketch
          // clears, or for an edge between two already-present nodes.
          const sketchEdgeDelay = (() => {
            if (!sketchOrder || dragOverride) return 0;
            const later = Math.max(sketchOrder[e.source] ?? -1, sketchOrder[e.target] ?? -1);
            return later >= 0 ? later * SKETCH_STEP + SKETCH_EDGE_LAG : 0;
          })();
          // Selection focus (P1): an edge stays fully drawn when EITHER
          // endpoint is prominent, so the selected node's relationships
          // remain readable while unrelated clusters recede.
          const edgeFocus = focus ? focusEdgeOpacity(focus, e.source, e.target) : 1;
          // While dragging: if both endpoints move together, translate the corridor's
          // waypoints; if only one endpoint moves, route directly from a to b with zero latency.
          const bothDragged =
            dragOverride != null &&
            dragOverride.ids.has(e.source) &&
            dragOverride.ids.has(e.target);
          const activeRoute = useElkRoutes
            ? isDragging
              ? bothDragged && e.route.length > 0
                ? e.route.map((p) => ({ x: p.x + dragOverride.dx, y: p.y + dragOverride.dy }))
                : []
              : e.route
            : [];
          const vertices =
            activeRoute.length > 0 ? routedVertices(a, b, activeRoute, e.routeStyle) : undefined;
          return (
            <path
              key={e.id}
              d={makePath(a, b, faces.dir, spread, activeRoute, e.routeStyle, vertices)}
              className={cls}
              // Normalize the path's own length to 100 units so the draw-in
              // animation is geometry-independent. The old animation lived on
              // a persistent `stroke-dasharray: 320`: any connector longer
              // than 320px kept that dash pattern AFTER the animation and
              // rendered as paint-gap-paint — a long edge drew its arrowhead
              // with no line reaching it. With pathLength, dash units are
              // relative to the whole path whatever its real pixel length.
              pathLength={100}
              markerEnd={proposed ? "url(#arr-amber)" : "url(#arr)"}
              opacity={edgeFocus * density.opacity}
              style={{
                ...(edgeFocus !== 1 || density.opacity !== 1
                  ? { transition: "opacity 160ms ease" }
                  : {}),
                ...(sketchEdgeDelay > 0 ? { animationDelay: `${sketchEdgeDelay}ms` } : {}),
              }}
            />
          );
        })}
      </svg>

      {bounds && (
        <div
          className="frame"
          style={{
            left: bounds.x - pad,
            top: bounds.y - pad,
            width: bounds.width + pad * 2,
            height: bounds.height + pad * 2,
          }}
        >
          <div className="frame-label">{label}</div>
        </div>
      )}

      {/* Relationship labels. The model emits a verb for every edge ("calls",
          "publishes", "guards") and the canvas used to throw it away, so an
          architecture diagram showed arrows with no stated meaning. */}
      {showEdgeLabels &&
        scale >= 0.7 &&
        finalEdges.map((e, i) => {
          const from = nodeAt(e.source);
          const to = nodeAt(e.target);
          if (!from || !to || !e.relationship) return null;
          // Labels follow their edge's density: a secondary edge receded at
          // mid zoom loses its label, and a hidden edge hides it entirely.
          const labelDensity = edgeDensity(e.tier, scale, band);
          if (labelDensity.hidden) return null;
          const a = anchor(from, e.fromSide);
          const b = anchor(to, e.toSide);
          const step = Math.ceil(e.parallelIndex / 2) * 18;
          const spread = e.parallelIndex === 0 ? 0 : e.parallelIndex % 2 === 1 ? step : -step;
          // Label position: for a routed edge, the polyline's true midpoint
          // (the vertex/segment centre at half the path's length) so the label
          // rides the drawn corridor; otherwise the bezier midpoint as before.
          let mx: number;
          let my: number;
          if (useElkRoutes && e.route.length > 0) {
            // The SAME drawn vertices as the stroke (Phase 5): an ortho
            // label rides the squared corridor the eye follows, not the
            // raw waypoint diagonal. routedVertices is the one derivation.
            const pts = routedVertices(a, b, e.route, e.routeStyle);
            const segs = pts.slice(1).map((p, i) => ({
              len: Math.hypot(p.x - pts[i]!.x, p.y - pts[i]!.y),
              from: pts[i]!,
              to: p,
            }));
            let half = segs.reduce((s, seg) => s + seg.len, 0) / 2;
            let midSeg = segs[0]!;
            for (const seg of segs) {
              if (half <= seg.len) {
                midSeg = seg;
                break;
              }
              half -= seg.len;
            }
            const t = midSeg.len > 0 ? half / midSeg.len : 0;
            mx = midSeg.from.x + (midSeg.to.x - midSeg.from.x) * t;
            my = midSeg.from.y + (midSeg.to.y - midSeg.from.y) * t;
          } else {
            // Midpoint of the bezier, which for our control points is close enough
            // to the average of the endpoints plus the fan offset.
            mx = (a.x + b.x) / 2 + (e.dir === "v" ? spread : 0);
            my = (a.y + b.y) / 2 + (e.dir === "h" ? spread : 0);
          }
          return (
            <div
              key={`lbl-${e.id}`}
              className="edge-label"
              // Parallel-edge deconfliction: the fan spread already separates
              // bezier labels, so only stagger vertically when the fan index
              // is 0 (routed labels ride one corridor) — by list index then.
              style={{
                left: mx,
                top: my + (e.parallelIndex === 0 ? ((i % 3) - 1) * 10 : 0),
                opacity: labelDensity.opacity,
              }}
            >
              {e.relationship}
            </div>
          );
        })}

      {finalNodes.map((base, i) => {
        const n = withDrag(base, dragOverride);
        let state: NodeState = "";
        if (deletedNodeIds?.has(n.id)) state = "ghost";
        else if (proposedIds?.has(n.id)) state = "proposed";
        else if (selected === n.id || selectedNodes?.has(n.id)) state = "selected";
        const dimmed = spotlightId != null && spotlightId !== n.id;
        const lit = spotlightId != null && spotlightId === n.id;
        // The staggered entrance reads as a reveal on a small board, but once
        // culling is on cards mount as the camera moves, and a per-index delay
        // would make an ordinary pan look like the board loading in slow motion.
        // Sketch reveal: a freshly generated node waits its turn in flow order
        // (sketchOrder), so the diagram draws itself in; otherwise the ordinary
        // instant mount (delay 0 on the culled live canvas, a gentle index
        // stagger on an uncounted preview).
        const delay =
          sketchOrder && sketchOrder[n.id] != null && !dragOverride
            ? sketchOrder[n.id]! * SKETCH_STEP
            : view
              ? 0
              : i * 45;
        // Selection focus (P1): when a node is selected, it and its direct
        // neighbours stay at full strength while the rest of a busy board
        // recedes — the cheapest possible readability win, and purely
        // presentational (opacity, never geometry or data). The spotlight
        // mode above is the stronger, exclusive dim of Focus/Present mode;
        // focus is a subtler grade for ordinary selection.
        return (
          <NodeCard
            key={n.id}
            x={n.cx - n.w / 2}
            y={n.cy - n.h / 2}
            w={n.w}
            h={n.h}
            opacity={focus ? focusOpacity(focus, n.id) : 1}
            title={n.label}
            meta={n.meta}
            // The sub caption repeats the nodeType; for the style-table types
            // (and any unknown type, whose meta IS the uppercased nodeType)
            // that renders the same word twice — "ISSUE" over "issue". Only
            // show it when it actually adds a word the meta row doesn't have.
            // Far zoom (UX-4) drops it entirely, like the statement chip.
            {...(n.nodeType.toLowerCase() === n.meta.toLowerCase() || hideNodeDetail
              ? {}
              : { sub: n.nodeType })}
            dot={n.dot}
            icon={workspace.nodes[n.id]?.icon}
            autoIcon={autoIconFor(n.label, n.nodeType)}
            state={lit ? "selected" : state}
            dimmed={dimmed}
            appear
            delay={delay}
            onClick={(additive) => onSelect?.(n.id, additive)}
            draggable={Boolean(onMoveNode)}
            scale={scale}
            editRequested={renameNodeId === n.id}
            onEditConsumed={onRenameConsumed}
            // Stage C2: the statement chip — kind·status under the label,
            // tinted by kind (statementUi's map), dimmed when settled.
            // Far zoom (UX-4) drops it with the sub caption.
            // The statement stays at every zoom: what a node IS (a decision,
            // an open question, a risk) is the one thing an overview must still
            // say. Far zoom drops only the footnotes (owner, due, source).
            {...(n.statement ? { statement: n.statement } : {})}
            {...(n.statement ? { statementTint: KIND_TINT[n.statement.kind] } : {})}
            {...(n.statement && !hideNodeDetail && n.issue?.assignee
              ? { statementOwner: n.issue.assignee }
              : {})}
            {...(n.statement && !hideNodeDetail && n.issue?.dueDate
              ? { statementDue: n.issue.dueDate }
              : {})}
            fromMeeting={Boolean(
              n.statement &&
                !hideNodeDetail &&
                (n.provenance?.meetingId ?? n.statement.provenance?.meetingId),
            )}
            // The BPMN lens (docs/19): shapes are a presentation choice of
            // the lens, computed per node from its region's kind. Undefined
            // on every non-BPMN board — the ordinary card renders.
            {...(bpmnShapeFor(n.nodeType, lensKindOf(n.id))
              ? { bpmnShape: bpmnShapeFor(n.nodeType, lensKindOf(n.id)) }
              : {})}
            {...(onRenameNode ? { onRename: (label: string) => onRenameNode(n.id, label) } : {})}
            {...(onMoveNode
              ? {
                  onMove: (x: number, y: number, commit: boolean) => onMoveNode(n.id, x, y, commit),
                }
              : {})}
          />
        );
      })}

      {(() => {
        const focused =
          selected && (!selectedNodes || selectedNodes.size <= 1)
            ? finalNodes.find((n) => n.id === selected)
            : null;
        if (!focused) return null;
        const actualNode = workspace.nodes[focused.id];
        if (!actualNode) return null;
        if (
          !onAiElaborate &&
          !onAiErrorHandling &&
          !onConvertNodeType &&
          !onAiExplain &&
          !onAiCustomPrompt
        )
          return null;

        return (
          <NodeAiToolbar
            key={`node-ai-toolbar-${focused.id}`}
            node={actualNode}
            x={focused.cx - focused.w / 2}
            y={focused.cy - focused.h / 2}
            w={focused.w}
            h={focused.h}
            scale={scale}
            onElaborate={() => onAiElaborate?.(actualNode)}
            onErrorHandling={() => onAiErrorHandling?.(actualNode)}
            onConvertType={(newType) => onConvertNodeType?.(actualNode, newType)}
            onExplain={() => onAiExplain?.(actualNode)}
            onCustomPrompt={(prompt) => onAiCustomPrompt?.(actualNode, prompt)}
            onClose={() => onSelect?.(focused.id, false)}
          />
        );
      })()}
    </div>
  );
}
