import type { DiagramKind, Node, Workspace } from "@lucent/core";

/**
 * Presentation mapping from the semantic model to the reference visual language.
 * The prototype baked meta labels and dot colors into mock nodes; here we derive
 * them from the semantic `nodeType`, so the AI only needs to emit meaning.
 */

export type DotColor = "blue" | "green" | "red" | "amber" | "violet" | "";

interface NodeStyle {
  meta: string;
  dot: DotColor;
}

const TYPE_STYLE: Record<string, NodeStyle> = {
  actor: { meta: "ACTOR", dot: "blue" },
  screen: { meta: "SCREEN", dot: "violet" },
  service: { meta: "SERVICE", dot: "violet" },
  external: { meta: "EXTERNAL", dot: "amber" },
  system: { meta: "SYSTEM", dot: "green" },
  database: { meta: "DATABASE", dot: "blue" },
  cache: { meta: "CACHE", dot: "red" },
  queue: { meta: "QUEUE", dot: "amber" },
  decision: { meta: "DECISION", dot: "amber" },
  note: { meta: "NOTE", dot: "" },
  idea: { meta: "IDEA", dot: "violet" },
  step: { meta: "STEP", dot: "blue" },
  // Decision-tree, process-map, and org-chart vocabulary.
  condition: { meta: "CONDITION", dot: "amber" },
  outcome: { meta: "OUTCOME", dot: "green" },
  start: { meta: "START", dot: "green" },
  end: { meta: "END", dot: "red" },
  process: { meta: "PROCESS", dot: "blue" },
  task: { meta: "TASK", dot: "blue" },
  role: { meta: "ROLE", dot: "violet" },
  person: { meta: "PERSON", dot: "blue" },
  team: { meta: "TEAM", dot: "violet" },
  department: { meta: "DEPARTMENT", dot: "green" },
};

export function styleForType(nodeType: string): NodeStyle {
  return TYPE_STYLE[nodeType.toLowerCase()] ?? { meta: nodeType.toUpperCase(), dot: "" };
}

export interface PlacedNode extends Node {
  meta: string;
  dot: DotColor;
  cx: number;
  cy: number;
  w: number;
  h: number;
}

export interface PlacedEdge {
  id: string;
  source: string;
  target: string;
  relationship: string;
  dir: "h" | "v";
  /** Which face of the source the line leaves from. */
  fromSide: Side;
  /** Which face of the target the line enters. */
  toSide: Side;
  /** Fan-out index among edges sharing this node pair (0 = centre line). */
  parallelIndex: number;
  /**
   * Derived bend points (Edge.route), canvas coordinates, source→target
   * order. Empty for route-less edges — the renderer's straight/bezier path.
   */
  route: Array<{ x: number; y: number }>;
}

export type Side = "l" | "r" | "t" | "b";

/**
 * Pick the pair of faces that actually face each other. The old rule only asked
 * which delta was larger and then always left the bottom/right and entered the
 * top/left, so any edge pointing up or left exited the wrong side of the card
 * and cut back across it.
 */
function facesFor(
  a: { cx: number; cy: number },
  b: { cx: number; cy: number },
): { dir: "h" | "v"; fromSide: Side; toSide: Side } {
  const dx = b.cx - a.cx;
  const dy = b.cy - a.cy;
  if (Math.abs(dy) > Math.abs(dx)) {
    return dy >= 0
      ? { dir: "v", fromSide: "b", toSide: "t" }
      : { dir: "v", fromSide: "t", toSide: "b" };
  }
  return dx >= 0
    ? { dir: "h", fromSide: "r", toSide: "l" }
    : { dir: "h", fromSide: "l", toSide: "r" };
}

/** Combine the laid-out workspace into render-ready nodes + edges. */
export function toScene(workspace: Workspace): {
  nodes: PlacedNode[];
  edges: PlacedEdge[];
} {
  const nodes: PlacedNode[] = Object.values(workspace.nodes).map((n) => {
    const style = styleForType(n.nodeType);
    const w = n.size?.width ?? 160;
    const h = n.size?.height ?? 64;
    const x = n.position?.x ?? 0;
    const y = n.position?.y ?? 0;
    return { ...n, meta: style.meta, dot: style.dot, w, h, cx: x + w / 2, cy: y + h / 2 };
  });

  const byId = new Map(nodes.map((n) => [n.id, n]));
  // Count edges per unordered node pair so parallel relationships can fan out
  // instead of stacking exactly on top of each other.
  const seenPairs = new Map<string, number>();

  const edges: PlacedEdge[] = Object.values(workspace.edges).map((e) => {
    const a = byId.get(e.source);
    const b = byId.get(e.target);
    const faces =
      a && b ? facesFor(a, b) : { dir: "h" as const, fromSide: "r" as Side, toSide: "l" as Side };
    const pairKey = [e.source, e.target].sort().join("\u0000");
    const parallelIndex = seenPairs.get(pairKey) ?? 0;
    seenPairs.set(pairKey, parallelIndex + 1);
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      relationship: e.relationship,
      dir: faces.dir,
      fromSide: faces.fromSide,
      toSide: faces.toSide,
      parallelIndex,
      route: e.route ?? [],
    };
  });

  return { nodes, edges };
}

export const DIAGRAM_LABELS: Record<DiagramKind, string> = {
  flowchart: "Flowchart",
  architecture: "Architecture",
  mindmap: "Mind map",
  journey: "User journey",
  decisiontree: "Decision tree",
  process: "Process map",
  orgchart: "Org chart",
};
