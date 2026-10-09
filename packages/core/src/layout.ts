import {
  DIAGRAM_KINDS,
  type DiagramKind,
  type Node,
  type Position,
  type Size,
  type Workspace,
} from "./model.js";
import { getLayoutOverride, type DiagramLayoutEngine } from "./layoutEngine.js";
import { layoutStrategyFor, pseudoRoleFor } from "./representations.js";

/**
 * Deterministic layout. The AI never sets coordinates (docs/25); this pass turns
 * the semantic graph into positions.
 *
 * One semantic graph, four geometries:
 *  - layered  — longest-path layering: flowcharts, architecture, journeys;
 *  - radial   — centre plus rings: mind maps;
 *  - tree     — parent-centred-over-children: decision trees and org charts,
 *               where a layered stack collapses siblings into one row and loses
 *               the branch structure that is the point of the diagram;
 *  - swimlane — one horizontal lane per group: process maps, where the useful
 *               reading is "who does what, in what order".
 *
 * Force-directed / ELK can replace any of these behind the same signature
 * without touching the AI or reducer.
 */

/**
 * The geometries above, plus the planning families' (docs/27): `timeline`
 * (time runs left to right), `grid` (matrix cells) and `storymap` (activities
 * as columns, releases as rows — see `storyMapLayout`).
 */
export type LayoutStrategy =
  | "layered"
  | "radial"
  | "tree"
  | "swimlane"
  | "timeline"
  | "grid"
  | "storymap";

export interface LayoutOptions {
  nodeSize?: Size;
  /** Gap between layers (along the flow direction). */
  layerGap?: number;
  /** Gap between nodes within a layer. */
  nodeGap?: number;
  direction?: "vertical" | "horizontal";
  /**
   * Layout strategy. When omitted, `computeLayout` picks one from the
   * workspace's diagramKind.
   */
  strategy?: LayoutStrategy;
  /** Distance between rings in a radial layout. */
  ringGap?: number;
  /** Vertical distance between swimlanes in a process map. */
  laneGap?: number;
  /** Scope of mutation: e.g. "extend_region" to preserve existing node coordinates without churn */
  mutationScope?: "new_canvas" | "extend_region" | "refine_selection" | "reorganize_only";
  /** Explicit set of existing node IDs to preserve strictly identically */
  existingNodeIds?: string[] | Set<string>;
}

export type LayoutOptionsResolved = Required<
  Omit<LayoutOptions, "strategy" | "mutationScope" | "existingNodeIds">
>;

const DEFAULTS: LayoutOptionsResolved = {
  nodeSize: { width: 160, height: 64 },
  layerGap: 120,
  nodeGap: 48,
  direction: "vertical",
  ringGap: 220,
  laneGap: 150,
};

/**
 * The effective direction for one layout pass (doc 18, Phase 5): an explicit
 * option wins (a call site that states direction outranks stored intent — the
 * manual paths pass their own); absent that, the board's stored layout intent
 * is the AI's statement of reading direction; absent that, vertical. ONE
 * resolution point, applied where options merge with DEFAULTS, so the sync
 * engine, the region paths, and any candidate engine behind the boundary
 * all flow the same way. Direction is the only intent field that changes
 * geometry globally — primaryFlow (spine weighting) and emphasis (tier
 * promotion) are consumed by their own passes below.
 */
function withIntentDefaults(
  workspace: Workspace,
  options: LayoutOptions,
): LayoutOptionsResolved {
  const merged = { ...DEFAULTS, ...options };
  const intentDirection = workspace.layoutIntent?.direction;
  if (!options.direction && intentDirection) merged.direction = intentDirection;
  return merged;
}

/**
 * Which geometry suits each representation. Derived from the representation
 * registry (docs/26 §6.1) — the single table where each family declares its
 * layout — so a new family's geometry is set by its registry entry, not a
 * second map maintained here.
 */
const STRATEGY_FOR_KIND: Record<DiagramKind, LayoutStrategy> = Object.fromEntries(
  DIAGRAM_KINDS.map((kind) => [kind, layoutStrategyFor(kind)]),
) as Record<DiagramKind, LayoutStrategy>;

export type LayoutResult = Record<string, { position: Position; size: Size }>;

/** Gutter between two diagram regions sharing a board. */
const REGION_GAP = 160;
/** Gutter between the region strip and the board flow above it. */
const REGION_STRIP_GAP = 240;

/**
 * Size a node box to fit its label instead of forcing every card to 160×64.
 *
 * A fixed size is what makes generated diagrams clip: the model writes real
 * labels ("Payment Reconciliation Service"), the card stays 160px wide, and the
 * text is cut off. Sizing here rather than in CSS keeps one source of truth —
 * connector anchors, the minimap, comment pins, and SVG export all read
 * `node.size`, so a CSS-only fix would leave them wrong.
 *
 * Deterministic by design: no DOM measurement, just an average-character-width
 * estimate that matches the rendered 12.5px label within a few pixels.
 */
/**
 * The vertical pixels NodeCard renders beyond the meta + single-title rows the
 * 64px base box was calibrated against: the nodeType sub row always, and the
 * stage-C2 statement chip when the node carries a statement. Sizing lives in
 * the engine (not CSS) because connector anchors, minimap boxes, comment pins,
 * and SVG export all read `node.size` — a CSS-only fix would leave them wrong.
 * Calibrated against styles.css `.node-sub` (11px + 2px margin ≈ 15px) and the
 * chip inline style (6px margin + ~11px line + 4px padding + 2px border ≈ 23px).
 *
 * V4 details (compartments) add their own rows — see nodeDetailsHeight. They
 * wrap at the card's width, which the label decides; a caller that knows the
 * width may pass it, otherwise it is estimated at the default size, the
 * narrowest this label's card can be — so the estimate can only over-reserve
 * (a little air under the last line), never clip one.
 */
export function nodeCardExtraHeight(
  node: (Pick<Node, "statement"> & Partial<Pick<Node, "label" | "details">>) | undefined,
  cardWidth?: number,
): number {
  if (!node) return 0;
  const SUB_ROW = 15;
  const CHIP_ROW = 23;
  const base = SUB_ROW + (node.statement ? CHIP_ROW : 0);
  if (!node.details || node.details.sections.length === 0) return base;
  const width = cardWidth ?? measureNode(node.label ?? "", DEFAULTS.nodeSize).width;
  return base + nodeDetailsHeight(node.details, width);
}

/**
 * The pixels a node's details compartments take on its card (V4: UML
 * attributes/operations, ER columns, C4 technology), for a card `cardWidth`
 * wide. Deterministic like measureNode — no DOM — and calibrated against
 * styles/details.css, which renders them: a 6px gap above the first
 * compartment; per compartment a 1px rule and 4px padding above and below;
 * a 9px mono title on a 13px line (+1px under it); 10.5px mono items on 15px
 * lines, word-wrapped inside 14px side padding and the card's border (up to
 * 1.5px a side — 32px of the width is never text). IBM Plex Mono's advance
 * is 0.6em (6.3px at 10.5px); 6.4 leaves slack for rounding.
 */
export function nodeDetailsHeight(details: Node["details"] | undefined, cardWidth: number): number {
  if (!details || details.sections.length === 0) return 0;
  const GAP = 6;
  const SECTION_CHROME = 1 + 4 + 4;
  const TITLE_ROW = 14;
  const ITEM_LINE = 15;
  const CHAR = 6.4;
  const perLine = Math.max(1, Math.floor((cardWidth - 32) / CHAR));
  let height = GAP;
  for (const section of details.sections) {
    height += SECTION_CHROME;
    if (section.title) height += TITLE_ROW;
    for (const item of section.items) height += wrappedLineCount(item, perLine) * ITEM_LINE;
  }
  return height;
}

/**
 * Lines a text takes when word-wrapped at `perLine` characters, the way the
 * card's CSS wraps (break at spaces; a word longer than a line breaks
 * anywhere). Greedy, like the browser, so a long signature that spills one
 * word onto the next line is counted as two lines, not 1.1.
 */
function wrappedLineCount(text: string, perLine: number): number {
  let lines = 1;
  let used = 0;
  for (const word of text.split(/\s+/).filter(Boolean)) {
    let w = word.length;
    const need = used === 0 ? w : used + 1 + w;
    if (need <= perLine) {
      used = need;
      continue;
    }
    if (used > 0) lines++;
    // A word wider than a line fills whole lines, then leaves its remainder.
    while (w > perLine) {
      w -= perLine;
      lines++;
    }
    used = w;
  }
  return lines;
}

export function measureNode(
  label: string,
  base: Size,
  opts: { charWidth?: number; maxWidth?: number; lineHeight?: number; extraHeight?: number } = {},
): Size {
  const charWidth = opts.charWidth ?? 7.1; // 12.5px Geist, mixed case
  const maxWidth = opts.maxWidth ?? 280;
  const lineHeight = opts.lineHeight ?? 18;
  const padding = 30; // 14px horizontal padding either side, plus a little slack
  const ideal = label.length * charWidth + padding;
  const width = Math.min(maxWidth, Math.max(base.width, Math.ceil(ideal)));
  // How many lines the label needs once wrapped to that width.
  const perLine = Math.max(1, Math.floor((width - padding) / charWidth));
  const lines = Math.max(1, Math.ceil(label.length / perLine));
  // extraHeight: the rows NodeCard renders below the title (sub caption,
  // statement chip) — see nodeCardExtraHeight. Without it the card's fixed
  // height clips that content symmetrically (overflow: hidden + centered).
  const height = Math.max(
    base.height,
    base.height + (lines - 1) * lineHeight + (opts.extraHeight ?? 0),
  );
  return { width, height };
}

export function computeLayout(workspace: Workspace, options: LayoutOptions = {}): LayoutResult {
  return dispatchLayoutWithRoutes(workspace, options).layout;
}

/**
 * The layout plus the edge ROUTES it derives. `layout` is the exact
 * node-only `LayoutResult` every existing consumer sees; `routes` maps each
 * multi-layer edge id to its ordered bend points (Sugiyama phase 4, the
 * coordinate-assignment half the 2026-09-11 benchmark demanded: the chain
 * corridor the ordering phase already threads must become actual drawn
 * geometry, or a long edge stays a diagonal cutting every row between).
 */
export function computeLayoutWithRoutes(
  workspace: Workspace,
  options: LayoutOptions = {},
): { layout: LayoutResult; routes: EdgeRoutes } {
  // The Phase 1 boundary (doc 18, ADR 0038): a registered engine that
  // supports this request handles it; with no override set — the production
  // default — the built-in dispatch runs exactly as it always has. The seam
  // is synchronous by contract: an async engine (ELK) must be awaited
  // directly by its consumers, never routed through here.
  const override = getLayoutOverride();
  const request = { workspace, options };
  if (override && override.supports(request)) {
    const result = override.layout(request);
    if (result instanceof Promise) {
      throw new Error(
        `layout engine "${override.id}" is async and cannot serve the synchronous seam`,
      );
    }
    return result;
  }
  return dispatchLayoutWithRoutes(workspace, options);
}

/** Ordered bend points for each routed edge, in source→target order. */
export type EdgeRoutes = Record<string, Position[]>;

/**
 * Strategy dispatch returning layout + routes (the routes-aware twin of the
 * old computeLayout body). Layered is the only strategy that routes today —
 * radial/tree/swimlane edges are short by construction (their benchmark
 * ladders hold zero crossings), so they return `routes: {}`.
 */
function dispatchLayoutWithRoutes(
  workspace: Workspace,
  options: LayoutOptions = {},
): { layout: LayoutResult; routes: EdgeRoutes } {
  // Empty board short-circuit (the old computeLayout's contract): no nodes
  // means {}, before any strategy runs.
  if (Object.keys(workspace.nodes).length === 0) return { layout: {}, routes: {} };

  // Incremental mutation scope: extend_region anchors new nodes without rearranging existing canvas
  if (options.mutationScope === "extend_region") {
    return extendRegionLayoutWithRoutes(workspace, options);
  }

  // Region partitioning first, exactly as the old computeLayout body did:
  // each region lays out under its own strategy, board flow separately.
  // The merged options carry the board's intent direction (withIntentDefaults
  // is applied once at this choke point so every strategy below flows it).
  const merged = withIntentDefaults(workspace, options);
  if (!options.strategy) {
    const partition = splitByRegions(workspace);
    if (partition) return layoutWithRegionsRoutes(workspace, partition, merged);
  }
  const strategy = options.strategy ?? STRATEGY_FOR_KIND[workspace.diagramKind] ?? "layered";
  if (strategy === "radial") return { layout: radialLayout(workspace, merged), routes: {} };
  if (strategy === "tree") return { layout: treeLayout(workspace, merged), routes: {} };
  if (strategy === "swimlane") return { layout: swimlaneLayout(workspace, merged), routes: {} };
  if (strategy === "timeline") return { layout: timelineLayout(workspace, merged), routes: {} };
  if (strategy === "grid") return { layout: gridLayout(workspace, merged), routes: {} };
  if (strategy === "storymap") return { layout: storyMapLayout(workspace, merged), routes: {} };
  const layered = layeredLayoutWithRoutes(workspace, options);
  return {
    ...layered,
    layout: shrinkPseudoStates(workspace, workspace.diagramKind, layered.layout),
  };
}

