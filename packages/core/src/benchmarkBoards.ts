/**
 * Deterministic synthetic boards for the visual benchmark — the fixture half of
 * the measure-before-building rule. Each generator builds the workload its
 * layout strategy actually faces in production (not a random soup: a random
 * graph's crossings say nothing about the layered engine's Sugiyama pass).
 *
 * All generators are pure functions of (n, seed) — the same inputs always
 * produce the same board, so a metric regression is a layout regression,
 * never a fixture roll. No Math.random anywhere: the "seed" is a stride.
 *
 * The shapes deliberately mirror what the AI actually emits for each kind:
 *  - flowchart/architecture — wide layered DAGs with cross-layer skips and a
 *    back edge (the live pass's "return edge crossing the canvas" case);
 *  - mindmap — a shallow radial tree with a few cross-links;
 *  - decisiontree/orgchart — a proper ternary tree, deep not wide;
 *  - process — swimlanes: groups as lanes, flow left→right along a lane with
 *    handoffs between lanes (the thing swimlane layout exists to keep legible).
 */

import {
  createWorkspace,
  type DiagramKind,
  type Edge,
  type Node,
  type Workspace,
} from "./model.js";

/** Numbered ids so boards are readable when debugged visually. */
const id = (prefix: string, i: number) => `${prefix}-${String(i).padStart(3, "0")}`;

function addNode(ws: Workspace, i: number, nodeType: string, prefix = "n"): Node {
  const node: Node = { id: id(prefix, i), nodeType, label: `${nodeType} ${i}` };
  ws.nodes[node.id] = node;
  return node;
}

function addEdge(ws: Workspace, source: string, target: string, relationship: string): Edge {
  const edge: Edge = { id: `e-${source}-${target}`, source, target, relationship };
  ws.edges[edge.id] = edge;
  return edge;
}

/**
 * Layered DAG (flowchart/architecture): k = ~sqrt(n) layers sized so total
 * nodes ≈ n; every node links to 1–2 nodes STRICTLY one layer back (index
 * arithmetic keeps the parent inside the previous band), plus a skip edge
 * two layers back (the "Stripe calls the DB directly" shape) and one back
 * edge at the end (the return path). Layer indices are explicit — no
 * derived arithmetic — so the Kahn pass sees exactly the intended bands
 * (verified: the layered ladder's median row holds ~sqrt(n) nodes).
 */
export function layeredBoard(n: number, seed = 1): Workspace {
  const ws = createWorkspace({ id: "bench-layered", name: `Layered ${n}`, diagramKind: "flowchart" });
  const layers = Math.max(2, Math.round(Math.sqrt(n)));
  const perLayer = Math.max(2, Math.ceil(n / layers));
  // rows[l] = the node ids placed in layer l.
  const rows: string[][] = [];
  let count = 0;
  for (let l = 0; l < layers && count < n; l++) {
    rows.push([]);
    for (let j = 0; j < perLayer && count < n; j++, count++) {
      const node = addNode(ws, count, l === 0 ? "entry" : "service");
      node.metadata = { layer: l };
      rows[l]!.push(node.id);
    }
  }
  for (let l = 1; l < rows.length; l++) {
    const prev = rows[l - 1]!;
    rows[l]!.forEach((id, j) => {
      // Parent: the previous layer, stride-offset so consecutive children
      // spread across parents instead of stacking on the first.
      const parent = prev[(j + seed) % prev.length]!;
      addEdge(ws, parent, id, "calls");
      // Second parent for density: the previous layer's next node.
      const alt = prev[(j + seed + 1) % prev.length]!;
      if ((j + seed) % 2 === 0 && alt !== parent) addEdge(ws, alt, id, "calls");
      // The skip edge: two layers back, stride-selected.
      if (l > 1) {
        const skips = rows[l - 2]!;
        const skip = skips[(j + seed) % skips.length]!;
        if ((j + seed) % 3 === 0) addEdge(ws, skip, id, "bypasses");
      }
    });
  }
  // The back edge: last node → first, the flowchart return path.
  const first = rows[0]?.[0];
  const lastRow = rows[rows.length - 1] ?? [];
  const last = lastRow[lastRow.length - 1];
  if (first && last && first !== last) addEdge(ws, last, first, "returns to");
  return ws;
}

