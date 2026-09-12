/**
 * The ELK candidate engine (doc 18, Phase 2) — `elkjs` behind the
 * DiagramLayoutEngine boundary, deliberately isolated in this folder: ELK
 * types do not leave it (ADR 0038), and nothing else in Lucent imports it.
 *
 * The mapping, per the advisory:
 *   Node          → ELK child, sized by the SAME measureNode the built-in
 *                   engine uses, so both engines argue from identical boxes.
 *   Edge          → ELK edge (declared at the root; ELK resolves
 *                   cross-hierarchy endpoints itself).
 *   Group         → ELK compound node (regions and lanes alike).
 *   ELK bend pts  → Edge.route waypoints (Lucent's route is bends-only
 *                   between node centres; ELK's sections start/end at node
 *                   borders, so the first/last segment differs slightly —
 *                   the measurement vocabulary counts that polyline for
 *                   both engines alike).
 *
 * Algorithm per diagram kind: layered families → elk.layered (the flagship,
 * and the point of the comparison); mind map → elk.force; decision trees →
 * elk.mrtree; process maps → elk.layered (ELK has no swimlane layout — a
 * documented limitation, not a mapping error). The Phase 2 comparison runs
 * on synthetic fixtures with no pinned nodes; pinned-position support
 * belongs to the Phase 4 incremental policy and is deliberately absent
 * here.
 *
 * This engine is ASYNC (elk.layout returns a Promise). The sync core seam
 * cannot consume it; consumers await `layout` directly — the benchmark
 * runner today, the web worker (Phase 4) in production.
 */

import ELK from "elkjs/lib/elk.bundled.js";
import {
  measureNode,
  nodeCardExtraHeight,
  type DiagramLayoutEngine,
  type DiagramLayoutRequest,
  type DiagramLayoutResult,
  type DiagramKind,
  type Workspace,
} from "@lucent/core";

/** ELK algorithm per Lucent diagram kind, with the reasoning on record. */
const ALGORITHM_FOR_KIND: Record<DiagramKind, string> = {
  flowchart: "layered",
  architecture: "layered",
  journey: "layered",
  mindmap: "force",
  decisiontree: "mrtree",
  orgchart: "mrtree",
  process: "layered",
};

interface ElkNode {
  id: string;
  layoutOptions?: Record<string, string>;
  children?: ElkNode[];
  width?: number;
  height?: number;
  /** Present on ELK's RESULT nodes; relative to the parent container. */
  x?: number;
  y?: number;
}

interface ElkGraph {
  id: string;
  layoutOptions?: Record<string, string>;
  children: ElkNode[];
  edges: Array<{ id: string; sources: string[]; targets: string[] }>;
}

export class ElkLayoutEngine implements DiagramLayoutEngine {
  readonly id = "elk-0.12";

  supports(): boolean {
    return true;
  }

  async layout({ workspace, options }: DiagramLayoutRequest): Promise<DiagramLayoutResult> {
    const elk = new ELK();
    const graph = this.toElkGraph(workspace, options);
    const out = await elk.layout(graph);

    // ELK reports a compound child's x/y RELATIVE to its parent's top-left,
    // so flattening must accumulate container offsets — otherwise every
    // region's members land in the wrong place and the comparison measures
    // a mapping bug instead of the algorithm.
    const layout: DiagramLayoutResult["layout"] = {};
    this.collectNodes(out, 0, 0, layout, workspace);
    const routes = this.collectRoutes(out);

    return { layout, routes };
  }

  /** Lucent workspace → ELK compound graph. Groups become containers. */
  private toElkGraph(workspace: Workspace, options: DiagramLayoutRequest["options"]): ElkGraph {
    const direction = options.direction === "horizontal" ? "RIGHT" : "DOWN";
    const kind = workspace.diagramKind;
    const algorithm = ALGORITHM_FOR_KIND[kind];
    const layoutOptions: Record<string, string> = {
      "elk.algorithm": algorithm,
      "elk.direction": direction,
      "elk.padding": "[top=0,left=0,bottom=0,right=0]",
      "elk.spacing.nodeNode": String(options.nodeGap ?? 48),
      "elk.layered.spacing.nodeNodeBetweenLayers": String(options.layerGap ?? 120),
      // Regions and lanes must layout WITH their members, not as opaque
      // boxes on their own pass (cross-hierarchy edges are the norm here).
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      // Deterministic runs: ELK's randomness is seed-fixed, stated outright.
      "elk.randomSeed": "1",
    };

    // Node boxes: the exact sizes the built-in engine would measure, so the
    // comparison varies by ALGORITHM, not by input geometry.
    const sizeOf = (node: Workspace["nodes"][string]) =>
      measureNode(node.label ?? "", options.nodeSize ?? { width: 160, height: 64 }, {
        extraHeight: nodeCardExtraHeight(node),
      });

    const leafOf = (node: Workspace["nodes"][string]): ElkNode => {
      const size = sizeOf(node);
      return { id: node.id, width: size.width, height: size.height };
    };

    // Compound containers for every group; ungrouped nodes sit at the root.
    const containers = new Map<string, ElkNode>();
    for (const group of Object.values(workspace.groups)) {
      containers.set(group.id, { id: group.id, children: [] });
    }
    const rootChildren: ElkNode[] = [...containers.values()];
    for (const node of Object.values(workspace.nodes)) {
      const parent = node.groupId ? containers.get(node.groupId) : undefined;
      if (parent) parent.children!.push(leafOf(node));
      else rootChildren.push(leafOf(node));
    }

    const edges = Object.values(workspace.edges).map((edge) => ({
      id: edge.id,
      sources: [edge.source],
      targets: [edge.target],
    }));

    return { id: workspace.id, layoutOptions, children: rootChildren, edges };
  }