function layeredSingleComponentLayoutWithRoutes(
  workspace: Workspace,
  options: LayoutOptions = {},
): { layout: LayoutResult; routes: EdgeRoutes } {
  const opts = withIntentDefaults(workspace, options);
  const nodeIds = Object.keys(workspace.nodes);
  const result: LayoutResult = {};
  if (nodeIds.length === 0) return { layout: result, routes: {} };

  // Build adjacency from edges (only between existing nodes).
  const outgoing = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const id of nodeIds) {
    outgoing.set(id, []);
    indegree.set(id, 0);
  }
  for (const edge of Object.values(workspace.edges)) {
    if (!outgoing.has(edge.source) || !indegree.has(edge.target)) continue;
    outgoing.get(edge.source)!.push(edge.target);
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
  }

  // CYCLE REMOVAL (Sugiyama phase 1, found by the 2026-09-11 benchmark): a
  // flowchart's return edge makes the graph cyclic, and the old Kahn pass
  // left every cycle-reachable node stuck at layer 0 — the benchmark's
  // n=300 board measured 148 of 300 nodes collapsed into one row (the
  // engine's worst defect the harness has caught yet). The standard remedy:
  // DFS identifies back edges; layering ignores them (the board keeps every
  // edge — only the LAYER PASS looks away), so longest-path assignment sees
  // every node's true depth. The ignored back edge then spans many layers
  // and is routed as a chain like any long edge.
  const backEdges = new Set<string>();
  {
    // Iterative DFS over the graph in insertion order (deterministic):
    // an edge to a node already on the current stack is a back edge.
    const state = new Map<string, 0 | 1 | 2>(); // 0 unvisited, 1 on stack, 2 done
    for (const id of nodeIds) state.set(id, 0);
    for (const start of nodeIds) {
      if (state.get(start) !== 0) continue;
      const stack: Array<{ id: string; nextIdx: number }> = [{ id: start, nextIdx: 0 }];
      state.set(start, 1);
      while (stack.length > 0) {
        const top = stack[stack.length - 1]!;
        const succ = outgoing.get(top.id) ?? [];
        // Advance through successors; one still on the stack is a back
        // edge — record it and skip (do not descend).
        if (top.nextIdx < succ.length) {
          const t = succ[top.nextIdx]!;
          top.nextIdx++;
          const st = state.get(t);
          if (st === 1) {
            backEdges.add(`${top.id}->${t}`);
          } else if (st === 0) {
            state.set(t, 1);
            stack.push({ id: t, nextIdx: 0 });
          }
        } else {
          state.set(top.id, 2);
          stack.pop();
        }
      }
    }
  }

  // Assign layers via Kahn-style longest-path over the ACYCLIC view (back
  // edges excluded from adjacency for layering only). Any node still
  // unvisited keeps its current best layer, so layout never hangs.
  const layeringOut = new Map<string, string[]>();
  const layeringIn = new Map<string, number>();
  for (const id of nodeIds) {
    layeringOut.set(id, []);
    layeringIn.set(id, 0);
  }
  for (const edge of Object.values(workspace.edges)) {
    if (backEdges.has(`${edge.source}->${edge.target}`)) continue;
    if (!layeringOut.has(edge.source) || !layeringIn.has(edge.target)) continue;
    layeringOut.get(edge.source)!.push(edge.target);
    layeringIn.set(edge.target, layeringIn.get(edge.target)! + 1);
  }

  const layer = new Map<string, number>();
  for (const id of nodeIds) layer.set(id, 0);

  const remainingIndegree = new Map(layeringIn);
  const queue = nodeIds.filter((id) => (remainingIndegree.get(id) ?? 0) === 0);
  const visited = new Set<string>();

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const currentLayer = layer.get(id) ?? 0;
    for (const target of layeringOut.get(id) ?? []) {
      layer.set(target, Math.max(layer.get(target) ?? 0, currentLayer + 1));
      const deg = (remainingIndegree.get(target) ?? 0) - 1;
      remainingIndegree.set(target, deg);
      if (deg <= 0) queue.push(target);
    }
  }

  // Group nodes by layer, ordered deterministically by insertion order.
  const layers = new Map<number, string[]>();
  for (const id of nodeIds) {
    const l = layer.get(id) ?? 0;
    if (!layers.has(l)) layers.set(l, []);
    layers.get(l)!.push(id);
  }

  // LONG-EDGE ROUTING (Sugiyama phase 1b, found by the visual benchmark
  // 2026-09-11): an edge spanning several layers — a "bypasses" skip, a
  // flowchart's return edge — is one long diagonal the ordering phase cannot
  // see. The benchmark isolated it exactly: skip/back edges alone cross
  // nothing; they cross everything else, 25→10,871 times over the 20→500
  // ladder. The standard remedy is a chain of dummy nodes, one per
  // intermediate layer, so the barycenter sweeps treat the edge as ordinary
  // adjacent-layer hops and route it through the row. Dummies exist ONLY for
  // ordering — they never reach LayoutResult; the renderer still draws the
  // user's edge, now visually following the routed chain instead of cutting
  // a diagonal across the board.
  const DUMMY_PREFIX = "__route_";
  /** edge id → dummy chain, in layer order between source and target. */
  const dummyOfEdge = new Map<string, string[]>();
  for (const edge of Object.values(workspace.edges)) {
    const sLayer = layer.get(edge.source);
    const tLayer = layer.get(edge.target);
    if (sLayer === undefined || tLayer === undefined) continue;
    if (Math.abs(tLayer - sLayer) <= 1) continue; // adjacent: nothing to route
    const from = Math.min(sLayer, tLayer);
    const to = Math.max(sLayer, tLayer);
    const chain: string[] = [];
    for (let l = from + 1; l < to; l++) {
      const dummyId = `${DUMMY_PREFIX}${dummyOfEdge.size}`;
      chain.push(dummyId);
      layers.set(l, [...(layers.get(l) ?? []), dummyId]);
    }
    dummyOfEdge.set(edge.id, chain);
  }

  // PRIMARY-FLOW SPINE (doc 18, Phase 5, advisory V7): consecutive spine nodes
  // get VIRTUAL ordering hops — a dummy between every layer gap their
  // layers span — so the barycenter sweeps pull the story's nodes toward one
  // shared cross-axis position and the spine reads as a corridor. These are
  // never real edges and never enter dummyOfEdge, so they produce no drawn
  // route: they bias ORDER only, which is exactly the division of labor the
  // doctrine draws (the AI says what the story is; the engine decides where
  // everything, spine included, actually sits). Deterministic by
  // construction: the virtual chains depend only on the layer assignment,
  // which the pass above fixed. Duplicates (spine naming the same node twice,
  // or a pair already directly connected) are harmless — one extra hop
  // reinforcing what the sweep already wants — and a pair already holding a
  // real dummy chain is skipped so the real corridor is not doubled.
  const spine = (workspace.layoutIntent?.primaryFlow ?? []).filter(
    (id, i, a) => layer.has(id) && a.indexOf(id) === i,
  );
  for (let i = 0; i + 1 < spine.length; i++) {
    const a = spine[i]!;
    const b = spine[i + 1]!;
    const la = layer.get(a)!;
    const lb = layer.get(b)!;
    if (la === lb) continue;
    const from = Math.min(la, lb);
    const to = Math.max(la, lb);
    for (let l = from + 1; l < to; l++) {
      layers.set(l, [...(layers.get(l) ?? []), `${DUMMY_PREFIX}spine_${i}_${l - from - 1}`]);
    }
  }

  const { nodeSize, layerGap, nodeGap, direction } = opts;
  const sortedLayers = [...layers.keys()].sort((a, b) => a - b);

  // Ordering adjacency, now over ROUTED hops: each multi-layer edge is
  // source→d1→…→target, so incoming/outgoing describe the chain the sweeps
  // order. A dummy's barycenter is the mean of its chain neighbours — the
  // routing signal that pulls the chain between the rows' real nodes.
  const incoming = new Map<string, string[]>();
  const outgoingRouted = new Map<string, string[]>();
  const ensureIn = (id: string) => {
    if (!incoming.has(id)) incoming.set(id, []);
  };
  const ensureOut = (id: string) => {
    if (!outgoingRouted.has(id)) outgoingRouted.set(id, []);
  };
  for (const id of nodeIds) {
    ensureIn(id);
    ensureOut(id);
  }
  for (const [edgeId, chain] of dummyOfEdge) {
    const edge = workspace.edges[edgeId]!;
    const path = [edge.source, ...chain, edge.target];
    for (let i = 0; i + 1 < path.length; i++) {
      const a = path[i]!;
      const b = path[i + 1]!;
      ensureIn(b);
      ensureOut(a);
      incoming.get(b)!.push(a);
      outgoingRouted.get(a)!.push(b);
    }
  }
  // Spine hops: each virtual chain a—spine dummy—…—b, biasing the sweeps
  // exactly like a real routed hop would (the walk below covers every
  // consecutive spine pair; layers were fixed above).
  for (let i = 0; i + 1 < spine.length; i++) {
    const a = spine[i]!;
    const b = spine[i + 1]!;
    const la = layer.get(a)!;
    const lb = layer.get(b)!;
    const from = Math.min(la, lb);
    const to = Math.max(la, lb);
    const path: string[] = [a];
    for (let l = from + 1; l < to; l++) path.push(`${DUMMY_PREFIX}spine_${i}_${l - from - 1}`);
    path.push(b);
    for (let j = 0; j + 1 < path.length; j++) {
      const x = path[j]!;
      const y = path[j + 1]!;
      ensureIn(y);
      ensureOut(x);
      incoming.get(y)!.push(x);
      outgoingRouted.get(x)!.push(y);
    }
  }
  // Unrouted (adjacent-layer) edges keep their direct hops in both maps —
  // built fresh here so a node with only direct edges still appears.
  for (const edge of Object.values(workspace.edges)) {
    if (dummyOfEdge.has(edge.id)) continue;
    // Both endpoints must be in this layout (the old guard, on `layer`).
    if (!layer.has(edge.source) || !layer.has(edge.target)) continue;
    ensureIn(edge.target);
    ensureOut(edge.source);
    incoming.get(edge.target)!.push(edge.source);
    outgoingRouted.get(edge.source)!.push(edge.target);
  }

  const orderIn = (ids: string[]) => new Map(ids.map((id, i) => [id, i]));

  /** Sort `ids` by the mean position of their neighbours in `reference`. */
  const byBarycenter = (ids: string[], reference: string[], neighbours: Map<string, string[]>) => {
    if (ids.length < 2 || reference.length === 0) return ids;
    const refIndex = orderIn(reference);
    const current = orderIn(ids);
    const score = (id: string) => {
      const ns = (neighbours.get(id) ?? [])
        .map((n) => refIndex.get(n))
        .filter((v): v is number => v !== undefined);
      // No neighbour in the reference layer: keep the node where it is.
      if (ns.length === 0) return current.get(id)!;
      return ns.reduce((a, b) => a + b, 0) / ns.length;
    };
    return [...ids].sort((a, b) => {
      const d = score(a) - score(b);
      return d !== 0 ? d : current.get(a)! - current.get(b)!;
    });
  };

  const SWEEPS = 4;
  for (let pass = 0; pass < SWEEPS; pass++) {
    // Forward: order each layer against the one before it (by parents).
    for (let i = 1; i < sortedLayers.length; i++) {
      const prev = layers.get(sortedLayers[i - 1]!)!;
      const cur = sortedLayers[i]!;
      layers.set(cur, byBarycenter(layers.get(cur)!, prev, incoming));
    }
    // Backward: order each layer against the one after it (by children).
    for (let i = sortedLayers.length - 2; i >= 0; i--) {
      const next = layers.get(sortedLayers[i + 1]!)!;
      const cur = sortedLayers[i]!;
      layers.set(cur, byBarycenter(layers.get(cur)!, next, outgoingRouted));
    }
  }

  // Snapshot the dummy-inclusive row order BEFORE stripping: route
  // interpolation needs each dummy's slot among its placed neighbours.
  const rowOrderWithDummies = new Map<number, string[]>();
  for (const [l, ids] of layers) rowOrderWithDummies.set(l, [...ids]);

  // Strip the dummies: rows keep only real nodes from here on, so every
  // downstream pass (extents, placement, bounds) is node-only and
  // LayoutResult keeps its exact contract.
  for (const ids of layers.values()) {
    for (let i = ids.length - 1; i >= 0; i--) {
      if (ids[i]!.startsWith(DUMMY_PREFIX)) ids.splice(i, 1);
    }
  }

  // Walk the layers once to find where each row starts along the flow axis,
  // accounting for rows made taller by wrapped labels.
  const layerOffsets = new Map<number, number>();
  const layerExtents = new Map<number, number>();
  {
    let along = 0;
    for (const l of sortedLayers) {
      layerOffsets.set(l, along);
      const ids = layers.get(l)!;
      const extent = Math.max(
        ...ids.map((id) => {
          const s = measureNode(workspace.nodes[id]?.label ?? "", nodeSize, {
            extraHeight: nodeCardExtraHeight(workspace.nodes[id]),
          });
          return direction === "vertical" ? s.height : s.width;
        }),
        direction === "vertical" ? nodeSize.height : nodeSize.width,
      );
      layerExtents.set(l, extent);
      along += extent + layerGap;
    }
  }

  // DEEP-CHAIN WRAP (found by the live test pass): a pure linear chain —
  // customer -> products -> cart -> … — puts every node in its own layer with
  // one node per row, so "vertical" direction stacks them into a single
  // 1300px pole at one x. A human reading that board sees a spaghetti strand,
  // not a flow. The fix is the same one text wrapping uses: when the flow
  // axis is far longer than the widest row, break the layer sequence into
  // rows of a few consecutive layers and stack those rows across the canvas.
  //
  // Consecutive layers stay together, so a chain reads left-to-right then
  // wraps to the next row — the way whiteboards are actually drawn. Each row
  // keeps its own layer offsets, so nothing inside a row collides, and rows
  // are separated by a gutter wider than the node gap. Boards the user has
  // arranged by hand (pinned nodes) never take this path: their geometry is
  // deliberate and avoidPinned owns it.
  const pinnedCount = Object.values(workspace.nodes).filter((n) => n.pinned).length;
  const WRAP_ROW_LAYERS = 4;
  const widestRow = Math.max(
    ...sortedLayers.map((l) =>
      layers.get(l)!.reduce(
        (sum, id) =>
          sum +
          measureNode(workspace.nodes[id]?.label ?? "", nodeSize, {
            extraHeight: nodeCardExtraHeight(workspace.nodes[id]),
          }).width,
        0,
      ),
    ),
    nodeSize.width,
  );
  const flowSpan = [...layerOffsets.values()].at(-1) ?? 0;
  // DEEP-CHAIN ONLY (found by the 2026-09-11 visual benchmark): the wrap
  // exists for chains — every layer holding one or two nodes, so the flow
  // axis stacks into a pole. It was never meant for wide DAGs, but
  // `flowSpan > widestRow * 1.6` also fired for those (a board of many-node
  // rows, tall enough, wrapped into horizontal bands of huge rows — the
  // n=80/300 benchmark boards measured ±27,000px of x-spread). Gate on the
  // median row's node count: chains have few nodes per row; a DAG with
  // crowded rows is a normal layered board and stays vertical.
  const medianRowNodes = (() => {
    const counts = sortedLayers.map((l) => layers.get(l)!.length).sort((a, b) => a - b);
    return counts[Math.floor(counts.length / 2)] ?? 0;
  })();
  const shouldWrap =
    sortedLayers.length > WRAP_ROW_LAYERS &&
    pinnedCount === 0 &&
    flowSpan > widestRow * 1.6 &&
    medianRowNodes <= 3;

  // Wrap output (bands of WRAP_ROW_LAYERS layers stacked across the canvas):
  // declared before the branch so the shared route-derivation exit below can
  // read whichever placement ran.
  const wrapped: LayoutResult = {};
  if (shouldWrap) {
    // its right, and so on. Each row is laid out left-to-right from its own
    // base, so consecutive layers read in flow order and rows read in bands.
    let rowBase = 0;
    for (let r = 0; r < sortedLayers.length; r += WRAP_ROW_LAYERS) {
      const row = sortedLayers.slice(r, r + WRAP_ROW_LAYERS);
      const rowStart = layerOffsets.get(row[0]!) ?? 0;
      let rowWidth = 0;
      for (const l of row) {
        const ids = layers.get(l)!;
        const sizes = new Map(
          ids.map(
            (id) =>
              [
                id,
                measureNode(workspace.nodes[id]?.label ?? "", nodeSize, {
                  extraHeight: nodeCardExtraHeight(workspace.nodes[id]),
                }),
              ] as const,
          ),
        );
        const crossSpan =
          ids.reduce((sum, id) => sum + sizes.get(id)!.width, 0) + (ids.length - 1) * nodeGap;
        rowWidth = Math.max(rowWidth, crossSpan);
        const alongOffset = (layerOffsets.get(l) ?? 0) - rowStart;
        let cursor = rowBase;
        ids.forEach((id) => {
          const size = sizes.get(id)!;
          const cross = cursor;
          cursor += size.width + nodeGap;
          wrapped[id] = {
            position: { x: cross, y: alongOffset },
            size,
          };
        });
      }
      rowBase += rowWidth + layerGap * 2;
    }
    // Fall through: the shared exit derives routes against `wrapped`.
  } else {
    for (const l of sortedLayers) {
      const ids = layers.get(l)!;
      const isVertical = direction === "vertical";
      // Size each card to its label first, then lay the row out against the real
      // widths so wide cards don't overlap their neighbours.
      const sizes = new Map(
        ids.map(
          (id) =>
            [
              id,
              measureNode(workspace.nodes[id]?.label ?? "", nodeSize, {
                extraHeight: nodeCardExtraHeight(workspace.nodes[id]),
              }),
            ] as const,
        ),
      );
      const crossSpan =
        ids.reduce(
          (sum, id) => sum + (isVertical ? sizes.get(id)!.width : sizes.get(id)!.height),
          0,
        ) +
        (ids.length - 1) * nodeGap;
      let cursor = -crossSpan / 2;
      // Rows advance by the tallest card above them, so a wrapped two-line label
      // can't collide with the layer below it.
      const alongOffset = layerOffsets.get(l) ?? 0;

      ids.forEach((id) => {
        const size = sizes.get(id)!;
        const cross = cursor;
        cursor += (isVertical ? size.width : size.height) + nodeGap;
        const position: Position = isVertical
          ? { x: cross, y: alongOffset }
          : { x: alongOffset, y: cross };
        result[id] = { position, size };
      });
    }
  }

  // ROUTE COORDINATES (Sugiyama phase 4, the 2026-09-11 benchmark's ask):
  // the ordering phase threaded each multi-layer edge's dummy chain between
  // real nodes; now that real nodes have coordinates, every chain vertex
  // gets its corridor position by INTERPOLATING between its row neighbours'
  // placed centers — the vertex sits fractionally between them exactly where
  // the ordering put it. Interpolation is against the dummy-inclusive row
  // order (kept before the strip), so a corridor through a crowded row lands
  // in its gap, not on a node.
  const layoutOut = shouldWrap ? wrapped : result;
  const dummyCross = new Map<string, number>();
  for (const l of sortedLayers) {
    const ids = rowOrderWithDummies.get(l) ?? [];
    // The row's placed real nodes, in row order, with their CENTER cross
    // coordinates (same space as the placement loops above).
    const placedCenters = ids
      .filter((id) => !id.startsWith(DUMMY_PREFIX))
      .map((id) => {
        const placed = layoutOut[id];
        if (!placed) return null;
        return {
          slot: ids.indexOf(id),
          cross:
            direction === "vertical"
              ? placed.position.x + placed.size.width / 2
              : placed.position.y + placed.size.height / 2,
        };
      })
      .filter((c): c is { slot: number; cross: number } => c !== null);
    if (placedCenters.length === 0) continue;
    ids.forEach((id, i) => {
      if (!id.startsWith(DUMMY_PREFIX)) return;
      const below = placedCenters.filter((c) => c.slot < i).at(-1);
      const above = placedCenters.find((c) => c.slot > i);
      if (below && above) {
        const total = above.slot - below.slot;
        const frac = total > 0 ? (i - below.slot) / total : 0.5;
        dummyCross.set(id, below.cross + (above.cross - below.cross) * frac);
      } else if (below) {
        dummyCross.set(id, below.cross + nodeGap);
      } else if (above) {
        dummyCross.set(id, above.cross - nodeGap);
      } else {
        dummyCross.set(id, placedCenters[0]!.cross);
      }
    });
  }

  // The routes themselves: source anchor → chain vertices → target anchor.
  // Each dummy's along coordinate sits at its row's CENTRE (band-local under
  // wrap exactly as the placement loops did for real nodes).
  const routes: EdgeRoutes = {};
  for (const [edgeId, chain] of dummyOfEdge) {
    const edge = workspace.edges[edgeId]!;
    const srcLayer = layer.get(edge.source) ?? 0;
    const tgtLayer = layer.get(edge.target) ?? 0;
    const from = Math.min(srcLayer, tgtLayer);
    const points: Position[] = [];
    chain.forEach((dummyId, idx) => {
      const cross = dummyCross.get(dummyId);
      if (cross === undefined) return;
      const l = from + 1 + idx;
      let along = layerOffsets.get(l) ?? 0;
      if (shouldWrap) {
        // Band-local: subtract the band's first-layer offset, exactly as
        // the wrap placement did. Bands are rows of WRAP_ROW_LAYERS
        // consecutive layers starting at layer 0.
        const bandFirst = Math.floor(l / WRAP_ROW_LAYERS) * WRAP_ROW_LAYERS;
        along -= layerOffsets.get(bandFirst) ?? 0;
      }
      const alongCentered = along + (layerExtents.get(l) ?? 0) / 2;
      points.push(
        direction === "vertical" ? { x: cross, y: alongCentered } : { x: alongCentered, y: cross },
      );
    });
    if (points.length > 0) routes[edgeId] = points;
  }

  return { layout: layoutOut, routes };
}

