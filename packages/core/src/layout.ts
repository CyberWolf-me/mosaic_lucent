import type { DiagramKind, Position, Size, Workspace } from "./model.js";

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

export type LayoutStrategy = "layered" | "radial" | "tree" | "swimlane";

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
}

const DEFAULTS: Required<Omit<LayoutOptions, "strategy">> = {
  nodeSize: { width: 160, height: 64 },
  layerGap: 120,
  nodeGap: 48,
  direction: "vertical",
  ringGap: 220,
  laneGap: 150,
};

/** Which geometry suits each representation. */
const STRATEGY_FOR_KIND: Record<DiagramKind, LayoutStrategy> = {
  flowchart: "layered",
  architecture: "layered",
  journey: "layered",
  mindmap: "radial",
  decisiontree: "tree",
  orgchart: "tree",
  process: "swimlane",
};

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
export function measureNode(
  label: string,
  base: Size,
  opts: { charWidth?: number; maxWidth?: number; lineHeight?: number } = {},
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
  const height = Math.max(base.height, base.height + (lines - 1) * lineHeight);
  return { width, height };
}

export function computeLayout(workspace: Workspace, options: LayoutOptions = {}): LayoutResult {
  const opts = { ...DEFAULTS, ...options };
  const nodeIds = Object.keys(workspace.nodes);
  const result: LayoutResult = {};
  if (nodeIds.length === 0) return result;

  // Diagram regions (per-group `kind`): a board may carry several diagrams — a
  // flowchart for the checkout AND a mind map for pricing ideas. Partitioning
  // happens before strategy dispatch so no caller has to know regions exist.
  // Only the region's own nodes/edges/groups enter its sub-workspace: a sub
  // layout reads membership, so the same nodes it places are the ones its
  // geometry talks about. An explicit `strategy` option is a caller override
  // (a user asking "lay the whole board out as a tree") and suspends the split.
  if (!options.strategy) {
    const partition = splitByRegions(workspace);
    if (partition) return layoutWithRegions(workspace, partition, opts);
  }

  // An explicit strategy always wins so callers can override the default.
  const strategy = options.strategy ?? STRATEGY_FOR_KIND[workspace.diagramKind] ?? "layered";
  if (strategy === "radial") return radialLayout(workspace, opts);
  if (strategy === "tree") return treeLayout(workspace, opts);
  if (strategy === "swimlane") return swimlaneLayout(workspace, opts);

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

  // Assign layers via Kahn-style longest-path. Cycles are broken by processing
  // remaining nodes at their current best layer, so layout never hangs.
  const layer = new Map<string, number>();
  for (const id of nodeIds) layer.set(id, 0);

  const remainingIndegree = new Map(indegree);
  const queue = nodeIds.filter((id) => (remainingIndegree.get(id) ?? 0) === 0);
  const visited = new Set<string>();

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const currentLayer = layer.get(id) ?? 0;
    for (const target of outgoing.get(id) ?? []) {
      layer.set(target, Math.max(layer.get(target) ?? 0, currentLayer + 1));
      const deg = (remainingIndegree.get(target) ?? 0) - 1;
      remainingIndegree.set(target, deg);
      if (deg <= 0) queue.push(target);
    }
  }
  // Any nodes left unvisited (cycles) keep layer 0; still get placed.

  // Group nodes by layer, ordered deterministically by insertion order.
  const layers = new Map<number, string[]>();
  for (const id of nodeIds) {
    const l = layer.get(id) ?? 0;
    if (!layers.has(l)) layers.set(l, []);
    layers.get(l)!.push(id);
  }

  const { nodeSize, layerGap, nodeGap, direction } = opts;
  const sortedLayers = [...layers.keys()].sort((a, b) => a - b);

  // Reduce edge crossings before assigning coordinates. Raw insertion order is
  // what makes generated diagrams look tangled: a node's parents can sit at the
  // far end of the previous layer, so its edge cuts across every sibling. This
  // is the standard Sugiyama ordering phase — sort each layer by the mean index
  // of its neighbours in the already-ordered previous layer, sweeping forward
  // then backward. Stable and deterministic: ties keep their earlier order.
  const incoming = new Map<string, string[]>();
  for (const id of nodeIds) incoming.set(id, []);
  for (const edge of Object.values(workspace.edges)) {
    if (!incoming.has(edge.target) || !outgoing.has(edge.source)) continue;
    incoming.get(edge.target)!.push(edge.source);
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
      layers.set(cur, byBarycenter(layers.get(cur)!, next, outgoing));
    }
  }

  // Walk the layers once to find where each row starts along the flow axis,
  // accounting for rows made taller by wrapped labels.
  const layerOffsets = new Map<number, number>();
  {
    let along = 0;
    for (const l of sortedLayers) {
      layerOffsets.set(l, along);
      const ids = layers.get(l)!;
      const extent = Math.max(
        ...ids.map((id) => {
          const s = measureNode(workspace.nodes[id]?.label ?? "", nodeSize);
          return direction === "vertical" ? s.height : s.width;
        }),
        direction === "vertical" ? nodeSize.height : nodeSize.width,
      );
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
      layers
        .get(l)!
        .reduce(
          (sum, id) => sum + measureNode(workspace.nodes[id]?.label ?? "", nodeSize).width,
          0,
        ),
    ),
    nodeSize.width,
  );
  const flowSpan = [...layerOffsets.values()].at(-1) ?? 0;
  const shouldWrap =
    sortedLayers.length > WRAP_ROW_LAYERS && pinnedCount === 0 && flowSpan > widestRow * 1.6;

  if (shouldWrap) {
    const wrapped = {} as LayoutResult;
    // Rows stack along the CROSS axis: row 0 starts at x=0, row 1 begins to
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
          ids.map((id) => [id, measureNode(workspace.nodes[id]?.label ?? "", nodeSize)] as const),
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
    return wrapped;
  }

  for (const l of sortedLayers) {
    const ids = layers.get(l)!;
    const isVertical = direction === "vertical";
    // Size each card to its label first, then lay the row out against the real
    // widths so wide cards don't overlap their neighbours.
    const sizes = new Map(
      ids.map((id) => [id, measureNode(workspace.nodes[id]?.label ?? "", nodeSize)] as const),
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

  return result;
}

/**
 * Radial layout for mind maps: the most-connected node sits at the centre and
 * each breadth-first ring fans out around it. Deterministic — ring membership
 * and angle come from BFS order, so the same graph always lays out identically.
 */
function radialLayout(
  workspace: Workspace,
  opts: Required<Omit<LayoutOptions, "strategy">>,
): LayoutResult {
  const { nodeSize, ringGap } = opts;
  const nodeIds = Object.keys(workspace.nodes);
  const result: LayoutResult = {};
  // Per-node measured size so a long label gets the room it needs (M0.5).
  // Without this, every node is the default size and labels clip on the outer
  // rings where two siblings sit close.
  const measured = new Map<string, Size>(
    nodeIds.map((id) => [id, measureNode(workspace.nodes[id]?.label ?? "", nodeSize)] as const),
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
    const radius = ring * (ringGap + widest / 2);
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
  opts: Required<Omit<LayoutOptions, "strategy">>,
): LayoutResult {
  const { nodeSize, layerGap, nodeGap } = opts;
  const nodeIds = Object.keys(workspace.nodes);
  const result: LayoutResult = {};
  // Per-node measured size so the leaf-packing step uses the actual width of
  // each leaf, not the default (M0.5). Without this two leaves with long
  // labels overlap because the cursor advances by the default width only.
  const measured = new Map<string, Size>(
    nodeIds.map((id) => [id, measureNode(workspace.nodes[id]?.label ?? "", nodeSize)] as const),
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
  opts: Required<Omit<LayoutOptions, "strategy">>,
): LayoutResult {
  const { nodeSize, layerGap, laneGap } = opts;
  const nodeIds = Object.keys(workspace.nodes);
  const result: LayoutResult = {};
  // Per-node measured size so a wide node in one column reserves the next
  // column for the next node (M0.5). Without this every column is the default
  // width and the column-step carves lanes narrower than a long label needs.
  const measured = new Map<string, Size>(
    nodeIds.map((id) => [id, measureNode(workspace.nodes[id]?.label ?? "", nodeSize)] as const),
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
function layoutWithRegions(
  workspace: Workspace,
  partition: RegionPartition,
  opts: Required<Omit<LayoutOptions, "strategy">>,
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
  opts: Required<Omit<LayoutOptions, "strategy">>,
): LayoutResult {
  const strategy = STRATEGY_FOR_KIND[kind] ?? "layered";
  if (strategy === "radial") return radialLayout(ws, opts);
  if (strategy === "tree") return treeLayout(ws, opts);
  if (strategy === "swimlane") return swimlaneLayout(ws, opts);
  return layeredLayout(ws, opts);
}

/**
 * The layered strategy as its own function, so regions call it directly. The
 * original layered path in `computeLayout` stays where it is (boards with no
 * regions run byte-identical code); this wrapper reaches it with the
 * strategy pinned, which skips the region partition and cannot recurse.
 */
function layeredLayout(
  workspace: Workspace,
  opts: Required<Omit<LayoutOptions, "strategy">>,
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
  // Members by the authoritative link (node.groupId), matching splitByRegions.
  const memberIds = Object.values(workspace.nodes)
    .filter((n) => n.groupId === groupId)
    .map((n) => n.id);
  if (memberIds.length === 0) return null;

  const opts = { ...DEFAULTS, ...options };
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
    .filter((n): n is NonNullable<typeof n> => !!n?.position);
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
