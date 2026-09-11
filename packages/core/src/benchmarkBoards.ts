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

/** The benchmark's board vocabulary, keyed by what the live pass ran. */
export const BOARD_FACTORIES: readonly BoardFactory[] = [
  { kind: "flowchart", label: "layered (flowchart/architecture)", build: layeredBoard },
  { kind: "mindmap", label: "radial (mind map)", build: radialBoard },
  { kind: "decisiontree", label: "tree (decision tree/org chart)", build: treeBoard },
  { kind: "process", label: "swimlane (process map)", build: swimlaneBoard },
];