/**
 * Find Weakly Connected Components (WCC) of a graph using Disjoint Set Union.
 * Deterministic: preserves node insertion order.
 */
export function findWeaklyConnectedComponents(
  nodeIds: string[],
  edges: Workspace["edges"],
): string[][] {
  if (nodeIds.length === 0) return [];
  const parent = new Map<string, string>();
  for (const id of nodeIds) parent.set(id, id);

  const find = (i: string): string => {
    let root = i;
    while (root !== parent.get(root)) {
      root = parent.get(root)!;
    }
    let curr = i;
    while (curr !== root) {
      const next = parent.get(curr)!;
      parent.set(curr, root);
      curr = next;
    }
    return root;
  };

  const union = (i: string, j: string) => {
    const rootI = find(i);
    const rootJ = find(j);
    if (rootI !== rootJ) {
      parent.set(rootJ, rootI);
    }
  };

  const validNodes = new Set(nodeIds);
  for (const edge of Object.values(edges)) {
    if (validNodes.has(edge.source) && validNodes.has(edge.target)) {
      union(edge.source, edge.target);
    }
  }

  const groups = new Map<string, string[]>();
  for (const id of nodeIds) {
    const root = find(id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(id);
  }

  const idIndex = new Map(nodeIds.map((id, idx) => [id, idx]));
  return [...groups.values()].sort((a, b) => {
    const idxA = idIndex.get(a[0]!) ?? 0;
    const idxB = idIndex.get(b[0]!) ?? 0;
    return idxA - idxB;
  });
}

/**
 * Two-stage layered layout: decomposes disconnected subgraphs and isolated nodes into
 * Weakly Connected Components (WCC), lays out each component independently, and packs
 * their bounding boxes using 2D shelf/grid packing targeting a 16:9 aspect ratio.
 * This completely prevents horizontal sprawl (e.g. 15 disconnected cards stretching 3,000px).
 */
function layeredLayoutWithRoutes(
  workspace: Workspace,
  options: LayoutOptions = {},
): { layout: LayoutResult; routes: EdgeRoutes } {
  const nodeIds = Object.keys(workspace.nodes);
  if (nodeIds.length === 0) return { layout: {}, routes: {} };

  const components = findWeaklyConnectedComponents(nodeIds, workspace.edges);
  if (components.length <= 1) {
    return layeredSingleComponentLayoutWithRoutes(workspace, options);
  }

  const opts = withIntentDefaults(workspace, options);
  const compLayouts: Array<{
    nodeIds: string[];
    layout: LayoutResult;
    routes: EdgeRoutes;
    bounds: { x: number; y: number; w: number; h: number };
  }> = [];

  for (const compNodes of components) {
    const subWs = subWorkspaceFor(workspace, compNodes, workspace.diagramKind);
    const subOut = layeredSingleComponentLayoutWithRoutes(subWs, options);
    const b = boundsOf(subOut.layout);
    compLayouts.push({
      nodeIds: compNodes,
      layout: subOut.layout,
      routes: subOut.routes,
      bounds: b,
    });
  }

  // Normalize each component so its top-left is at (0, 0)
  const normalizedLayouts = compLayouts.map((comp) => {
    const dx = -comp.bounds.x;
    const dy = -comp.bounds.y;
    const normLayout: LayoutResult = {};
    for (const [id, item] of Object.entries(comp.layout)) {
      normLayout[id] = {
        position: { x: item.position.x + dx, y: item.position.y + dy },
        size: item.size,
      };
    }
    const normRoutes: EdgeRoutes = {};
    for (const [edgeId, pts] of Object.entries(comp.routes)) {
      normRoutes[edgeId] = pts.map((p) => ({ x: p.x + dx, y: p.y + dy }));
    }
    return {
      ...comp,
      layout: normLayout,
      routes: normRoutes,
      width: Math.max(comp.bounds.w, 1),
      height: Math.max(comp.bounds.h, 1),
    };
  });

  const gapX = opts.nodeGap ?? 48;
  const gapY = opts.nodeGap ?? 48;
  const hasComplexComponents = normalizedLayouts.some((c) => c.nodeIds.length > 1);
  const compGapX = hasComplexComponents ? Math.max(gapX, 64) : gapX;
  const compGapY = hasComplexComponents ? Math.max(gapY, 64) : gapY;

  let totalArea = 0;
  for (const comp of normalizedLayouts) {
    totalArea += (comp.width + compGapX) * (comp.height + compGapY);
  }

  const singleRowWidth = normalizedLayouts.reduce(
    (sum, c, idx) => sum + c.width + (idx > 0 ? compGapX : 0),
    0,
  );
  const targetRatio = 16 / 9;
  const maxCompWidth = Math.max(...normalizedLayouts.map((c) => c.width));
  const idealWidth = Math.sqrt(totalArea * targetRatio);
  const targetShelfWidth = Math.max(idealWidth, maxCompWidth, Math.min(singleRowWidth, 960));

  interface Shelf {
    items: Array<{ compIndex: number; width: number; height: number }>;
    width: number;
    height: number;
  }

  const shelves: Shelf[] = [];
  let currentItems: Shelf["items"] = [];
  let currentWidth = 0;
  let currentHeight = 0;

  for (let i = 0; i < normalizedLayouts.length; i++) {
    const comp = normalizedLayouts[i]!;
    const neededWidth = currentItems.length === 0 ? comp.width : currentWidth + compGapX + comp.width;
    if (currentItems.length > 0 && neededWidth > targetShelfWidth) {
      shelves.push({
        items: currentItems,
        width: currentWidth,
        height: currentHeight,
      });
      currentItems = [{ compIndex: i, width: comp.width, height: comp.height }];
      currentWidth = comp.width;
      currentHeight = comp.height;
    } else {
      currentItems.push({ compIndex: i, width: comp.width, height: comp.height });
      currentWidth = neededWidth;
      currentHeight = Math.max(currentHeight, comp.height);
    }
  }
  if (currentItems.length > 0) {
    shelves.push({
      items: currentItems,
      width: currentWidth,
      height: currentHeight,
    });
  }

  const finalLayout: LayoutResult = {};
  const finalRoutes: EdgeRoutes = {};

  let shelfY = 0;
  for (const shelf of shelves) {
    let shelfX = -shelf.width / 2;
    for (const item of shelf.items) {
      const comp = normalizedLayouts[item.compIndex]!;
      for (const [id, placed] of Object.entries(comp.layout)) {
        finalLayout[id] = {
          position: { x: placed.position.x + shelfX, y: placed.position.y + shelfY },
          size: placed.size,
        };
      }
      for (const [edgeId, pts] of Object.entries(comp.routes)) {
        finalRoutes[edgeId] = pts.map((p) => ({ x: p.x + shelfX, y: p.y + shelfY }));
      }
      shelfX += item.width + compGapX;
    }
    shelfY += shelf.height + compGapY;
  }

  return { layout: finalLayout, routes: finalRoutes };
}

/**
 * Incremental layout for extend_region mutations:
 * Anchors newly added nodes and subgraphs directly to connected existing nodes,
 * preserving existing node coordinates strictly identically to avoid canvas churn.
 */
export function extendRegionLayoutWithRoutes(
  workspace: Workspace,
  options: LayoutOptions & { existingNodeIds?: string[] | Set<string> } = {},
): { layout: LayoutResult; routes: EdgeRoutes } {
  const opts = withIntentDefaults(workspace, options);
  const nodeIds = Object.keys(workspace.nodes);
  if (nodeIds.length === 0) return { layout: {}, routes: {} };

  const existingSet = options.existingNodeIds
    ? new Set(options.existingNodeIds)
    : new Set(nodeIds.filter((id) => workspace.nodes[id]?.position !== undefined));

  // If no nodes are established yet, fall back to normal layout
  if (existingSet.size === 0) {
    return dispatchLayoutWithRoutes(workspace, { ...options, mutationScope: undefined });
  }

  const layout: LayoutResult = {};
  const routes: EdgeRoutes = {};

  // 1. Existing nodes strictly preserve their positions
  for (const id of existingSet) {
    const node = workspace.nodes[id];
    if (!node) continue;
    const size =
      node.size ??
      measureNode(node.label ?? "", opts.nodeSize, {
        extraHeight: nodeCardExtraHeight(node),
      });
    layout[id] = {
      position: { x: node.position?.x ?? 0, y: node.position?.y ?? 0 },
      size,
    };
  }

  // 2. Identify new nodes to place
  const newIds = nodeIds.filter((id) => !existingSet.has(id));
  if (newIds.length === 0) {
    return { layout, routes };
  }

  // 3. Decompose new nodes into connected components
  const newComponents = findWeaklyConnectedComponents(newIds, workspace.edges);
  const isVertical = (opts.direction ?? "vertical") === "vertical";

  for (const compNodes of newComponents) {
    // Find connections to existing nodes
    const existingParents: string[] = [];
    const existingChildren: string[] = [];
    for (const edge of Object.values(workspace.edges)) {
      if (existingSet.has(edge.source) && compNodes.includes(edge.target)) {
        if (!existingParents.includes(edge.source)) existingParents.push(edge.source);
      }
      if (compNodes.includes(edge.source) && existingSet.has(edge.target)) {
        if (!existingChildren.includes(edge.target)) existingChildren.push(edge.target);
      }
    }

    // Lay out the new component in its own coordinate frame
    const subWs = subWorkspaceFor(workspace, compNodes, workspace.diagramKind);
    const subOut = layeredLayoutWithRoutes(subWs, { ...options, mutationScope: undefined });
    const subB = boundsOf(subOut.layout);

    // Calculate anchor point
    let anchorX: number;
    let anchorY: number;

    if (existingParents.length > 0) {
      if (isVertical) {
        anchorX =
          existingParents.reduce(
            (sum, id) => sum + layout[id]!.position.x + layout[id]!.size.width / 2,
            0,
          ) / existingParents.length;
        anchorY =
          Math.max(...existingParents.map((id) => layout[id]!.position.y + layout[id]!.size.height)) +
          opts.layerGap;
      } else {
        anchorX =
          Math.max(...existingParents.map((id) => layout[id]!.position.x + layout[id]!.size.width)) +
          opts.layerGap;
        anchorY =
          existingParents.reduce(
            (sum, id) => sum + layout[id]!.position.y + layout[id]!.size.height / 2,
            0,
          ) / existingParents.length;
      }
    } else if (existingChildren.length > 0) {
      if (isVertical) {
        anchorX =
          existingChildren.reduce(
            (sum, id) => sum + layout[id]!.position.x + layout[id]!.size.width / 2,
            0,
          ) / existingChildren.length;
        anchorY =
          Math.min(...existingChildren.map((id) => layout[id]!.position.y)) -
          opts.layerGap -
          subB.h;
      } else {
        anchorX =
          Math.min(...existingChildren.map((id) => layout[id]!.position.x)) -
          opts.layerGap -
          subB.w;
        anchorY =
          existingChildren.reduce(
            (sum, id) => sum + layout[id]!.position.y + layout[id]!.size.height / 2,
            0,
          ) / existingChildren.length;
      }
    } else {
      // Disconnected new component: place adjacent to existing bounds
      const existBounds = boundsOf(layout);
      if (isVertical) {
        anchorX = existBounds.x + existBounds.w + opts.laneGap;
        anchorY = existBounds.y;
      } else {
        anchorX = existBounds.x;
        anchorY = existBounds.y + existBounds.h + opts.laneGap;
      }
    }

    let dx = Math.round(anchorX - (subB.x + subB.w / 2));
    let dy = Math.round(anchorY - subB.y);

    // Collision avoidance against already placed nodes (existing + previous new)
    const hits = (candidateX: number, candidateY: number) => {
      const left = candidateX + subB.x;
      const right = left + subB.w;
      const top = candidateY + subB.y;
      const bottom = top + subB.h;
      return Object.values(layout).some((p) => {
        const pLeft = p.position.x;
        const pRight = p.position.x + p.size.width;
        const pTop = p.position.y;
        const pBottom = p.position.y + p.size.height;
        return left < pRight && right > pLeft && top < pBottom && bottom > pTop;
      });
    };

    for (let pass = 0; pass < 24; pass++) {
      if (!hits(dx, dy)) break;
      if (isVertical) {
        dx += opts.nodeGap + 32;
      } else {
        dy += opts.nodeGap + 32;
      }
    }

    // Assign positions and routes
    for (const [id, placed] of Object.entries(subOut.layout)) {
      layout[id] = {
        position: { x: placed.position.x + dx, y: placed.position.y + dy },
        size: placed.size,
      };
    }
    for (const [edgeId, pts] of Object.entries(subOut.routes)) {
      routes[edgeId] = pts.map((p) => ({ x: p.x + dx, y: p.y + dy }));
    }
  }

  return { layout, routes };
}

export function extendRegionLayout(
  workspace: Workspace,
  options: LayoutOptions & { existingNodeIds?: string[] | Set<string> } = {},
): LayoutResult {
  return extendRegionLayoutWithRoutes(workspace, options).layout;
}

export const extendRegion = extendRegionLayout;

/**
 * Radial layout for mind maps: the most-connected node sits at the centre and
 * each breadth-first ring fans out around it. Deterministic — ring membership
 * and angle come from BFS order, so the same graph always lays out identically.
 */
function radialLayout(
  workspace: Workspace,
  opts: LayoutOptionsResolved,
): LayoutResult {
  const { nodeSize, ringGap, nodeGap } = opts;
  const nodeIds = Object.keys(workspace.nodes);
  const result: LayoutResult = {};
  // Per-node measured size so a long label gets the room it needs (M0.5).
  // Without this, every node is the default size and labels clip on the outer
  // rings where two siblings sit close.
  const measured = new Map<string, Size>(
    nodeIds.map(
      (id) =>
        [
          id,
          measureNode(workspace.nodes[id]?.label ?? "", nodeSize, {
            extraHeight: nodeCardExtraHeight(workspace.nodes[id]),
          }),
        ] as const,
    ),
  );

  // Undirected adjacency: a mind map branch reads the same in either direction.
  const neighbours = new Map<string, string[]>();
  for (const id of nodeIds) neighbours.set(id, []);
  for (const edge of Object.values(workspace.edges)) {
    if (!neighbours.has(edge.source) || !neighbours.has(edge.target)) continue;
    neighbours.get(edge.source)!.push(edge.target);
    neighbours.get(edge.target)!.push(edge.source);
  }

  // Centre = highest degree, ties broken by declaration order for determinism.
  let root = nodeIds[0]!;
  let bestDegree = -1;
  for (const id of nodeIds) {
    const degree = neighbours.get(id)!.length;
    if (degree > bestDegree) {
      bestDegree = degree;
      root = id;
    }
  }

  // BFS into rings.
  const ringOf = new Map<string, number>([[root, 0]]);
  const rings: string[][] = [[root]];
  const queue = [root];
  const seen = new Set([root]);
  while (queue.length > 0) {
    const id = queue.shift()!;
    const depth = ringOf.get(id)!;
    for (const next of neighbours.get(id)!) {
      if (seen.has(next)) continue;
      seen.add(next);
      ringOf.set(next, depth + 1);
      (rings[depth + 1] ??= []).push(next);
      queue.push(next);
    }
  }
  // Disconnected nodes join the outermost ring rather than stacking at origin.
  const orphans = nodeIds.filter((id) => !seen.has(id));
  if (orphans.length > 0) {
    const ring = rings.length;
    rings[ring] = orphans;
    for (const id of orphans) ringOf.set(id, ring);
  }

  // Monotonicity trackers for the ring spacing (see the population
  // constraint inside the loop): each ring must clear the previous one.
  let prevRadius = 0;
  let prevWidest = nodeSize.width;

  rings.forEach((ids, ring) => {
    if (ring === 0) {
      const centre = ids[0]!;
      const size = measured.get(centre) ?? nodeSize;
      result[centre] = {
        position: { x: -size.width / 2, y: -size.height / 2 },
        size,
      };
      return;
    }
    // Grow the radius with ring count so outer rings don't crowd. The radius
    // step also has to scale with the widest node in the ring, otherwise a
    // long-label node on one ring overlaps the next ring's nodes.
    const widest = Math.max(...ids.map((id) => measured.get(id)?.width ?? nodeSize.width));
    // POPULATION constraint (Phase 0 finding, mixed-region fixture): the
    // index formula above sizes a ring by DEPTH only — a ring holding 66
    // branches got the same radius as one holding 6, and they overlapped.
    // A ring must also be big enough that its nodes, at their measured
    // widths, fit around it: required circumference ≈ Σ widths + a gap per
    // node, so radius ≥ that ÷ 2π.
    const totalWidth = ids.reduce(
      (sum, id) => sum + (measured.get(id)?.width ?? nodeSize.width),
      0,
    );
    const populationRadius = (totalWidth + ids.length * nodeGap) / (Math.PI * 2);
    // Rings are monotonically spaced: a crowded inner ring pushes the next
    // ring out rather than letting it collapse back inside.
    const radius = Math.max(
      ring * (ringGap + widest / 2),
      prevRadius + ringGap + (prevWidest + widest) / 2,
      populationRadius,
    );
    prevRadius = radius;
    prevWidest = widest;
    // Start at -90° so the first branch sits above the centre.
    const step = (Math.PI * 2) / ids.length;
    ids.forEach((id, i) => {
      const angle = -Math.PI / 2 + i * step;
      const size = measured.get(id) ?? nodeSize;
      result[id] = {
        position: {
          x: Math.round(Math.cos(angle) * radius - size.width / 2),
          y: Math.round(Math.sin(angle) * radius - size.height / 2),
        },
        size,
      };
    });
  });

  return result;
}

/**
 * Tree layout for decision trees and org charts.
 *
 * A layered layout would put every same-depth node in one wide row regardless of
 * which parent it belongs to, so branches interleave and the tree stops reading
 * as a tree. This does a proper tidy-tree pass instead: leaves are packed left to
 * right, and each parent is centred over the span of its own children.
 *
 * Cycles are impossible in a well-formed tree but can arrive from an edited
 * graph, so the walk tracks visited nodes and never recurses twice.
 */
function treeLayout(
  workspace: Workspace,
  opts: LayoutOptionsResolved,
): LayoutResult {
  const { nodeSize, layerGap, nodeGap } = opts;
  const nodeIds = Object.keys(workspace.nodes);
  const result: LayoutResult = {};
  // Per-node measured size so the leaf-packing step uses the actual width of
  // each leaf, not the default (M0.5). Without this two leaves with long
  // labels overlap because the cursor advances by the default width only.
  const measured = new Map<string, Size>(
    nodeIds.map(
      (id) =>
        [
          id,
          measureNode(workspace.nodes[id]?.label ?? "", nodeSize, {
            extraHeight: nodeCardExtraHeight(workspace.nodes[id]),
          }),
        ] as const,
    ),
  );

  const children = new Map<string, string[]>();
  const parentCount = new Map<string, number>();
  for (const id of nodeIds) {
    children.set(id, []);
    parentCount.set(id, 0);
  }
  for (const edge of Object.values(workspace.edges)) {
    if (!children.has(edge.source) || !parentCount.has(edge.target)) continue;
    // Ignore a duplicate parent link: a tree node is drawn under one parent.
    if ((parentCount.get(edge.target) ?? 0) > 0) continue;
    children.get(edge.source)!.push(edge.target);
    parentCount.set(edge.target, 1);
  }

  // Roots keep declaration order so the layout is stable.
  const roots = nodeIds.filter((id) => (parentCount.get(id) ?? 0) === 0);
  // A cyclic graph with no root still has to render: fall back to the first node.
  const startNodes = roots.length > 0 ? roots : [nodeIds[0]!];

  // Row offsets come from the tallest measured node on each row (M0.5). A
  // wrapped two-line label is taller than the default, so a fixed row step
  // would let it collide with the row below.
  const depthOf = new Map<string, number>();
  {
    const stack: Array<{ id: string; depth: number }> = startNodes.map((id) => ({ id, depth: 0 }));
    const seen = new Set<string>();
    while (stack.length > 0) {
      const { id, depth } = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      depthOf.set(id, depth);
      for (const kid of children.get(id) ?? []) stack.push({ id: kid, depth: depth + 1 });
    }
  }
  const tallestAtDepth = new Map<number, number>();
  for (const [id, d] of depthOf) {
    const h = measured.get(id)?.height ?? nodeSize.height;
    tallestAtDepth.set(d, Math.max(tallestAtDepth.get(d) ?? 0, h));
  }
  const rowOffset = new Map<number, number>();
  {
    let acc = 0;
    const depths = [...tallestAtDepth.keys()].sort((a, b) => a - b);
    for (const d of depths) {
      rowOffset.set(d, acc);
      acc += (tallestAtDepth.get(d) ?? nodeSize.height) + layerGap;
    }
  }
  const yFor = (depth: number): number =>
    rowOffset.get(depth) ?? depth * (nodeSize.height + layerGap);

  const visited = new Set<string>();
  // The leaf cursor advances by each leaf's measured width (M0.5). A long-
  // label leaf eats more horizontal space than the default, so the row
  // doesn't crowd.
  let cursor = 0;

  /** Place a subtree and return the x centre its parent should sit above. */
  const place = (id: string, depth: number): number => {
    if (visited.has(id)) return cursor;
    visited.add(id);

    const size = measured.get(id) ?? nodeSize;
    const kids = (children.get(id) ?? []).filter((k) => !visited.has(k));
    let centre: number;
    if (kids.length === 0) {
      centre = cursor + size.width / 2;
      cursor += size.width + nodeGap;
    } else {
      const centres = kids.map((k) => place(k, depth + 1));
      // Centre the parent over its own children, not over the whole row.
      centre = (centres[0]! + centres[centres.length - 1]!) / 2;
    }

    result[id] = {
      position: { x: Math.round(centre - size.width / 2), y: yFor(depth) },
      size,
    };
    return centre;
  };

  for (const root of startNodes) place(root, 0);
  // Anything unreachable (a detached fragment) still gets a slot on a new row.
  for (const id of nodeIds) {
    if (visited.has(id)) continue;
    visited.add(id);
    const size = measured.get(id) ?? nodeSize;
    result[id] = {
      position: { x: Math.round(cursor), y: 0 },
      size,
    };
    cursor += size.width + nodeGap;
  }

  return result;
}

/**
 * Swimlane layout for process maps: one horizontal lane per semantic group, with
 * flow order left to right inside the lane.
 *
 * Groups are the lanes because that is already how the model expresses "these
 * belong together" — an owner, a team, a stage. Ungrouped nodes share a trailing
 * lane rather than being dropped.
 */
function swimlaneLayout(
  workspace: Workspace,
  opts: LayoutOptionsResolved,
): LayoutResult {
  const { nodeSize, layerGap, laneGap } = opts;
  const nodeIds = Object.keys(workspace.nodes);
  const result: LayoutResult = {};
  // Per-node measured size so a wide node in one column reserves the next
  // column for the next node (M0.5). Without this every column is the default
  // width and the column-step carves lanes narrower than a long label needs.
  const measured = new Map<string, Size>(
    nodeIds.map(
      (id) =>
        [
          id,
          measureNode(workspace.nodes[id]?.label ?? "", nodeSize, {
            extraHeight: nodeCardExtraHeight(workspace.nodes[id]),
          }),
        ] as const,
    ),
  );

  // Column = flow depth, so a step always sits right of its predecessor even
  // when the two live in different lanes.
  const depth = flowDepths(workspace, nodeIds);

  // Lane order: declared groups first, then the ungrouped lane.
  const groupIds = Object.keys(workspace.groups);
  const laneOf = new Map<string, number>();
  groupIds.forEach((gid, i) => laneOf.set(gid, i));
  const ungroupedLane = groupIds.length;

  // Track the widest node placed in each column so the column-step is wide
  // enough to clear it (M0.5).
  const widestInCol = new Map<number, number>();
  for (const id of nodeIds) {
    const col = depth.get(id) ?? 0;
    const w = measured.get(id)?.width ?? nodeSize.width;
    widestInCol.set(col, Math.max(widestInCol.get(col) ?? 0, w));
  }
  // Cumulative x offset of each column = sum of previous columns' widths.
  const colOffset = new Map<number, number>();
  let acc = 0;
  const cols = [...new Set(nodeIds.map((id) => depth.get(id) ?? 0))].sort((a, b) => a - b);
  for (const col of cols) {
    colOffset.set(col, acc);
    acc += (widestInCol.get(col) ?? nodeSize.width) + layerGap;
  }
  const rowStep = nodeSize.height + laneGap;

  // Within one lane, two nodes can share a depth; offset them so they never
  // overlap.
  const seatsTaken = new Map<string, number>();

  for (const id of nodeIds) {
    const node = workspace.nodes[id]!;
    const lane =
      node.groupId !== undefined ? (laneOf.get(node.groupId) ?? ungroupedLane) : ungroupedLane;
    const col = depth.get(id) ?? 0;
    const key = `${lane}:${col}`;
    const seat = seatsTaken.get(key) ?? 0;
    seatsTaken.set(key, seat + 1);
    const size = measured.get(id) ?? nodeSize;

    result[id] = {
      position: {
        x: colOffset.get(col) ?? 0,
        y: lane * rowStep + seat * (size.height + 16),
      },
      size,
    };
  }

  return result;
}

/**
 * Longest-path depth per node, shared by the swimlane layout. Kahn-style so a
 * cycle cannot hang the pass; unreachable nodes keep depth 0.
 */
function flowDepths(workspace: Workspace, nodeIds: string[]): Map<string, number> {
  const outgoing = new Map<string, string[]>();
  const remaining = new Map<string, number>();
  for (const id of nodeIds) {
    outgoing.set(id, []);
    remaining.set(id, 0);
  }
  for (const edge of Object.values(workspace.edges)) {
    if (!outgoing.has(edge.source) || !remaining.has(edge.target)) continue;
    outgoing.get(edge.source)!.push(edge.target);
    remaining.set(edge.target, (remaining.get(edge.target) ?? 0) + 1);
  }

  const depth = new Map<string, number>(nodeIds.map((id) => [id, 0]));
  const queue = nodeIds.filter((id) => (remaining.get(id) ?? 0) === 0);
  const seen = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const here = depth.get(id) ?? 0;
    for (const next of outgoing.get(id) ?? []) {
      depth.set(next, Math.max(depth.get(next) ?? 0, here + 1));
      const left = (remaining.get(next) ?? 0) - 1;
      remaining.set(next, left);
      if (left <= 0) queue.push(next);
    }
  }
  return depth;
}

