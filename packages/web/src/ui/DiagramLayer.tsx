import { useMemo } from "react";
import type { Workspace } from "@lucent/core";
import { anchor, ConnectorDefs, makePath, NodeCard, type NodeState } from "./atoms.js";
import { techMarkFor } from "./techMarks.js";
import { KIND_TINT } from "../statementUi.js";
import { DIAGRAM_LABELS } from "../scene.js";
import {
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
export function DiagramLayer({
  workspace,
  selected,
  selectedNodes,
  proposedIds,
  onSelect,
  frameLabel,
  spotlightId,
  scale = 1,
  showEdgeLabels = true,
  onMoveNode,
  onRenameNode,
  renameNodeId,
  onRenameConsumed,
  dragOverride,
  viewport,
  collapsedRegions,
  onToggleCollapse,
}: {
  workspace: Workspace;
  selected?: string | null;
  /** All nodes in a multi-selection; `selected` is the focused one within it. */
  selectedNodes?: Set<string>;
  proposedIds?: Set<string>;
  onSelect?: (id: string, additive: boolean) => void;
  frameLabel?: string;
  /** When set, dim every node except this one (Presentation/Focus mode, docs/12). */
  spotlightId?: string | null;
  /** Viewport zoom, so a drag translates correctly into content space. */
  scale?: number;
  /** Draw each edge's relationship verb at its midpoint. */
  showEdgeLabels?: boolean;
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
   * Region collapse (P1, docs/15 M3.3): ids of groups whose members render
   * as one summary card instead of their nodes and connectors. Render-local
   * state owned by the caller — the MODEL never changes: expand returns the
   * exact prior geometry because member positions were never touched.
   */
  collapsedRegions?: ReadonlySet<string>;
  /** Toggle a region's collapsed state (the summary card's button). */
  onToggleCollapse?: (groupId: string) => void;
}) {
  // Derived once per workspace instead of once per render: on a large board the
  // scene mapping, the id index, the group boxes and the frame bounds were all
  // being rebuilt for every hover, selection change and pan frame.
  const scene = useMemo(() => diagramScene(workspace), [workspace]);
  if (scene.nodes.length === 0) return null;
  const { byId, edges } = scene;

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
  const bounds = boundsWithDrag(scene.bounds, byId, dragOverride);
  const pad = 40;
  const label = frameLabel ?? `${DIAGRAM_LABELS[workspace.diagramKind]}`;

  // Group boxes are measured over all of a group's members, so only a drag can
  // change one — every other re-render reuses the memoised regions.
  const regions = dragOverride ? groupRegions(workspace, nodeAt) : scene.groups;

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
  // earlier label occupies. Deterministic in region order.
  const LABEL_ROW = 20;
  const labelSlots = new Map<string, number>();
  {
    const placed: Array<{ x: number; y: number; w: number }> = [];
    for (const g of groups) {
      const text = [g.label.trim(), g.kind ? DIAGRAM_LABELS[g.kind] : ""]
        .filter((s) => s.length > 0)
        .join(" · ");
      if (text.length === 0) continue;
      const w = text.length * 7 + 24; // 9.5px mono + tracking + pill padding, padded
      const x = g.x + 12;
      const baseY = g.y - 9;
      let slot = 0;
      const hits = (y: number) =>
        placed.some(
          (p) => Math.abs(p.y - y) < LABEL_ROW - 2 && x < p.x + p.w && p.x < x + w,
        );
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
  const collapsedSet = collapsedRegions ?? new Set<string>();
  const regionOf = (id: string) => workspace.nodes[id]?.groupId;
  const isCollapsedMember = (id: string) => {
    const gid = regionOf(id);
    return gid !== undefined && collapsedSet.has(gid);
  };
  const finalNodes =
    collapsedSet.size > 0 ? drawNodes.filter((n) => !isCollapsedMember(n.id)) : drawNodes;
  const finalEdges =
    collapsedSet.size > 0
      ? drawEdges.filter((e) => !(isCollapsedMember(e.source) && isCollapsedMember(e.target)))
      : drawEdges;
  // A collapsed group's summary card: its bounds plus the counts the card
  // shows. Kept as a local type so the render branch reads cleanly.
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
  };
  const finalGroups: Array<(typeof groups)[number] | CollapsedGroup> =
    collapsedSet.size > 0
      ? groups.map((g) =>
          collapsedSet.has(g.id)
            ? ({
                ...g,
                collapsed: true,
                memberCount: Object.values(workspace.nodes).filter((n) => n.groupId === g.id)
                  .length,
                edgeCount: Object.values(workspace.edges).filter(
                  (e) => regionOf(e.source) === g.id && regionOf(e.target) === g.id,
                ).length,
              } satisfies CollapsedGroup)
            : g,
        )
      : groups;

  return (
    <div style={{ position: "absolute", inset: 0 }}>
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
            <button
              className="icon-btn"
              style={{ marginTop: 10, height: 26, padding: "0 10px" }}
              onClick={() => onToggleCollapse?.(g.id)}
            >
              Expand
            </button>
          </div>
        ) : (
          <div
            key={g.id}
            className="group-region"
            style={{ left: g.x, top: g.y, width: g.width, height: g.height }}
            {...(onToggleCollapse && g.kind
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
            {pill.length > 0 && (
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
          // Faces are chosen per-edge from the real geometry, so an edge that
          // points up or left no longer leaves the wrong side and cut back
          // across its own card.
          const a = anchor(from, e.fromSide);
          const b = anchor(to, e.toSide);
          // Fan parallel relationships apart: 0, +18, -18, +36, -36 …
          const step = Math.ceil(e.parallelIndex / 2) * 18;
          const spread = e.parallelIndex === 0 ? 0 : e.parallelIndex % 2 === 1 ? step : -step;
          const proposed = proposedIds?.has(e.id);
          // Stage D3: dependency edges (depends_on/blocks) render subtly
          // distinct — a quiet dash, never high-salience (the review's
          // rendering restraint). related_to renders like any structural
          // edge (it IS structural context, not execution).
          const isDependency =
            e.relationship === "depends_on" || e.relationship === "blocks";
          const cls = [
            proposed ? "dashed emerging" : isDependency ? "edge-dep" : "",
            "appear",
          ]
            .filter(Boolean)
            .join(" ");
          // Selection focus (P1): an edge stays fully drawn when EITHER
          // endpoint is prominent, so the selected node's relationships
          // remain readable while unrelated clusters recede.
          const edgeFocus = focus ? focusEdgeOpacity(focus, e.source, e.target) : 1;
          return (
            <path
              key={e.id}
              d={makePath(a, b, e.dir, spread)}
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
              opacity={edgeFocus}
              style={edgeFocus !== 1 ? { transition: "opacity 160ms ease" } : undefined}
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
        finalEdges.map((e) => {
          const from = nodeAt(e.source);
          const to = nodeAt(e.target);
          if (!from || !to || !e.relationship) return null;
          const a = anchor(from, e.fromSide);
          const b = anchor(to, e.toSide);
          const step = Math.ceil(e.parallelIndex / 2) * 18;
          const spread = e.parallelIndex === 0 ? 0 : e.parallelIndex % 2 === 1 ? step : -step;
          // Midpoint of the bezier, which for our control points is close enough
          // to the average of the endpoints plus the fan offset.
          const mx = (a.x + b.x) / 2 + (e.dir === "v" ? spread : 0);
          const my = (a.y + b.y) / 2 + (e.dir === "h" ? spread : 0);
          return (
            <div key={`lbl-${e.id}`} className="edge-label" style={{ left: mx, top: my }}>
              {e.relationship}
            </div>
          );
        })}

      {finalNodes.map((base, i) => {
        const n = withDrag(base, dragOverride);
        let state: NodeState = "";
        if (proposedIds?.has(n.id)) state = "proposed";
        else if (selected === n.id || selectedNodes?.has(n.id)) state = "selected";
        const dimmed = spotlightId != null && spotlightId !== n.id;
        const lit = spotlightId != null && spotlightId === n.id;
        const mark = techMarkFor(n.label);
        // The staggered entrance reads as a reveal on a small board, but once
        // culling is on cards mount as the camera moves, and a per-index delay
        // would make an ordinary pan look like the board loading in slow motion.
        const delay = view ? 0 : i * 45;
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
            {...(n.nodeType.toLowerCase() === n.meta.toLowerCase()
              ? {}
              : { sub: n.nodeType })}
            dot={n.dot}
            mark={mark}
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
            {...(n.statement ? { statement: n.statement } : {})}
            {...(n.statement ? { statementTint: KIND_TINT[n.statement.kind] } : {})}
            {...(onRenameNode ? { onRename: (label: string) => onRenameNode(n.id, label) } : {})}
            {...(onMoveNode
              ? {
                  onMove: (x: number, y: number, commit: boolean) => onMoveNode(n.id, x, y, commit),
                }
              : {})}
          />
        );
      })}
    </div>
  );
}