/** Mind map: a central topic, 4–6 primary branches, fan-out per branch,
 *  plus cross-links between neighbouring branches (real mind maps connect). */
export function radialBoard(n: number, seed = 1): Workspace {
  const ws = createWorkspace({ id: "bench-radial", name: `Radial ${n}`, diagramKind: "mindmap" });
  addNode(ws, 0, "topic", "topic");
  const branches = Math.max(3, Math.min(6, Math.round(n / 8)));
  const perBranch = Math.max(2, Math.ceil((n - 1) / branches));
  let count = 1;
  for (let b = 0; b < branches && count < n; b++) {
    const branch = addNode(ws, count, "branch", "n");
    count++;
    addEdge(ws, id("topic", 0), branch.id, "spans");
    let prev = branch.id;
    for (let j = 1; j < perBranch && count < n; j++, count++) {
      const leaf = addNode(ws, count, "idea", "n");
      addEdge(ws, j === 1 ? branch.id : prev, leaf.id, "supports");
      prev = leaf.id;
      // Cross-link to the next branch's first leaf: real mind-map mess.
      if ((j + seed) % 4 === 0 && b + 1 < branches) {
        const neighbour = id("n", count + perBranch - j + 1);
        if (ws.nodes[neighbour]) addEdge(ws, leaf.id, neighbour, "relates to");
      }
    }
  }
  return ws;
}

/** Decision tree / org chart: a ternary tree — deep, sibling-heavy, the
 *  shape tidy-tree layout is graded on (parent centred over its children). */
export function treeBoard(n: number, _seed = 1): Workspace {
  const ws = createWorkspace({ id: "bench-tree", name: `Tree ${n}`, diagramKind: "decisiontree" });
  for (let i = 0; i < n; i++) addNode(ws, i, i === 0 ? "root" : "choice", "n");
  for (let i = 1; i < n; i++) addEdge(ws, id("n", Math.floor((i - 1) / 3)), id("n", i), "leads to");
  return ws;
}

/** Process map: `lanes` swimlanes, a chain of steps per lane flowing
 *  left→right, with deterministic handoffs to the next lane (the crossing
 *  risk swimlane layout exists to manage). */
export function swimlaneBoard(n: number, seed = 1): Workspace {
  const ws = createWorkspace({ id: "bench-swimlane", name: `Swimlane ${n}`, diagramKind: "process" });
  const lanes = Math.max(2, Math.min(5, Math.round(n / 10)));
  const perLane = Math.max(2, Math.ceil(n / lanes));
  let count = 0;
  for (let lane = 0; lane < lanes && count < n; lane++) {
    const group = { id: `lane-${lane}`, label: `Lane ${lane}`, children: [] as string[] };
    let prev: string | null = null;
    for (let j = 0; j < perLane && count < n; j++, count++) {
      const node = addNode(ws, count, "step", "n");
      node.groupId = group.id;
      group.children.push(node.id);
      if (prev) addEdge(ws, prev, node.id, "then");
      // The handoff: every few steps jump to the next lane (the review's
      // exact "swimlane crossing" worry, made deterministic).
      if ((j + seed) % 3 === 2 && lane + 1 < lanes && count + 1 < n) {
        const target = id("n", count + perLane - j - 1 + perLane * 0);
        // Link to the lane's first not-yet-created step via a placeholder-free
        // approach: connect to the next lane's first node id directly.
        const nextLaneFirst = id("n", (lane + 1) * perLane);
        const chosen = ws.nodes[target] ? target : nextLaneFirst;
        addEdge(ws, node.id, chosen, "hands off to");
      }
      prev = node.id;
    }
    ws.groups[group.id] = { ...group };
  }
  return ws;
}