/* ---------------------------------------------------------------------------
 * Diagram regions — several diagram kinds sharing one board (docs/03).
 * A region is a group carrying `kind`. Its members are laid out by the
 * strategy for that kind, inside their own sub-workspace, and the finished
 * region is packed against the other regions on the board. Everything else
 * (ungrouped nodes, kindless groups) keeps the board-wide behaviour exactly:
 * a board with no regions must produce byte-identical output to before.
 * ------------------------------------------------------------------------- */

/** One region plus the nodes that stay with the board-wide layout. */
interface RegionPartition {
  regions: Array<{ groupId: string; kind: DiagramKind; ids: string[] }>;
  /** Nodes not in any kind-group (ungrouped, or grouped without a kind). */
  board: string[];
}

/**
 * Partition a workspace's nodes into regions vs. the board flow. Returns null
 * when there is nothing regional about the board — the common case, and the
 * one that must cost nothing.
 *
 * Membership is read from `node.groupId` because that is the authoritative
 * link the reducer maintains; `group.children` can lag it in edited boards.
 */
function splitByRegions(workspace: Workspace): RegionPartition | null {
  const regions: RegionPartition["regions"] = [];
  const seen = new Set<string>();
  for (const group of Object.values(workspace.groups)) {
    if (!group.kind) continue;
    const ids = Object.values(workspace.nodes)
      .filter((n) => n.groupId === group.id)
      .map((n) => n.id);
    // An empty region lays out as nothing; a region whose members all moved
    // elsewhere is not a region this pass needs to own.
    if (ids.length === 0) continue;
    ids.forEach((id) => seen.add(id));
    regions.push({ groupId: group.id, kind: group.kind, ids });
  }
  if (regions.length === 0) return null;
  const board = Object.keys(workspace.nodes).filter((id) => !seen.has(id));
  return { regions, board };
}

