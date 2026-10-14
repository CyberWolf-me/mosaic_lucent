import type { Workspace, DiagramIntent, SemanticPlan } from "@lucent/core";
import { SemanticPlanSchema } from "@lucent/core";
import { classifyIntentFastPath } from "./intent.js";
import type { LLMProvider } from "./provider.js";
import { parseModelJson } from "./providers/toolCall.js";

/**
 * Generate an intermediate SemanticPlan from user prompt and workspace.
 */
export async function generateSemanticPlan(
  provider: LLMProvider,
  workspace: Workspace,
  prompt: string,
  intentOverride?: DiagramIntent | null,
): Promise<SemanticPlan> {
  const resolvedIntent = intentOverride ?? classifyIntentFastPath(prompt, workspace);

  if (provider.generatePlan) {
    return await provider.generatePlan({
      prompt,
      workspace,
      intent: resolvedIntent,
    });
  }

  // Offline / Mock fallback for tests and offline development
  if (provider.name === "mock" || !("apiKey" in provider)) {
    return generateMockPlan(prompt, workspace, resolvedIntent);
  }

  throw new Error(
    `Provider "${provider.name}" does not support generatePlan and implicit mock fallback is disabled.`,
  );
}

/**
 * Bounded Repair Pass: requests additional edge relationships for disconnected elements.
 */
export async function requestBoundedEdgeRepair(
  provider: LLMProvider,
  workspace: Workspace,
  plan: SemanticPlan,
  missingItemLabels: string[],
): Promise<SemanticPlan> {
  // If mock provider, synthesize the missing links deterministically
  if (provider.name === "mock") {
    const repairedEdges = [...plan.edges];
    const createdNodes = plan.nodes;
    if (createdNodes.length >= 2) {
      for (let i = 0; i < createdNodes.length - 1; i++) {
        const from = createdNodes[i]!.ref;
        const to = createdNodes[i + 1]!.ref;
        const exists = repairedEdges.some((e) => e.from === from && e.to === to);
        if (!exists) {
          repairedEdges.push({
            from,
            to,
            relation: plan.intent.expectedTopology === "directed_flow" ? "next" : "calls",
          });
        }
      }
    }
    return {
      ...plan,
      edges: repairedEdges,
      explanation: `${plan.explanation} (Repaired connectivity for ${missingItemLabels.join(", ")})`,
    };
  }

  // On real providers with generatePlan, request a bounded repair pass with context
  if (provider.generatePlan) {
    try {
      const repaired = await provider.generatePlan({
        prompt: plan.intent.userObjective,
        workspace,
        intent: plan.intent,
        repairContext: {
          rejectedPlan: plan,
          missingItemLabels,
          feedback: `Missing edge relationships for disconnected items: ${missingItemLabels.join(", ")}`,
        },
      });
      return repaired;
    } catch {
      return plan;
    }
  }

  return plan;
}

/**
 * Deterministic Mock Semantic Plan Generator for offline tests and predictable verification.
 */
export function generateMockPlan(
  prompt: string,
  workspace: Workspace,
  intentOverride?: DiagramIntent | null,
): SemanticPlan {
  const intent: DiagramIntent = intentOverride ?? {
    userObjective: prompt,
    targetKind: "architecture",
    expectedTopology: "relational_network",
    mutationScope: Object.keys(workspace.nodes).length === 0 ? "new_canvas" : "extend_region",
    focusNodeIds: [],
  };

  const p = prompt.toLowerCase();

  // Scenario 1: Brainstorming (independent clusters)
  if (
    intent.expectedTopology === "independent_clusters" ||
    p.includes("brainstorm") ||
    p.includes("ideas")
  ) {
    return {
      intent: {
        ...intent,
        expectedTopology: "independent_clusters",
        targetKind: intent.targetKind ?? "flowchart",
      },
      nodes: [
        { ref: "n1", label: "Idea 1: Core Strategy", role: "concept" },
        { ref: "n2", label: "Idea 2: Growth Engine", role: "concept" },
        { ref: "n3", label: "Idea 3: Retention Loops", role: "concept" },
      ],
      edges: [], // Intentionally zero edges
      groups: [],
      explanation: "Generated brainstorming idea cards without edges.",
    };
  }

  // Scenario: Comparison Matrix / Table
  if (
    intent.targetKind === "matrix" ||
    p.includes("matrix") ||
    p.includes("comparison table") ||
    p.includes("feature comparison")
  ) {
    return {
      intent: {
        ...intent,
        targetKind: "matrix",
        expectedTopology: "independent_clusters",
      },
      nodes: [
        { ref: "opt1", label: "Option A: PostgreSQL", role: "option" },
        { ref: "opt2", label: "Option B: MongoDB", role: "option" },
        { ref: "crit1", label: "ACID Compliance", role: "criterion" },
        { ref: "crit2", label: "Horizontal Scaling", role: "criterion" },
      ],
      edges: [
        { from: "opt1", to: "crit1", relation: "relates_to" },
        { from: "opt2", to: "crit2", relation: "relates_to" },
      ],
      groups: [],
      explanation: "Constructed comparison matrix table.",
    };
  }

  // Scenario 2: Flowchart (directed flow)
  if (intent.targetKind === "flowchart" || intent.expectedTopology === "directed_flow") {
    return {
      intent: { ...intent, expectedTopology: "directed_flow", targetKind: "flowchart" },
      nodes: [
        { ref: "n1", label: "Step 1: User Request", role: "step" },
        { ref: "n2", label: "Step 2: Authenticate", role: "step" },
        { ref: "n3", label: "Step 3: Process Order", role: "step" },
      ],
      edges: [
        { from: "n1", to: "n2", relation: "next" },
        { from: "n2", to: "n3", relation: "next" },
      ],
      groups: [],
      explanation: "Constructed sequential flowchart.",
    };
  }

  // Scenario 3: Tree Hierarchy (mind map)
  if (intent.targetKind === "mindmap" || intent.expectedTopology === "tree_hierarchy") {
    return {
      intent: { ...intent, expectedTopology: "tree_hierarchy", targetKind: "mindmap" },
      nodes: [
        { ref: "root", label: "Central Goal", role: "concept" },
        { ref: "b1", label: "Branch 1: Architecture", role: "concept" },
        { ref: "b2", label: "Branch 2: Product", role: "concept" },
      ],
      edges: [
        { from: "root", to: "b1", relation: "contains" },
        { from: "root", to: "b2", relation: "contains" },
      ],
      groups: [],
      explanation: "Constructed hierarchical mind map.",
    };
  }

  // Default: System Architecture (relational network)
  return {
    intent: { ...intent, expectedTopology: "relational_network", targetKind: "architecture" },
    nodes: [
      { ref: "n1", label: "Web Client", role: "client" },
      { ref: "n2", label: "API Gateway", role: "service" },
      { ref: "n3", label: "Database", role: "database" },
    ],
    edges: [
      { from: "n1", to: "n2", relation: "calls" },
      { from: "n2", to: "n3", relation: "reads_writes" },
    ],
    groups: [{ ref: "g1", label: "Backend Core", memberRefs: ["n2", "n3"] }],
    explanation: "Constructed relational system architecture.",
  };
}
