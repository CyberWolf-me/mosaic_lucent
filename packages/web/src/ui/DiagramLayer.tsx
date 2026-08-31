import { useMemo } from "react";
import type { Workspace } from "@lucent/core";
import { anchor, ConnectorDefs, makePath, NodeCard, type NodeState } from "./atoms.js";
import { techMarkFor } from "./techMarks.js";
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

  return (
    <div style={{ position: "absolute", inset: 0 }}>
      {/* Semantic groups, drawn behind everything. CREATE_GROUP has always been
          part of the operation schema and the model emits it (process maps depend
          on it for swimlanes), but the canvas never rendered groups — so "group
          these ideas" produced no visible result. */}
      {groups.map((g) => (
        <div
          key={g.id}
          className="group-region"
          style={{ left: g.x, top: g.y, width: g.width, height: g.height }}
        >
          <span className="group-region-label">
            {g.label}
            {g.kind ? ` · ${DIAGRAM_LABELS[g.kind]}` : ""}
          </span>
        </div>
      ))}

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
        {drawEdges.map((e) => {
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
          const cls = [proposed ? "dashed emerging" : "", "appear"].filter(Boolean).join(" ");
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
        drawEdges.map((e) => {
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

      {drawNodes.map((base, i) => {
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
        return (
          <NodeCard
            key={n.id}
            x={n.cx - n.w / 2}
            y={n.cy - n.h / 2}
            w={n.w}
            h={n.h}
            title={n.label}
            meta={n.meta}
            sub={n.nodeType}
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