export interface BoardFactory {
  readonly kind: DiagramKind;
  readonly label: string;
  build: (n: number, seed?: number) => Workspace;
}

/**
 * Local edge helper with collision-safe ids: the adversarial and dense
 * generators can legitimately produce two edges between the same pair
 * (multi-parent + diamond rules), and a silent id overwrite would drop an
 * edge and undercount the workload.
 */
function addEdgeUnique(ws: Workspace, source: string, target: string, relationship: string): Edge {
  let id = `e-${source}-${target}`;
  for (let i = 2; ws.edges[id]; i++) id = `e-${source}-${target}-${i}`;
  const edge: Edge = { id, source, target, relationship };
  ws.edges[id] = edge;
  return edge;
}

/**
 * DENSE layered workload (Phase 0): the fan-in/fan-out stress the layered
 * engine meets on real architecture boards — 2–3 parents per node, skip
 * edges, same-layer peer edges (which the DFS layering must resolve), and
 * the return edge. Edge count ≈ 2.2–2.5× node count at every scale.
 */
export function denseBoard(n: number, seed = 1): Workspace {
  const ws = createWorkspace({ id: "bench-dense", name: `Dense ${n}`, diagramKind: "flowchart" });
  const layers = Math.max(2, Math.round(Math.sqrt(n)));
  const perLayer = Math.max(2, Math.ceil(n / layers));
  const rows: string[][] = [];
  let count = 0;
  for (let l = 0; l < layers && count < n; l++) {
    rows.push([]);
    for (let j = 0; j < perLayer && count < n; j++, count++) {
      const node = addNode(ws, count, "service");
      node.metadata = { layer: l };
      rows[l]!.push(node.id);
    }
  }
  for (let l = 1; l < rows.length; l++) {
    const prev = rows[l - 1]!;
    const cur = rows[l]!;
    cur.forEach((cid, j) => {
      // Fan-in 2: two parents in the previous layer, stride-offset.
      addEdgeUnique(ws, prev[(j + seed) % prev.length]!, cid, "calls");
      addEdgeUnique(ws, prev[(j + seed + 1) % prev.length]!, cid, "calls");
      // Skip edge two layers back, every other node.
      if (l > 1 && (j + seed) % 2 === 0) {
        addEdgeUnique(ws, rows[l - 2]![(j + seed) % rows[l - 2]!.length]!, cid, "bypasses");
      }
    });
    // Same-layer peers: the ordering pass must place these without dropping
    // the row structure.
    for (let j = 0; j + 1 < cur.length; j += 3) {
      addEdgeUnique(ws, cur[j]!, cur[j + 1]!, "pairs with");
    }
  }
  const first = rows[0]?.[0];
  const lastRow = rows[rows.length - 1] ?? [];
  const last = lastRow[lastRow.length - 1];
  if (first && last && first !== last) addEdgeUnique(ws, last, first, "returns to");
  return ws;
}

/**
 * ADVERSARIAL workload (Phase 0): everything the layering pass exists to
 * survive, on one board — repeated diamonds, triple fan-ins, and a back edge
 * every third layer (each one a cycle the DFS layering must detect without
 * starving layers, the exact defect class the V5 resolution fixed once).
 */