/** Bounding box of a finished region layout. */
function boundsOf(layout: LayoutResult): { x: number; y: number; w: number; h: number } {
  const entries = Object.values(layout);
  const x = Math.min(...entries.map((p) => p.position.x));
  const y = Math.min(...entries.map((p) => p.position.y));
  const w =
    Math.max(...entries.map((p) => p.position.x + p.size.width)) -
    Math.min(...entries.map((p) => p.position.x));
  const h =
    Math.max(...entries.map((p) => p.position.y + p.size.height)) -
    Math.min(...entries.map((p) => p.position.y));
  return { x, y, w, h };
}

/**
 * Lay out a board that has regions: each region runs its own strategy on a
 * sub-workspace, regions pack along a row, and the board flow (if any) stacks
 * above the region strip.
 */
function _layoutWithRegions(
  workspace: Workspace,
  partition: RegionPartition,
  opts: LayoutOptionsResolved,
): LayoutResult {
  const result: LayoutResult = {};
  const pins = Object.values(workspace.nodes).filter((n) => n.pinned);

  // --- Board flow first: the board's own diagram, excluding region members.
  let boardTop = 0;
  if (partition.board.length > 0) {
    const boardWs = subWorkspaceFor(workspace, partition.board, workspace.diagramKind);
    const boardLayout = layoutSingle(boardWs, workspace.diagramKind, opts);
    Object.assign(result, boardLayout);
    if (Object.keys(boardLayout).length > 0) boardTop = boundsOf(boardLayout).h;
  }

  // --- Regions: each under its own strategy.
  const regionLayouts: Array<{ groupId: string; kind: DiagramKind; layout: LayoutResult }> = [];
  for (const region of partition.regions) {
    const regionWs = subWorkspaceFor(workspace, region.ids, region.kind);
    regionLayouts.push({
      groupId: region.groupId,
      kind: region.kind,
      layout: layoutSingle(regionWs, region.kind, opts),
    });
  }

  // --- Pack regions along a row, cross-flow, with gutter separation. Region
  // order is group declaration order (deterministic). Each region keeps its
  // internal geometry; only the region origin moves.
  const gap = REGION_GAP;
  let cursorX = 0;
  for (const rl of regionLayouts) {
    const b = boundsOf(rl.layout);
    const dx = cursorX - b.x;
    const dy = REGION_STRIP_GAP + boardTop - b.y;
    for (const [id, placed] of Object.entries(rl.layout)) {
      result[id] = {
        position: { x: placed.position.x + dx, y: placed.position.y + dy },
        size: placed.size,
      };
    }
    cursorX += b.w + gap;
  }

  // --- Pinned nodes stay exactly where the user put them; they are not in the
  // result, so applyLayout keeps their stored position.
  for (const p of pins) {
    void p; // documented above: absent from the result by design
  }
  return result;
}