  /** Flatten ELK's hierarchical result into Lucent's node-keyed layout,
   *  accumulating parent offsets (ELK's child coordinates are parent-relative). */
  private collectNodes(
    node: ElkNode,
    offsetX: number,
    offsetY: number,
    layout: DiagramLayoutResult["layout"],
    workspace: Workspace,
  ): void {
    const originX = offsetX + (node.x ?? 0);
    const originY = offsetY + (node.y ?? 0);
    for (const child of node.children ?? []) {
      if (workspace.nodes[child.id]) {
        layout[child.id] = {
          // ELK reports top-left x/y — the same convention applyLayout and
          // the renderer already speak.
          position: { x: originX + (child.x ?? 0), y: originY + (child.y ?? 0) },
          size: { width: child.width ?? 160, height: child.height ?? 64 },
        };
      }
      this.collectNodes(child, originX, originY, layout, workspace);
    }
  }

  /**
   * ELK edge sections → ordered bend points. Lucent's route model draws
   * [source centre → waypoints → target centre], so the route must carry the
   * FULL orthogonal path — section start/end points INCLUDED — or the
   * renderer connects the first bend to the node centre with a long
   * diagonal that cuts across every row (measured as crossings that ELK
   * does not actually draw). Consecutive sections are concatenated with
   * duplicate junction points removed.
   */
  private collectRoutes(out: unknown): DiagramLayoutResult["routes"] {
    const routes: DiagramLayoutResult["routes"] = {};
    const edges = (out as { edges?: unknown[] }).edges ?? [];
    for (const raw of edges) {
      const edge = raw as {
        id: string;
        sections?: Array<{
          startPoint?: { x: number; y: number };
          bendPoints?: Array<{ x: number; y: number }>;
          endPoint?: { x: number; y: number };
        }>;
      };
      const route: Array<{ x: number; y: number }> = [];
      const push = (p: { x: number; y: number } | undefined) => {
        if (!p) return;
        const last = route[route.length - 1];
        if (last && last.x === p.x && last.y === p.y) return;
        route.push(p);
      };
      for (const section of edge.sections ?? []) {
        push(section.startPoint);
        for (const b of section.bendPoints ?? []) push(b);
        push(section.endPoint);
      }
      // The first/last section points sit ON the node borders; the stubs to
      // the centres are short and stay inside the endpoint boxes.
      if (route.length > 0) routes[edge.id] = route;
    }
    return routes;
  }
  /**
   * The ADR 0015 seam, ELK-flavoured: re-layout ONE group's members through
   * ELK and merge back at the region's current origin, restating every node
   * outside the group — the spatial-additivity contract ("region out = 0")
   * pinned in the core's benchmark tests. Only ELK's winning families
   * (layered kinds) are handled here; other kinds return null so the caller
   * falls back to the built-in engine. The affected-subgraph policy from the
   * advisory is exactly the group: Lucent's regions are the affected region.
   */
  async relayoutRegion(
    workspace: Workspace,
    groupId: string,
    options: DiagramLayoutRequest["options"] = {},
  ): Promise<DiagramLayoutResult | null> {
    const group = workspace.groups[groupId];
    if (!group) return null;
    const kind = group.kind ?? workspace.diagramKind;
    if (!ELK_ELIGIBLE_KINDS.has(kind)) return null;
    const members = Object.values(workspace.nodes).filter((n) => n.groupId === groupId);
    if (members.length === 0) return null;
    const placed = members.filter((n) => n.position);
    if (placed.length === 0) return null;

    // The region IS the board in its own frame: no containers, internal
    // edges only — the same sub-workspace shape relayoutRegionWithRoutes
    // builds for the built-in engine.
    const memberIds = new Set(members.map((n) => n.id));
    const sub: Workspace = {
      ...workspace,
      diagramKind: kind,
      nodes: Object.fromEntries(members.map((n) => [n.id, n])),
      edges: Object.fromEntries(
        Object.values(workspace.edges)
          .filter((e) => memberIds.has(e.source) && memberIds.has(e.target))
          .map((e) => [e.id, e]),
      ),
      groups: {},
    };
    const out = await this.layout({ workspace: sub, options });

    // Merge at the region's CURRENT origin, so a growing region does not
    // jump across the board.
    const originX = Math.min(...placed.map((n) => n.position!.x));
    const originY = Math.min(...placed.map((n) => n.position!.y));
    const fresh = Object.values(out.layout);
    const dx = originX - Math.min(...fresh.map((e) => e.position.x));
    const dy = originY - Math.min(...fresh.map((e) => e.position.y));

    const layout: DiagramLayoutResult["layout"] = {};
    for (const [id, node] of Object.entries(workspace.nodes)) {
      if (node.groupId === groupId) continue;
      if (node.position && node.size) {
        layout[id] = { position: node.position, size: node.size };
      }
    }
    for (const [id, entry] of Object.entries(out.layout)) {
      layout[id] = {
        position: { x: entry.position.x + dx, y: entry.position.y + dy },
        size: entry.size,
      };
    }
    const routes: DiagramLayoutResult["routes"] = {};
    for (const [edgeId, pts] of Object.entries(out.routes)) {
      routes[edgeId] = pts.map((p) => ({ x: p.x + dx, y: p.y + dy }));
    }
    return { layout, routes };
  }
}

const ELK_ELIGIBLE_KINDS: ReadonlySet<DiagramKind> = new Set<DiagramKind>([
  "flowchart",
  "architecture",
  "journey",
]);

/** The Phase 2 candidate (ADR 0039: production for the flat graph families). */
export const ELK_LAYOUT_ENGINE: DiagramLayoutEngine = new ElkLayoutEngine();
