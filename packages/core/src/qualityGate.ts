import type { Workspace } from "./model.js";
import { applyOperations } from "./reducer.js";
import type { ExpectedTopology, SemanticPlan } from "./plan.js";
import type { Operation } from "./operations.js";

export type QualityOutcome = "PASS" | "REPAIRABLE" | "UNRESOLVED";

export interface QualityViolation {
  code:
    | "DISCONNECTED_FLOW"
    | "CYCLE_IN_HIERARCHY"
    | "CYCLE_IN_DAG"
    | "MULTIPLE_ROOTS"
    | "ISOLATED_IN_NETWORK"
    | "UNRESOLVED_REFERENCE";
  message: string;
  nodeIds: string[];
}

export interface QualityReport {
  outcome: QualityOutcome;
  topology: ExpectedTopology;
  violations: QualityViolation[];
  missingConnections: string[];
  details: string;
}

/**
 * Topology-Aware Graph Quality Gate.
 *
 * Verifies that the compiled operations satisfy the structural invariants
 * of the intended representation. Distinguishes legitimate disconnected ideation
 * (independent_clusters) from broken flows or isolated network components.
 */
export function evaluateTopologyQuality(
  workspace: Workspace,
  plan: SemanticPlan,
  compiledOps: Operation[],
  isSecondPass = false,
): QualityReport {
  const topology = plan.intent.expectedTopology;

  // Simulate prospective workspace state
  const projected = applyOperations(workspace, compiledOps);
  const createdNodeIds = compiledOps
    .filter((op): op is Extract<Operation, { op: "CREATE_NODE" }> => op.op === "CREATE_NODE")
    .map((op) => op.id);

  const violations: QualityViolation[] = [];
  const missingConnections: string[] = [];

  // 1. Independent Clusters / Brainstorming: 0-degree nodes are completely valid
  if (topology === "independent_clusters") {
    return {
      outcome: "PASS",
      topology,
      violations: [],
      missingConnections: [],
      details: "Independent cluster topology valid: floating nodes are permitted.",
    };
  }

  // 2. Directed Flow (flowcharts, process maps, journeys)
  if (topology === "directed_flow") {
    // Only verify connectivity if batch created >= 2 nodes or extends an existing diagram
    if (
      createdNodeIds.length >= 2 ||
      (createdNodeIds.length === 1 && Object.keys(workspace.nodes).length > 0)
    ) {
      for (const id of createdNodeIds) {
        const inDeg = Object.values(projected.edges).filter((e) => e.target === id).length;
        const outDeg = Object.values(projected.edges).filter((e) => e.source === id).length;
        if (inDeg === 0 && outDeg === 0) {
          const label = projected.nodes[id]?.label ?? id;
          missingConnections.push(label);
          violations.push({
            code: "DISCONNECTED_FLOW",
            message: `Node "${label}" is completely disconnected in a directed flow.`,
            nodeIds: [id],
          });
        }
      }
    }

    // Cycles: Real workflows can contain intentional retry/approval loops.
    // Reject cycles only when the flow semantics explicitly require an acyclic graph (strictAcyclic = true).
    if (plan.intent.strictAcyclic) {
      const cycles = detectDirectedCycles(projected, createdNodeIds);
      if (cycles.length > 0) {
        for (const cycle of cycles) {
          const cycleLabels = cycle.map((id) => projected.nodes[id]?.label ?? id).join(" -> ");
          violations.push({
            code: "CYCLE_IN_DAG",
            message: `Cycle detected in strict acyclic flow: ${cycleLabels}`,
            nodeIds: cycle,
          });
        }
      }
    }
  }

  // 3. Tree Hierarchy (mind maps, org charts, decision trees): must be acyclic
  if (topology === "tree_hierarchy") {
    const cycles = detectDirectedCycles(projected, createdNodeIds);
    if (cycles.length > 0) {
      for (const cycle of cycles) {
        const cycleLabels = cycle.map((id) => projected.nodes[id]?.label ?? id).join(" -> ");
        violations.push({
          code: "CYCLE_IN_HIERARCHY",
          message: `Cycle detected in hierarchy: ${cycleLabels}`,
          nodeIds: cycle,
        });
      }
    }

    // Explicit single-root vs forest calibration:
    // If hierarchyStructure is 'single_root' (and >=2 nodes created on empty canvas), verify exactly one root
    if (
      plan.intent.hierarchyStructure === "single_root" &&
      createdNodeIds.length >= 2 &&
      Object.keys(workspace.nodes).length === 0
    ) {
      const roots = createdNodeIds.filter((id) => {
        const inDeg = Object.values(projected.edges).filter((e) => e.target === id).length;
        return inDeg === 0;
      });
      if (roots.length > 1) {
        const rootLabels = roots.map((id) => projected.nodes[id]?.label ?? id);
        violations.push({
          code: "MULTIPLE_ROOTS",
          message: `Multiple root nodes found in single-root hierarchy: ${rootLabels.join(", ")}`,
          nodeIds: roots,
        });
      }
    }
  }

  // 4. Relational Network (architectures, ERDs): checks for isolated subsystems
  if (topology === "relational_network" && createdNodeIds.length >= 2) {
    const standaloneRefs = new Set(
      plan.nodes
        .filter((n) => n.standalone || n.role === "note" || n.role === "legend")
        .map((n) => n.ref),
    );

    for (const id of createdNodeIds) {
      // Find plan node if available
      const planNode = plan.nodes.find(
        (n) => n.label === projected.nodes[id]?.label || n.ref === id,
      );
      const isStandaloneAllowed =
        plan.intent.allowStandalone === true ||
        (planNode && (planNode.standalone || standaloneRefs.has(planNode.ref)));

      if (isStandaloneAllowed) continue;

      const connectedEdges = Object.values(projected.edges).filter(
        (e) => e.source === id || e.target === id,
      );
      if (connectedEdges.length === 0) {
        const label = projected.nodes[id]?.label ?? id;
        missingConnections.push(label);
        violations.push({
          code: "ISOLATED_IN_NETWORK",
          message: `Service/Entity "${label}" has no inbound or outbound relationships.`,
          nodeIds: [id],
        });
      }
    }
  }

  const passed = violations.length === 0;
  if (passed) {
    return {
      outcome: "PASS",
      topology,
      violations: [],
      missingConnections: [],
      details: "Graph satisfies target topology invariants.",
    };
  }

  if (!isSecondPass) {
    return {
      outcome: "REPAIRABLE",
      topology,
      violations,
      missingConnections,
      details: `Topology violations detected. Requesting bounded repair for: ${missingConnections.join(", ")}`,
    };
  }

  return {
    outcome: "UNRESOLVED",
    topology,
    violations,
    missingConnections,
    details: `Secondary repair failed. Topology violations remain: ${missingConnections.join(", ")}`,
  };
}

/**
 * Detect directed cycles in a workspace graph among specified nodes.
 */
function detectDirectedCycles(workspace: Workspace, focusIds: string[]): string[][] {
  const adj = new Map<string, string[]>();
  for (const id of Object.keys(workspace.nodes)) adj.set(id, []);
  for (const e of Object.values(workspace.edges)) {
    adj.get(e.source)?.push(e.target);
  }

  const cycles: string[][] = [];
  const visited = new Set<string>();
  const inStack = new Set<string>();

  function dfs(curr: string, path: string[]) {
    visited.add(curr);
    inStack.add(curr);
    path.push(curr);

    for (const neighbor of adj.get(curr) ?? []) {
      if (!visited.has(neighbor)) {
        dfs(neighbor, [...path]);
      } else if (inStack.has(neighbor)) {
        // Cycle found
        const cycleStartIndex = path.indexOf(neighbor);
        if (cycleStartIndex !== -1) {
          cycles.push([...path.slice(cycleStartIndex), neighbor]);
        }
      }
    }

    inStack.delete(curr);
  }

  for (const id of focusIds) {
    if (!visited.has(id)) dfs(id, []);
  }

  return cycles;
}