/**
 * The routes-aware twin of layoutWithRegions: identical packing, plus each
 * region's edge routes translated by the same origin shift its nodes take,
 * so a routed chain stays glued to its region. Cross-region edges are not
 * in any sub-workspace, so they carry no route and render as before.
 */
function layoutWithRegionsRoutes(
  workspace: Workspace,
  partition: RegionPartition,
  opts: LayoutOptionsResolved,
): { layout: LayoutResult; routes: EdgeRoutes } {
  const result: LayoutResult = {};
  const routes: EdgeRoutes = {};
  const pins = Object.values(workspace.nodes).filter((n) => n.pinned);

  // --- Board flow first: the board's own diagram, excluding region members.
  let boardTop = 0;
  if (partition.board.length > 0) {
    const boardWs = subWorkspaceFor(workspace, partition.board, workspace.diagramKind);
    const boardOut = layoutSingleRoutes(boardWs, workspace.diagramKind, opts);
    Object.assign(result, boardOut.layout);
    for (const [edgeId, pts] of Object.entries(boardOut.routes)) routes[edgeId] = [...pts];
    if (Object.keys(boardOut.layout).length > 0) boardTop = boundsOf(boardOut.layout).h;
  }

  // --- Regions: each under its own strategy.
  const regionLayouts: Array<{
    groupId: string;
    kind: DiagramKind;
    out: { layout: LayoutResult; routes: EdgeRoutes };
  }> = [];
  for (const region of partition.regions) {
    const regionWs = subWorkspaceFor(workspace, region.ids, region.kind);
    regionLayouts.push({
      groupId: region.groupId,
      kind: region.kind,
      out: layoutSingleRoutes(regionWs, region.kind, opts),
    });
  }

  // --- Pack regions along a row, cross-flow, with gutter separation — the
  // same translation layoutWithRegions applies, extended to routes.
  const gap = REGION_GAP;
  let cursorX = 0;
  for (const rl of regionLayouts) {
    const b = boundsOf(rl.out.layout);
    const dx = cursorX - b.x;
    const dy = REGION_STRIP_GAP + boardTop - b.y;
    for (const [id, placed] of Object.entries(rl.out.layout)) {
      result[id] = {
        position: { x: placed.position.x + dx, y: placed.position.y + dy },
        size: placed.size,
      };
    }
    for (const [edgeId, pts] of Object.entries(rl.out.routes)) {
      routes[edgeId] = pts.map((p) => ({ x: p.x + dx, y: p.y + dy }));
    }
    cursorX += b.w + gap;
  }

  for (const p of pins) {
    void p; // absent from the result by design (see layoutWithRegions)
  }
  return { layout: result, routes };
}

/** Dispatch one (sub-)workspace, returning layout and routes together. */
function layoutSingleRoutes(
  ws: Workspace,
  kind: DiagramKind,
  opts: LayoutOptionsResolved,
): { layout: LayoutResult; routes: EdgeRoutes } {
  const strategy = STRATEGY_FOR_KIND[kind] ?? "layered";
  if (strategy === "radial") return { layout: radialLayout(ws, opts), routes: {} };
  if (strategy === "tree") return { layout: treeLayout(ws, opts), routes: {} };
  if (strategy === "swimlane") return { layout: swimlaneLayout(ws, opts), routes: {} };
  if (strategy === "timeline") return { layout: timelineLayout(ws, opts), routes: {} };
  if (strategy === "grid") return { layout: gridLayout(ws, opts), routes: {} };
  if (strategy === "storymap") return { layout: storyMapLayout(ws, opts), routes: {} };
  const layered = layeredLayoutWithRoutes(ws, opts);
  return { ...layered, layout: shrinkPseudoStates(ws, kind, layered.layout) };
}

/**
 * Build the sub-workspace one region (or the board flow) is laid out in: its
 * member nodes, the edges between them, and its own groups (swimlane regions
 * need lane groups inside the region). The diagramKind is the partition's
 * kind, which is what makes each strategy's dispatch local.
 */
function subWorkspaceFor(workspace: Workspace, ids: string[], kind: DiagramKind): Workspace {
  const idSet = new Set(ids);
  const nodes: Workspace["nodes"] = {};
  for (const id of ids) nodes[id] = workspace.nodes[id]!;
  const edges: Workspace["edges"] = {};
  for (const edge of Object.values(workspace.edges)) {
    if (idSet.has(edge.source) && idSet.has(edge.target)) edges[edge.id] = edge;
  }
  const groups: Workspace["groups"] = {};
  for (const [gid, group] of Object.entries(workspace.groups)) {
    if (ids.some((id) => workspace.nodes[id]?.groupId === gid)) groups[gid] = group;
  }
  return { ...workspace, diagramKind: kind, nodes, edges, groups };
}

/** Dispatch one (sub-)workspace through the strategy for its kind. */
function layoutSingle(
  ws: Workspace,
  kind: DiagramKind,
  opts: LayoutOptionsResolved,
): LayoutResult {
  const strategy = STRATEGY_FOR_KIND[kind] ?? "layered";
  if (strategy === "radial") return radialLayout(ws, opts);
  if (strategy === "tree") return treeLayout(ws, opts);
  if (strategy === "swimlane") return swimlaneLayout(ws, opts);
  if (strategy === "timeline") return timelineLayout(ws, opts);
  if (strategy === "grid") return gridLayout(ws, opts);
  if (strategy === "storymap") return storyMapLayout(ws, opts);
  return shrinkPseudoStates(ws, kind, layeredLayout(ws, opts));
}

/**
 * The layered strategy as its own function, so regions call it directly. The
 * original layered path in `computeLayout` stays where it is (boards with no
 * regions run byte-identical code); this wrapper reaches it with the
 * strategy pinned, which skips the region partition and cannot recurse.
 */
function layeredLayout(
  workspace: Workspace,
  opts: LayoutOptionsResolved,
): LayoutResult {
  return computeLayout(workspace, { ...opts, strategy: "layered" });
}

/**
 * Shift freshly-placed nodes clear of nodes the user pinned by hand.
 *
 * The layout engine lays out the graph as if the canvas were empty, but a pinned
 * node keeps its human coordinates — so a new diagram generated onto a board that
 * already has hand-placed cards lands straight on top of them.
 *
 * The whole unpinned block moves together. Pushing nodes individually would
 * clear the pinned obstacle but let two displaced nodes land on each other,
 * because the layout's careful internal spacing would no longer hold.
 */
function avoidPinned(layout: LayoutResult, workspace: Workspace, gap: number): LayoutResult {
  const obstacles = Object.values(workspace.nodes)
    .filter((n) => n.pinned && n.position)
    .map((n) => ({
      x: n.position!.x,
      y: n.position!.y,
      width: n.size?.width ?? 160,
      height: n.size?.height ?? 64,
    }));
  if (obstacles.length === 0) return layout;

  const movable = Object.entries(layout).filter(([id]) => !workspace.nodes[id]?.pinned);
  if (movable.length === 0) return layout;

  const boxOf = ([, p]: [string, LayoutResult[string]]) => ({
    x: p.position.x,
    y: p.position.y,
    width: p.size.width,
    height: p.size.height,
  });
  const block = {
    x: Math.min(...movable.map((m) => boxOf(m).x)),
    y: Math.min(...movable.map((m) => boxOf(m).y)),
    right: Math.max(...movable.map((m) => boxOf(m).x + boxOf(m).width)),
    bottom: Math.max(...movable.map((m) => boxOf(m).y + boxOf(m).height)),
  };

  const hits = (top: number) =>
    obstacles.filter(
      (o) =>
        block.x < o.x + o.width &&
        o.x < block.right &&
        top < o.y + o.height &&
        o.y < top + (block.bottom - block.y),
    );

  // Slide the block down until it clears every obstacle it overlaps.
  let top = block.y;
  for (let pass = 0; pass < 16; pass++) {
    const overlapping = hits(top);
    if (overlapping.length === 0) break;
    top = Math.max(...overlapping.map((o) => o.y + o.height)) + gap;
  }
  const dy = top - block.y;
  if (dy === 0) return layout;

  const out: LayoutResult = { ...layout };
  for (const [id, placed] of movable) {
    out[id] = { position: { x: placed.position.x, y: placed.position.y + dy }, size: placed.size };
  }
  return out;
}

/** Apply a computed layout back onto the workspace nodes (immutably).
 * Only semantic nodes are positioned here; manual shapes keep their own pinned
 * coordinates and are intentionally left untouched (docs/13). Nodes the user has
 * dragged by hand (`pinned`) also keep their coordinates, so a manual
 * arrangement survives later re-layout passes. */
export function applyLayout(workspace: Workspace, layout: LayoutResult): Workspace {
  const resolved = avoidPinned(layout, workspace, DEFAULTS.nodeGap);
  const nodes: Workspace["nodes"] = {};
  for (const [id, node] of Object.entries(workspace.nodes)) {
    const placed = resolved[id];
    if (node.pinned && node.position) {
      // Honor the human placement; still adopt a size if it had none.
      nodes[id] = node.size ? node : { ...node, size: placed?.size ?? node.size };
      continue;
    }
    nodes[id] = placed ? { ...node, position: placed.position, size: placed.size } : node;
  }
  return { ...workspace, nodes };
}

/**
 * Stamp derived edge routes onto a workspace's edges (the route-aware twin of
 * applyLayout writing node positions). A pure clone-and-stamp: edges named in
 * `routes` get their bend points, every other edge keeps whatever it had —
 * including its old route (a region relayout touches only the region's
 * edges; the rest of the board's routes stay put, exactly like their nodes).
 */
export function applyRoutes(workspace: Workspace, routes: EdgeRoutes): Workspace {
  if (Object.keys(routes).length === 0) return workspace;
  const edges: Workspace["edges"] = {};
  for (const [id, edge] of Object.entries(workspace.edges)) {
    const route = routes[id];
    edges[id] = route ? { ...edge, route } : edge;
  }
  return { ...workspace, edges };
}

/**
 * Whether `group` is an activity COLUMN of a story-map board rather than a
 * region. A column's release rows are shared with every other activity, so
 * re-laying it out alone would stack its stories against its own releases
 * only and misalign them with their neighbours (a new "Release 2" story in one
 * activity must open that row across the whole map). The region passes
 * decline such a group with null, and every caller's contract for null is the
 * full-board pass — the one pass that keeps the rows shared.
 */
function isStoryMapColumn(workspace: Workspace, group: Workspace["groups"][string]): boolean {
  return !group.kind && STRATEGY_FOR_KIND[workspace.diagramKind] === "storymap";
}

/**
 * The routes-aware relayoutRegion: the group's members re-layout AND the
 * group's internal edge routes re-derive, shifted to the group's current
 * origin like the nodes. Returns null (no routes) when there is nothing to
 * do, matching relayoutRegion's contract. The caller applies layout first,
 * then routes, so untouched nodes' edges keep their existing routes.
 */
export function relayoutRegionWithRoutes(
  workspace: Workspace,
  groupId: string,
  options: LayoutOptions = {},
): { layout: LayoutResult; routes: EdgeRoutes } | null {
  const group = workspace.groups[groupId];
  if (!group) return null;
  if (isStoryMapColumn(workspace, group)) return null;
  const memberIds = Object.values(workspace.nodes)
    .filter((n) => n.groupId === groupId)
    .map((n) => n.id);
  if (memberIds.length === 0) return null;

  const opts = withIntentDefaults(workspace, options);
  const kind = group.kind ?? workspace.diagramKind;
  const sub = subWorkspaceFor(workspace, memberIds, kind);
  const subOut = layoutSingleRoutes(sub, kind, opts);
  if (Object.keys(subOut.layout).length === 0) return null;

  const placed = memberIds
    .map((id) => workspace.nodes[id])
    .filter((n): n is NonNullable<typeof n> => Boolean(n?.position));
  if (placed.length === 0) return null;
  const originX = Math.min(...placed.map((n) => n.position!.x));
  const originY = Math.min(...placed.map((n) => n.position!.y));
  const b = boundsOf(subOut.layout);
  const dx = originX - b.x;
  const dy = originY - b.y;

  const result: LayoutResult = {};
  for (const [id, node] of Object.entries(workspace.nodes)) {
    if (node.groupId === groupId) continue;
    if (node.position && node.size) {
      result[id] = { position: node.position, size: node.size };
    }
  }
  for (const [id, fresh] of Object.entries(subOut.layout)) {
    result[id] = {
      position: { x: fresh.position.x + dx, y: fresh.position.y + dy },
      size: fresh.size,
    };
  }
  const routes: EdgeRoutes = {};
  for (const [edgeId, pts] of Object.entries(subOut.routes)) {
    routes[edgeId] = pts.map((p) => ({ x: p.x + dx, y: p.y + dy }));
  }
  return { layout: result, routes };
}

/**
 * SPATIAL ADDITIVITY (M2): re-layout ONE group — the meeting-growth invariant.
 *
 * "AI-generated additions must be spatially additive by default; existing
 * committed objects keep their positions unless the user explicitly asks for a
 * transformation." A board that has grown topic-by-topic through a meeting is
 * the user's mental map (left = product, center = architecture, right =
 * roadmap); re-running the full-board layout on every commit rearranges that
 * map out from under them. This entry point re-lays out ONLY the named
 * group's members, under that group's own kind (when it is a region) or the
 * board kind, and merges the result back AT THE REGION'S CURRENT ORIGIN —
 * every node outside the group is returned untouched, so callers can diff.
 *
 * The result is a full LayoutResult whose entries for non-group nodes simply
 * restate their existing positions: `applyLayout` then writes only what
 * changed. Pinned members keep their pinned coordinates through applyLayout's
 * existing contract.
 */