export function adversarialBoard(n: number, seed = 1): Workspace {
  const ws = createWorkspace({
    id: "bench-adversarial",
    name: `Adversarial ${n}`,
    diagramKind: "flowchart",
  });
  const layers = Math.max(3, Math.round(Math.sqrt(n)));
  const perLayer = Math.max(2, Math.ceil(n / layers));
  const rows: string[][] = [];
  let count = 0;
  for (let l = 0; l < layers && count < n; l++) {
    rows.push([]);
    for (let j = 0; j < perLayer && count < n; j++, count++) {
      const node = addNode(ws, count, "service");
      node.metadata = { layer: l };
      rows[l]!.push(node.id);
    }
  }
  for (let l = 1; l < rows.length; l++) {
    const prev = rows[l - 1]!;
    const cur = rows[l]!;
    cur.forEach((cid, j) => {
      addEdgeUnique(ws, prev[(j + seed) % prev.length]!, cid, "calls");
      // Triple fan-in for every third node: two layers back, two parents.
      if (l > 1 && j % 3 === 0) {
        const back = rows[l - 2]!;
        addEdgeUnique(ws, back[(j + seed) % back.length]!, cid, "bypasses");
        addEdgeUnique(ws, back[(j + seed + 2) % back.length]!, cid, "bypasses");
      }
    });
    // Explicit diamond every four nodes: u → a, u → b, a → w, b → w — the
    // shape that forces the ordering pass to choose a side for the middle
    // pair, twice per diamond.
    if (l + 2 < rows.length && cur.length >= 2 && rows[l + 1]!.length >= 2) {
      const u = cur[0]!;
      const a = rows[l + 1]![0]!;
      const b = rows[l + 1]![1]!;
      const w = rows[l + 2]![0]!;
      addEdgeUnique(ws, u, a, "branches to");
      addEdgeUnique(ws, u, b, "branches to");
      addEdgeUnique(ws, a, w, "merges into");
      addEdgeUnique(ws, b, w, "merges into");
    }
    // A back edge every third layer: l → l-3 (a cycle whenever a forward
    // path exists — which it always does from layer 0).
    if (l >= 3 && l % 3 === 0) {
      addEdgeUnique(ws, cur[cur.length - 1]!, rows[l - 3]![0]!, "falls back to");
    }
  }
  const first = rows[0]?.[0];
  const lastRow = rows[rows.length - 1] ?? [];
  const last = lastRow[lastRow.length - 1];
  if (first && last && first !== last) addEdgeUnique(ws, last, first, "returns to");
  return ws;
}

/**
 * LONG-EDGE workload (Phase 0): constant row width of 4 keeps the deep-chain
 * wrap gate (median row ≤ 3) OFF, so skip edges MUST span a quarter, a half,
 * and three quarters of the board's depth — the "one edge crossing
 * everything" case as a graded workload, from hundreds to thousands of px as
 * the ladder scales.
 */
export function longEdgeBoard(n: number, seed = 1): Workspace {
  const ws = createWorkspace({
    id: "bench-longedge",
    name: `Long edge ${n}`,
    diagramKind: "flowchart",
  });
  const width = 4;
  const layers = Math.max(3, Math.ceil(n / width));
  const rows: string[][] = [];
  let count = 0;
  for (let l = 0; l < layers && count < n; l++) {
    rows.push([]);
    for (let j = 0; j < width && count < n; j++, count++) {
      const node = addNode(ws, count, "service");
      node.metadata = { layer: l };
      rows[l]!.push(node.id);
    }
  }
  const depth = rows.length - 1;
  const spans = [
    Math.max(1, Math.round(depth * 0.25)),
    Math.max(2, Math.round(depth * 0.5)),
    Math.max(3, Math.round(depth * 0.75)),
  ];
  for (let l = 0; l < rows.length; l++) {
    const row = rows[l]!;
    // The spine: one chain edge per layer pair, first column.
    if (l + 1 < rows.length && row[0] && rows[l + 1]![0]) {
      addEdgeUnique(ws, row[0], rows[l + 1]![0]!, "calls");
    }
    // The long skips: second column, spanning ¼ / ½ / ¾ of the depth.
    const span = spans[l % 3]!;
    if (row[1] && l + span <= depth && rows[l + span]![1]) {
      addEdgeUnique(ws, row[1], rows[l + span]![1]!, "bypasses");
    }
  }
  const first = rows[0]?.[0];
  const lastRow = rows[rows.length - 1] ?? [];
  const last = lastRow[0];
  if (first && last && first !== last) addEdgeUnique(ws, last, first, "returns to");
  return ws;
}

