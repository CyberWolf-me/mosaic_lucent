import type { Workspace, Node, Edge } from "./model.js";

export interface SemanticContradiction {
  code:
    | "CIRCULAR_DEPENDENCY"
    | "SUPERSEDED_DECISION_DRIVES_ACTION"
    | "ORPHANED_EXECUTION_TASK"
    | "ARCHITECTURAL_LAYER_VIOLATION";
  severity: "error" | "warning";
  message: string;
  nodeIds?: string[];
  edgeIds?: string[];
}

/**
 * Semantic Architecture Linter.
 * Analyzes the semantic model of a workspace to identify architectural anti-patterns,
 * contradiction cycles, superseded decisions driving live work, and orphaned execution tasks.
 */
export function detectSemanticContradictions(workspace: Workspace): SemanticContradiction[] {
  const contradictions: SemanticContradiction[] = [];
  const nodes = workspace.nodes;
  const edges = Object.values(workspace.edges);

  // 1. Check for superseded decisions driving actions
  for (const edge of edges) {
    if (edge.relationship === "drives") {
      const source = nodes[edge.source];
      const target = nodes[edge.target];
      if (source && source.statement?.kind === "decision" && source.statement.status === "superseded") {
        contradictions.push({
          code: "SUPERSEDED_DECISION_DRIVES_ACTION",
          severity: "error",
          message: `Decision "${source.label}" is superseded, but still drives action "${target?.label ?? edge.target}".`,
          nodeIds: [source.id, edge.target],
          edgeIds: [edge.id],
        });
      }
    }
  }

  // 2. Check for circular dependencies (depends_on, blocks, calls)
  const dependencyAdj = new Map<string, Array<{ target: string; edgeId: string }>>();
  for (const edge of edges) {
    if (
      edge.relationship === "depends_on" ||
      edge.relationship === "blocks" ||
      edge.relationship === "calls"
    ) {
      // blocks: source blocks target (target depends on source)
      const from = edge.relationship === "blocks" ? edge.target : edge.source;
      const to = edge.relationship === "blocks" ? edge.source : edge.target;
      if (!dependencyAdj.has(from)) dependencyAdj.set(from, []);
      dependencyAdj.get(from)!.push({ target: to, edgeId: edge.id });
    }
  }

  const visited = new Set<string>();
  const inStack = new Set<string>();
  const stackEdges: string[] = [];
  const stackNodes: string[] = [];
  const detectedCycles = new Set<string>();

  const dfs = (curr: string) => {
    visited.add(curr);
    inStack.add(curr);
    stackNodes.push(curr);

    for (const { target, edgeId } of dependencyAdj.get(curr) ?? []) {
      if (!visited.has(target)) {
        stackEdges.push(edgeId);
        dfs(target);
        stackEdges.pop();
      } else if (inStack.has(target)) {
        // Cycle detected
        const cycleStartIndex = stackNodes.indexOf(target);
        const cycleNodes = stackNodes.slice(cycleStartIndex);
        const cycleKey = [...cycleNodes].sort().join("->");
        if (!detectedCycles.has(cycleKey)) {
          detectedCycles.add(cycleKey);
          const cycleNodeLabels = cycleNodes
            .map((id) => `"${nodes[id]?.label ?? id}"`)
            .join(" → ");
          contradictions.push({
            code: "CIRCULAR_DEPENDENCY",
            severity: "error",
            message: `Circular dependency detected: ${cycleNodeLabels} → "${nodes[target]?.label ?? target}".`,
            nodeIds: cycleNodes,
            edgeIds: [edgeId],
          });
        }
      }
    }

    stackNodes.pop();
    inStack.delete(curr);
  };

  for (const nodeId of Object.keys(nodes)) {
    if (!visited.has(nodeId)) {
      dfs(nodeId);
    }
  }

  // 3. Check for orphaned execution tasks
  const connectedNodeIds = new Set<string>();
  for (const edge of edges) {
    connectedNodeIds.add(edge.source);
    connectedNodeIds.add(edge.target);
  }

  for (const node of Object.values(nodes)) {
    if (node.issue) {
      const isActive =
        node.issue.statusCategory === "in_progress" || node.issue.statusCategory === "todo";
      if (isActive) {
        const isOrphaned =
          !connectedNodeIds.has(node.id) &&
          !node.issue.parentId &&
          !node.statement;
        if (isOrphaned) {
          contradictions.push({
            code: "ORPHANED_EXECUTION_TASK",
            severity: "warning",
            message: `Task "${node.label}" is active (${node.issue.status}) but completely disconnected from architecture or decisions.`,
            nodeIds: [node.id],
          });
        }
      }
    }
  }

  // 4. Architectural layer violations (e.g. database / storage directly calling client / presentation)
  const storageTypes = new Set(["database", "storage", "datastore", "db"]);
  const clientTypes = new Set(["client", "frontend", "ui", "browser", "mobile"]);

  for (const edge of edges) {
    if (edge.relationship === "calls" || edge.relationship === "depends_on") {
      const source = nodes[edge.source];
      const target = nodes[edge.target];
      if (
        source &&
        target &&
        storageTypes.has(source.nodeType.toLowerCase()) &&
        clientTypes.has(target.nodeType.toLowerCase())
      ) {
        contradictions.push({
          code: "ARCHITECTURAL_LAYER_VIOLATION",
          severity: "error",
          message: `Architectural layer violation: data tier "${source.label}" cannot directly ${edge.relationship} presentation tier "${target.label}".`,
          nodeIds: [source.id, target.id],
          edgeIds: [edge.id],
        });
      }
    }
  }

  return contradictions;
}