export function relayoutRegion(
  workspace: Workspace,
  groupId: string,
  options: LayoutOptions = {},
): LayoutResult | null {
  const group = workspace.groups[groupId];
  if (!group) return null;
  if (isStoryMapColumn(workspace, group)) return null;
  // Members by the authoritative link (node.groupId), matching splitByRegions.
  const memberIds = Object.values(workspace.nodes)
    .filter((n) => n.groupId === groupId)
    .map((n) => n.id);
  if (memberIds.length === 0) return null;

  const opts = withIntentDefaults(workspace, options);
  const kind = group.kind ?? workspace.diagramKind;
  // The group's own layout, in its own coordinate frame.
  const sub = subWorkspaceFor(workspace, memberIds, kind);
  const subLayout = layoutSingle(sub, kind, opts);
  if (Object.keys(subLayout).length === 0) return null;

  // Where the group lives NOW: the bounding box of its members' current
  // positions. Relayout results are centered around their own origin, so the
  // merge shifts the fresh layout so its top-left lands where the old one was.
  const placed = memberIds
    .map((id) => workspace.nodes[id])
    .filter((n): n is NonNullable<typeof n> => Boolean(n?.position));
  if (placed.length === 0) return null;
  const originX = Math.min(...placed.map((n) => n.position!.x));
  const originY = Math.min(...placed.map((n) => n.position!.y));
  const b = boundsOf(subLayout);
  const dx = originX - b.x;
  const dy = originY - b.y;

  // Full-board result: untouched nodes restate their current positions so
  // applyLayout writes a no-op for them; group members get the new geometry.
  const result: LayoutResult = {};
  for (const [id, node] of Object.entries(workspace.nodes)) {
    if (node.groupId === groupId) continue;
    if (node.position && node.size) {
      result[id] = { position: node.position, size: node.size };
    }
  }
  for (const [id, fresh] of Object.entries(subLayout)) {
    result[id] = {
      position: { x: fresh.position.x + dx, y: fresh.position.y + dy },
      size: fresh.size,
    };
  }
  return result;
}

/**
 * Overlap separation for stable growth (M2): after a region relayout changes a
 * group's footprint, a growing region can extend into the space its right-hand
 * neighbours occupy. Returns LayoutResult entries shifting ONLY the regions
 * whose current bounds the growth would overlap, by the minimum clearance —
 * deterministic, declaration order, no global shuffle. `null` when nothing
 * collides. (Nodes outside any kind-region are never moved by this pass.)
 */
export function separateRegions(workspace: Workspace, growerId: string): LayoutResult | null {
  const grower = workspace.groups[growerId];
  if (!grower) return null;
  const groupIds = Object.keys(workspace.groups).filter((id) => workspace.groups[id]!.kind);
  if (groupIds.length < 2) return null;

  // Current bounds of each region over its members' positions.
  const boundsOfGroup = (gid: string) => {
    const members = Object.values(workspace.nodes)
      .filter((n) => n.groupId === gid && n.position)
      .map((n) => n.position!);
    if (members.length === 0) return null;
    return {
      x1: Math.min(...members.map((p) => p.x)),
      y1: Math.min(...members.map((p) => p.y)),
      x2: Math.max(...members.map((p) => p.x + 160)),
      y2: Math.max(...members.map((p) => p.y + 64)),
    };
  };
  const growerBox = boundsOfGroup(growerId);
  if (!growerBox) return null;

  const shifts: LayoutResult = {};
  // Regions to the right of the grower, in declaration order, pushed right
  // when the grower's new right edge would enter their left edge.
  let pushFrom = growerBox.x2;
  for (const gid of groupIds) {
    if (gid === growerId) continue;
    const box = boundsOfGroup(gid);
    if (!box) continue;
    if (box.x1 < pushFrom + REGION_GAP) {
      const dx = pushFrom + REGION_GAP - box.x1;
      for (const n of Object.values(workspace.nodes)) {
        if (n.groupId === gid && n.position && n.size) {
          shifts[n.id] = { position: { x: n.position.x + dx, y: n.position.y }, size: n.size };
        }
      }
      pushFrom = box.x2 + dx;
    } else {
      pushFrom = box.x2;
    }
  }
  return Object.keys(shifts).length > 0 ? shifts : null;
}

/**
 * The built-in engine, behind the Phase 1 boundary (doc 18). This is the
 * same dispatch `computeLayoutWithRoutes` runs when no override is set,
 * exposed as a named engine so the benchmark runner, the pins, and the
 * Phase 2 ELK comparison can address it through the interface instead of
 * through the implementation's entry points. The region method is the
 * ADR 0015 seam; its spatial-additivity invariant ("region out = 0") is
 * pinned in visual-benchmark.test.ts.
 */
export const CURRENT_LAYOUT_ENGINE: DiagramLayoutEngine = {
  id: "lucent-current",
  supports: () => true,
  layout: ({ workspace, options }) => dispatchLayoutWithRoutes(workspace, options),
  relayoutRegion: (workspace, groupId, options) =>
    relayoutRegionWithRoutes(workspace, groupId, options ?? {}),
};

// ---------------------------------------------------------------------------
// docs/27 D1: new families — timeline and matrix geometry
// ---------------------------------------------------------------------------

const DAY = 86_400_000;