/**
 * MIXED MULTI-REGION workload (Phase 0): ADR 0014's real shape — one board,
 * several kind-regions packed as a band, plus ungrouped board flow. A
 * mind-map region (40%), a decision-tree region (30%), and a plain layered
 * chain above them (30%), with one cross-region edge so the cohesion metric
 * has a cross set. Regions carry their own kinds; the board stays flowchart.
 */
export function mixedRegionBoard(n: number, _seed = 1): Workspace {
  const ws = createWorkspace({
    id: "bench-mixed",
    name: `Mixed regions ${n}`,
    diagramKind: "flowchart",
  });
  const nMind = Math.min(Math.max(6, Math.round(n * 0.4)), n - 9);
  const nTree = Math.min(Math.max(6, Math.round(n * 0.3)), n - nMind - 3);
  let count = 0;

  // Mind-map region: a topic, branches fanning off it, short leaf chains.
  const mindChildren: string[] = [];
  const topic = addNode(ws, count++, "topic");
  topic.groupId = "region-mind";
  mindChildren.push(topic.id);
  let branches = 0;
  let prevLeaf: string | null = null;
  while (count < nMind) {
    const isBranch = branches < Math.ceil((nMind - 1) / 3);
    const node = addNode(ws, count++, isBranch ? "branch" : "idea");
    node.groupId = "region-mind";
    mindChildren.push(node.id);
    if (isBranch) {
      addEdgeUnique(ws, topic.id, node.id, "spans");
      branches++;
      prevLeaf = node.id;
    } else if (prevLeaf) {
      addEdgeUnique(ws, prevLeaf, node.id, "supports");
      prevLeaf = node.id;
    }
  }
  ws.groups["region-mind"] = {
    id: "region-mind",
    label: "Ideas",
    children: mindChildren,
    kind: "mindmap",
  };

  // Decision-tree region: a ternary tree.
  const treeStart = count;
  const treeChildren: string[] = [];
  while (count < treeStart + nTree) {
    const i = count - treeStart;
    const node = addNode(ws, count, i === 0 ? "root" : "choice");
    count++;
    node.groupId = "region-tree";
    treeChildren.push(node.id);
    if (i > 0) {
      const parent = ws.nodes[`${id("n", treeStart + Math.floor((i - 1) / 3))}`]!;
      addEdgeUnique(ws, parent.id, node.id, "leads to");
    }
  }
  ws.groups["region-tree"] = {
    id: "region-tree",
    label: "Decisions",
    children: treeChildren,
    kind: "decisiontree",
  };

  // Board flow above the region strip: an ungrouped layered chain, with one
  // edge feeding the mind-map topic (the cohesion metric's cross set).
  let flowPrev: string | null = null;
  while (count < n) {
    const node = addNode(ws, count, "step");
    count++;
    if (flowPrev) addEdgeUnique(ws, flowPrev, node.id, "then");
    flowPrev = node.id;
  }
  if (flowPrev) addEdgeUnique(ws, flowPrev, topic.id, "feeds");
  return ws;
}

/** The benchmark's board vocabulary, keyed by what the live pass ran. */
export const BOARD_FACTORIES: readonly BoardFactory[] = [
  { kind: "flowchart", label: "layered (flowchart/architecture)", build: layeredBoard },
  { kind: "flowchart", label: "dense (architecture, fan-in 2-3)", build: denseBoard },
  { kind: "flowchart", label: "adversarial (diamonds+fan-in+cycles)", build: adversarialBoard },
  { kind: "flowchart", label: "long-edge (deep spine, 1/4-3/4 skips)", build: longEdgeBoard },
  { kind: "flowchart", label: "mixed regions (mind+tree+flow)", build: mixedRegionBoard },
  { kind: "mindmap", label: "radial (mind map)", build: radialBoard },
  { kind: "decisiontree", label: "tree (decision tree/org chart)", build: treeBoard },
  { kind: "process", label: "swimlane (process map)", build: swimlaneBoard },
];