/** A node's due date as a UTC day timestamp, or undefined. */
function dueTime(node: Node | undefined): number | undefined {
  const d = node?.issue?.dueDate;
  if (!d || !/^\d{4}-\d{2}-\d{2}/.test(d)) return undefined;
  const t = Date.parse(`${d.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(t) ? t : undefined;
}

/**
 * The timeline's time → x mapping, shared by the layout and the axis the
 * canvas draws, so a tick and the card it labels can never disagree. Null
 * when fewer than two distinct dates exist (then order, not time, decides).
 */
export function timelineScale(
  workspace: Workspace,
): { t0: number; t1: number; span: number } | null {
  const times = [
    ...new Set(
      Object.values(workspace.nodes)
        .map(dueTime)
        .filter((t): t is number => t !== undefined),
    ),
  ].sort((a, b) => a - b);
  if (times.length < 2) return null;
  return {
    t0: times[0]!,
    t1: times[times.length - 1]!,
    span: Math.max(640, (times.length - 1) * 220),
  };
}

/** Axis ticks for a timeline board: weeks, months or quarters, by range. */
export function timelineTicks(workspace: Workspace): Array<{ x: number; label: string }> {
  const scale = timelineScale(workspace);
  if (!scale) return [];
  const { t0, t1, span } = scale;
  const range = t1 - t0;
  const xOf = (t: number) => ((t - t0) / range) * span;
  const MONTHS = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const ticks: Array<{ x: number; label: string }> = [];
  const start = new Date(t0);
  if (range <= 60 * DAY) {
    // Weekly, on Mondays.
    const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
    d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7));
    for (; d.getTime() <= t1; d.setUTCDate(d.getUTCDate() + 7)) {
      ticks.push({ x: xOf(d.getTime()), label: `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}` });
    }
  } else {
    const step = range > 540 * DAY ? 3 : 1;
    const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
    if (step === 3) d.setUTCMonth(Math.ceil(d.getUTCMonth() / 3) * 3);
    for (; d.getTime() <= t1; d.setUTCMonth(d.getUTCMonth() + step)) {
      const m = d.getUTCMonth();
      const label =
        step === 3
          ? `Q${m / 3 + 1} ${d.getUTCFullYear()}`
          : m === 0
            ? `${MONTHS[m]} ${d.getUTCFullYear()}`
            : MONTHS[m]!;
      ticks.push({ x: xOf(d.getTime()), label });
    }
  }
  return ticks;
}

/** Topological rank over the edges, cycle-tolerant, in insertion order. */
function flowRank(workspace: Workspace): Map<string, number> {
  const ids = Object.keys(workspace.nodes);
  const indeg = new Map(ids.map((id) => [id, 0]));
  const out = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of Object.values(workspace.edges)) {
    if (!out.has(e.source) || !indeg.has(e.target) || e.source === e.target) continue;
    out.get(e.source)!.push(e.target);
    indeg.set(e.target, indeg.get(e.target)! + 1);
  }
  const rank = new Map<string, number>();
  const queue = ids.filter((id) => indeg.get(id) === 0);
  let next = 0;
  while (rank.size < ids.length) {
    if (queue.length === 0) {
      // A cycle with no entry: break it at the first unranked node.
      queue.push(ids.find((id) => !rank.has(id))!);
    }
    const id = queue.shift()!;
    if (rank.has(id)) continue;
    rank.set(id, next++);
    for (const t of out.get(id) ?? []) {
      indeg.set(t, indeg.get(t)! - 1);
      if (indeg.get(t)! <= 0 && !rank.has(t)) queue.push(t);
    }
  }
  return rank;
}

/**
 * Timeline / roadmap: time runs left → right. A dated item (`issue.dueDate`)
 * sits at its date on the shared scale; undated items follow the flow after
 * the last date (a roadmap's "later"). Each group is a lane — a team or
 * workstream — and cards that would overlap in a lane drop into a sub-row.
 * With fewer than two dates, order alone spaces the cards.
 */
function timelineLayout(
  workspace: Workspace,
  opts: LayoutOptionsResolved,
): LayoutResult {
  const { nodeSize, nodeGap, laneGap } = opts;
  const ids = Object.keys(workspace.nodes);
  const result: LayoutResult = {};
  if (ids.length === 0) return result;
  const size = new Map(
    ids.map((id) => [
      id,
      measureNode(workspace.nodes[id]?.label ?? "", nodeSize, {
        extraHeight: nodeCardExtraHeight(workspace.nodes[id]),
      }),
    ]),
  );
  const rank = flowRank(workspace);
  const scale = timelineScale(workspace);
  const step = Math.max(...[...size.values()].map((s) => s.width)) + nodeGap;

  const centreX = new Map<string, number>();
  const undated = ids
    .filter((id) => !scale || dueTime(workspace.nodes[id]) === undefined)
    .sort((a, b) => rank.get(a)! - rank.get(b)!);
  if (scale) {
    for (const id of ids) {
      const t = dueTime(workspace.nodes[id]);
      if (t !== undefined) centreX.set(id, ((t - scale.t0) / (scale.t1 - scale.t0)) * scale.span);
    }
    undated.forEach((id, i) => centreX.set(id, scale.span + (i + 1) * step));
  } else {
    undated.forEach((id, i) => centreX.set(id, i * step));
  }

  // Lanes: ungrouped first, then groups in board order.
  const lanes: string[][] = [ids.filter((id) => !workspace.nodes[id]?.groupId)];
  for (const gid of Object.keys(workspace.groups)) {
    const members = ids.filter((id) => workspace.nodes[id]?.groupId === gid);
    if (members.length) lanes.push(members);
  }

  let laneTop = 0;
  for (const lane of lanes) {
    if (lane.length === 0) continue;
    const rows: number[] = []; // right edge of each sub-row
    const rowHeight = Math.max(...lane.map((id) => size.get(id)!.height));
    for (const id of [...lane].sort((a, b) => centreX.get(a)! - centreX.get(b)!)) {
      const s = size.get(id)!;
      const left = centreX.get(id)! - s.width / 2;
      let row = rows.findIndex((right) => right + nodeGap / 2 <= left);
      if (row < 0) {
        row = rows.length;
        rows.push(-Infinity);
      }
      rows[row] = left + s.width;
      result[id] = { position: { x: left, y: laneTop + row * (rowHeight + 24) }, size: s };
    }
    laneTop += rows.length * (rowHeight + 24) - 24 + laneGap * 0.7;
  }
  return result;
}

/**
 * Matrix (2×2, SWOT, prioritisation grids): every group is a cell, cells
 * tile a grid of equal size in board order (four cells make a 2×2), and each
 * cell's items are packed in rows at its centre. The model chooses the cell,
 * never a coordinate. Ungrouped items line up under the grid.
 */
function gridLayout(
  workspace: Workspace,
  opts: LayoutOptionsResolved,
): LayoutResult {
  const { nodeSize, nodeGap } = opts;
  const ids = Object.keys(workspace.nodes);
  const result: LayoutResult = {};
  if (ids.length === 0) return result;
  const size = new Map(
    ids.map((id) => [
      id,
      measureNode(workspace.nodes[id]?.label ?? "", nodeSize, {
        extraHeight: nodeCardExtraHeight(workspace.nodes[id]),
      }),
    ]),
  );
  const cells = Object.keys(workspace.groups)
    .map((gid) => ids.filter((id) => workspace.nodes[id]?.groupId === gid))
    .filter((m) => m.length > 0);
  const loose = ids.filter((id) => {
    const gid = workspace.nodes[id]?.groupId;
    return !gid || !workspace.groups[gid];
  });

  /** Pack a list into rows of `perRow`; returns item offsets and the block size. */
  const pack = (members: string[]) => {
    const perRow = members.length <= 4 ? 2 : 3;
    const colW = Math.max(...members.map((id) => size.get(id)!.width));
    const rowH = Math.max(...members.map((id) => size.get(id)!.height));
    const cols = Math.min(perRow, members.length);
    const rows = Math.ceil(members.length / perRow);
    const offsets = members.map((id, i) => ({
      id,
      x: (i % perRow) * (colW + nodeGap) + (colW - size.get(id)!.width) / 2,
      y: Math.floor(i / perRow) * (rowH + nodeGap),
    }));
    return {
      offsets,
      w: cols * colW + (cols - 1) * nodeGap,
      h: rows * rowH + (rows - 1) * nodeGap,
    };
  };

  const packed = cells.map(pack);
  const cellPad = 56;
  // A quadrant reads as a quadrant only with room around its items, and its
  // label ("Big bets · high impact, high effort") needs the width.
  const cellW = Math.max(360, Math.max(0, ...packed.map((p) => p.w)) + cellPad * 2);
  const cellH = Math.max(220, Math.max(0, ...packed.map((p) => p.h)) + cellPad * 2);
  const cols =
    cells.length === 4
      ? 2
      : cells.length <= 3
        ? Math.max(1, cells.length)
        : Math.ceil(Math.sqrt(cells.length));
  const gap = 36;
  packed.forEach((p, i) => {
    const cx = (i % cols) * (cellW + gap) + cellW / 2;
    const cy = Math.floor(i / cols) * (cellH + gap) + cellH / 2;
    for (const o of p.offsets) {
      result[o.id] = {
        position: { x: cx - p.w / 2 + o.x, y: cy - p.h / 2 + o.y },
        size: size.get(o.id)!,
      };
    }
  });
  if (loose.length) {
    const p = pack(loose);
    const top = Math.ceil(cells.length / cols) * (cellH + gap) + gap;
    for (const o of p.offsets)
      result[o.id] = { position: { x: o.x, y: top + o.y }, size: size.get(o.id)! };
  }
  return result;
}

// ---------------------------------------------------------------------------
// docs/27 D3: the user story map — activities across, releases down
// ---------------------------------------------------------------------------

/** One activity column of a story map. */
export interface StoryMapColumn {
  /** The activity's group id; null for the trailing column of stories with no activity. */
  groupId: string | null;
  /** What the column's backbone card says: the activity's name, or "Other". */
  label: string;
  /** Left edge and width of the column — its stories and its backbone card. */
  x: number;
  width: number;
}

/** One release row — a slice — of a story map. */
export interface StoryMapRow {
  /** The release (a story's first issue label); null for the Unscheduled row. */
  release: string | null;
  /** What the release gutter says: the release, or "Unscheduled". */
  label: string;
  /** Top edge and height of the row: every cell in it shares its tallest cell's height. */
  y: number;
  height: number;
}

/**
 * A story map's scaffold, in the same frame `computeLayout` places the stories
 * in: the backbone band across the top, the release gutter down the left, and
 * the column and row every story was placed by. The canvas draws the backbone
 * cards and release slices from this rather than guessing from card positions,
 * so a card and the slice it reads under can never disagree — the pattern
 * `timelineScale` set for the time axis.
 */
export interface StoryMapGrid {
  columns: StoryMapColumn[];
  rows: StoryMapRow[];
  /** The backbone band: one activity card per column, above the first row. */
  header: { y: number; height: number };
  /** The release-label gutter, left of the first column. */
  gutter: { x: number; width: number };
  /** The whole map: gutter, backbone and every cell. */
  bounds: { x: number; y: number; width: number; height: number };
}

/** The trailing column's label: stories that belong to no activity. */
export const STORY_MAP_OTHER = "Other";
/** The last row's label: stories no release has claimed yet. */
export const STORY_MAP_UNSCHEDULED = "Unscheduled";

/**
 * Between columns. More than twice the canvas's group padding (22px a side),
 * so neighbouring activities' column boxes never touch.
 */
const SM_COL_GAP = 64;
/** Between release rows; the canvas runs the slice line down its middle. */
const SM_ROW_GAP = 56;
/** Between stories stacked in one cell: a cell reads as one short list. */
const SM_STACK_GAP = 16;
/** Between the backbone band and the first release row. */
const SM_HEADER_GAP = 48;
/** Between the release gutter and the first column. */
const SM_GUTTER_GAP = 48;
/** A backbone card's base height: a single title line, quieter than a story card. */
const SM_HEADER_BASE_HEIGHT = 44;
/**
 * The gutter's width per character of the longest release name — the canvas
 * sets it in 10.5px mono caps with a little tracking — and its bounds: never so
 * narrow that "MVP" crowds the first column, never so wide that one long name
 * pushes the whole map right (a longer one wraps instead).
 */
const SM_GUTTER_CHAR = 7;
const SM_GUTTER_MIN = 96;
const SM_GUTTER_MAX = 200;

/** A story's release: the first of its issue labels, trimmed; null when it has none. */
function storyRelease(node: Node | undefined): string | null {
  const first = node?.issue?.labels?.[0]?.trim();
  return first ? first : null;
}

/**
 * The one pass behind both `storyMapLayout` (the cards) and `storyMapGrid`
 * (the scaffold the canvas draws), so the two cannot drift.
 */
function storyMapGeometry(
  workspace: Workspace,
  opts: LayoutOptionsResolved,
): { layout: LayoutResult; grid: StoryMapGrid } {
  const { nodeSize } = opts;
  const ids = Object.keys(workspace.nodes);
  const size = new Map(
    ids.map((id) => [
      id,
      measureNode(workspace.nodes[id]?.label ?? "", nodeSize, {
        extraHeight: nodeCardExtraHeight(workspace.nodes[id]),
      }),
    ]),
  );

  // Columns: every activity in creation order — one with no stories yet is
  // still a step of the user's journey and keeps its place on the backbone —
  // then "Other" for stories whose activity is missing, always last.
  const columns: Array<{ groupId: string | null; label: string; stories: string[] }> =
    Object.entries(workspace.groups).map(([gid, group]) => ({
      groupId: gid,
      label: group.label,
      stories: [],
    }));
  const columnOf = new Map(columns.map((col, i) => [col.groupId, i]));
  let other: (typeof columns)[number] | undefined;
  for (const id of ids) {
    const gid = workspace.nodes[id]?.groupId;
    const col = gid === undefined ? undefined : columnOf.get(gid);
    if (col !== undefined) columns[col]!.stories.push(id);
    else (other ??= { groupId: null, label: STORY_MAP_OTHER, stories: [] }).stories.push(id);
  }
  if (other) columns.push(other);

  // Rows: releases in order of first appearance, walking stories in creation
  // order, so the release the model named first is the top slice. Unscheduled
  // is always last: work nobody has scheduled sits below every release.
  const releases: Array<string | null> = [];
  const rowOf = new Map<string | null, number>();
  let unscheduled = false;
  for (const id of ids) {
    const release = storyRelease(workspace.nodes[id]);
    if (release === null) unscheduled = true;
    else if (!rowOf.has(release)) {
      rowOf.set(release, releases.length);
      releases.push(release);
    }
  }
  if (unscheduled) {
    rowOf.set(null, releases.length);
    releases.push(null);
  }

  // cells[c][r]: activity c's stories in release r, in creation order.
  const cells = columns.map((col) => {
    const byRow = releases.map((): string[] => []);
    for (const id of col.stories) byRow[rowOf.get(storyRelease(workspace.nodes[id]))!]!.push(id);
    return byRow;
  });
  const stackHeight = (stack: readonly string[]) =>
    stack.reduce((sum, id) => sum + size.get(id)!.height, 0) +
    Math.max(0, stack.length - 1) * SM_STACK_GAP;

  // A column is as wide as its widest story or its backbone card, whichever
  // is wider, so the activity's name is never clipped over narrow stories.
  const headerSizes = columns.map((col) =>
    measureNode(col.label, { width: nodeSize.width, height: SM_HEADER_BASE_HEIGHT }),
  );
  const widths = columns.map((col, c) =>
    Math.max(headerSizes[c]!.width, ...col.stories.map((id) => size.get(id)!.width)),
  );
  // Every cell in a row shares the row's height — its tallest cell — so each
  // release reads as one straight band across the map.
  const heights = releases.map((_, r) =>
    Math.max(nodeSize.height, ...cells.map((byRow) => stackHeight(byRow[r]!))),
  );
  const headerHeight = Math.max(SM_HEADER_BASE_HEIGHT, ...headerSizes.map((s) => s.height));
  const gutterWidth = Math.min(
    SM_GUTTER_MAX,
    Math.max(
      SM_GUTTER_MIN,
      ...releases.map((r) => Math.ceil((r ?? STORY_MAP_UNSCHEDULED).length * SM_GUTTER_CHAR + 16)),
    ),
  );

  // The gutter and the backbone band hold the map's top-left corner at the
  // origin; the first cell starts right of the one and below the other.
  let x = gutterWidth + SM_GUTTER_GAP;
  const gridColumns: StoryMapColumn[] = columns.map((col, c) => {
    const placed = { groupId: col.groupId, label: col.label, x, width: widths[c]! };
    x += widths[c]! + SM_COL_GAP;
    return placed;
  });
  let y = headerHeight + SM_HEADER_GAP;
  const gridRows: StoryMapRow[] = releases.map((release, r) => {
    const placed = { release, label: release ?? STORY_MAP_UNSCHEDULED, y, height: heights[r]! };
    y += heights[r]! + SM_ROW_GAP;
    return placed;
  });

  const layout: LayoutResult = {};
  cells.forEach((byRow, c) => {
    const col = gridColumns[c]!;
    byRow.forEach((stack, r) => {
      let top = gridRows[r]!.y;
      for (const id of stack) {
        const s = size.get(id)!;
        // Centred in the column, so cards of different widths still hang as
        // one column under their activity.
        layout[id] = {
          position: { x: col.x + Math.round((col.width - s.width) / 2), y: top },
          size: s,
        };
        top += s.height + SM_STACK_GAP;
      }
    });
  });

  const lastColumn = gridColumns.at(-1);
  const lastRow = gridRows.at(-1);
  return {
    layout,
    grid: {
      columns: gridColumns,
      rows: gridRows,
      header: { y: 0, height: headerHeight },
      gutter: { x: 0, width: gutterWidth },
      bounds: {
        x: 0,
        y: 0,
        width: lastColumn ? lastColumn.x + lastColumn.width : gutterWidth,
        height: lastRow ? lastRow.y + lastRow.height : headerHeight,
      },
    },
  };
}

/**
 * User story map: the backbone of user activities runs left to right, each
 * activity's stories hang beneath it, and horizontal slices cut the map into
 * releases, earliest on top. The model supplies only meaning — each group is
 * an activity, a story's first issue label names its release — and this pass
 * turns it into the grid:
 *  - one column per group, in creation order, as wide as its widest card;
 *    stories with no activity share a trailing "Other" column;
 *  - one row per release, in order of first appearance walking stories in
 *    creation order; stories with no label share a last "Unscheduled" row;
 *  - a cell's stories stack top-down in creation order.
 * The backbone band above the first row and the release gutter left of the
 * first column are left empty for the canvas to draw (`storyMapGrid`). Edges
 * are drawn but never move a card: a story map's order is its backbone, not a
 * flow. A pinned story still holds its slot, so dragging one card never
 * reshuffles the map; `applyLayout` keeps the hand placement, as it does for
 * every strategy.
 */
function storyMapLayout(
  workspace: Workspace,
  opts: LayoutOptionsResolved,
): LayoutResult {
  return storyMapGeometry(workspace, opts).layout;
}

/**
 * The scaffold of a story-map board — backbone columns and release rows — in
 * the frame `computeLayout` placed its stories in. For a whole story-map board
 * (the family is not regionable, so there is no region form); the canvas
 * draws it only when the board has no regions, as it does the timeline axis.
 */
export function storyMapGrid(workspace: Workspace, options: LayoutOptions = {}): StoryMapGrid {
  return storyMapGeometry(workspace, withIntentDefaults(workspace, options)).grid;
}

/**
 * Pseudo-states (docs/27 D1): a state machine's start/end and a BPMN board's
 * start/end events are small circles, not cards. The layout places them like
 * any node, then sizes them to the circle around the same centre — edges
 * attach to what is drawn, and the card-sized box that made the canvas render
 * big ellipses is gone.
 */
const PSEUDO_SIZE = 36;

/**
 * Pseudo-nodes (a state machine's start dot, a BPMN event) are drawn small.
 * Which node types are pseudo in which family comes from the registry
 * (`pseudoRoleFor`), the same answer the canvas draws their shapes from — so a
 * node the layout shrinks is always one the canvas draws as a dot.
 */
function shrinkPseudoStates(
  workspace: Workspace,
  kind: DiagramKind,
  layout: LayoutResult,
): LayoutResult {
  let out: LayoutResult | null = null;
  for (const [id, box] of Object.entries(layout)) {
    const t = workspace.nodes[id]?.nodeType;
    if (!t || !pseudoRoleFor(kind, t)) continue;
    out ??= { ...layout };
    out[id] = {
      position: {
        x: box.position.x + box.size.width / 2 - PSEUDO_SIZE / 2,
        y: box.position.y + box.size.height / 2 - PSEUDO_SIZE / 2,
      },
      size: { width: PSEUDO_SIZE, height: PSEUDO_SIZE },
    };
  }
  return out ?? layout;
}
