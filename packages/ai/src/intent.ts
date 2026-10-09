import type { DiagramIntent, ExpectedTopology, MutationScope, Workspace } from "@lucent/core";

/**
 * Deterministic Intent Classifier Fast-Path.
 *
 * For unambiguous prompts, resolves the intent without an extra model round-trip.
 * Returns null if the request requires LLM reasoning.
 */
export function classifyIntentFastPath(prompt: string, workspace: Workspace): DiagramIntent | null {
  const p = prompt.toLowerCase().trim();
  const nodeCount = Object.keys(workspace.nodes).length;
  const isCanvasEmpty = nodeCount === 0;

  let targetKind: DiagramIntent["targetKind"] | null = null;
  let expectedTopology: ExpectedTopology | null = null;

  // 1. Explicit diagram kind keywords
  if (
    /\b(flowchart|flow chart|process flow|step-by-step|workflow|user journey|service flow|data flow|user flow|flow)\b/i.test(
      p,
    )
  ) {
    targetKind = "flowchart";
    expectedTopology = "directed_flow";
  } else if (
    /\b(architecture|system architecture|microservices?|backend architecture|cloud infrastructure)\b/i.test(
      p,
    )
  ) {
    targetKind = "architecture";
    expectedTopology = "relational_network";
  } else if (
    /\b(mind\s*map|mindmap|concept map|org chart|organization chart|hierarchy)\b/i.test(p)
  ) {
    targetKind = "mindmap";
    expectedTopology = "tree_hierarchy";
  } else if (/\b(er diagram|erd|database schema|relational model|tables and entities)\b/i.test(p)) {
    targetKind = "er";
    expectedTopology = "relational_network";
  } else if (/\b(matrix|comparison table|feature matrix|comparison matrix)\b/i.test(p)) {
    targetKind = "matrix";
    expectedTopology = "independent_clusters";
  } else if (/\b(decision tree|decision-tree)\b/i.test(p)) {
    targetKind = "decisiontree";
    expectedTopology = "tree_hierarchy";
  } else if (/\b(sequence diagram|sequence flow)\b/i.test(p)) {
    targetKind = "sequence";
    expectedTopology = "directed_flow";
  } else if (/\b(timeline|roadmap|chronological)\b/i.test(p)) {
    targetKind = "timeline";
    expectedTopology = "directed_flow";
  } else if (
    /\b(brainstorm|ideas|sticky notes|stickies|discuss|thoughts|feedback items)\b/i.test(p)
  ) {
    targetKind = "flowchart";
    expectedTopology = "independent_clusters";
  }

  // 2. Empty board domain heuristics (when kind not explicitly mentioned)
  if (!targetKind && isCanvasEmpty) {
    if (/\b(backend|database|api|service|cluster|gateway|serverless|s3|redis|kafka)\b/i.test(p)) {
      targetKind = "architecture";
      expectedTopology = "relational_network";
    } else if (/\b(how it works|steps|procedure|onboarding|checkout|funnel)\b/i.test(p)) {
      targetKind = "flowchart";
      expectedTopology = "directed_flow";
    } else if (/\b(topics|explore|brainstorm|notes)\b/i.test(p)) {
      targetKind = "flowchart";
      expectedTopology = "independent_clusters";
    }
  }

  // If still undetermined, leave to model
  if (!targetKind || !expectedTopology) {
    if (!isCanvasEmpty) {
      // On existing boards, preserve current kind by default unless prompt shifts it
      targetKind = workspace.diagramKind;
      expectedTopology =
        targetKind === "flowchart"
          ? "directed_flow"
          : targetKind === "mindmap"
            ? "tree_hierarchy"
            : targetKind === "architecture" || targetKind === "er"
              ? "relational_network"
              : "independent_clusters";
    } else {
      return null;
    }
  }

  // Determine mutation scope
  let mutationScope: MutationScope = "new_canvas";
  if (!isCanvasEmpty) {
    if (/\b(reorganize|clean up|align|restructure|tidy)\b/i.test(p)) {
      mutationScope = "reorganize_only";
    } else if (/\b(replace|redesign|start over|clear|new board)\b/i.test(p)) {
      mutationScope = "new_canvas";
    } else {
      mutationScope = "extend_region";
    }
  }

  return {
    userObjective: prompt.slice(0, 120),
    targetKind,
    expectedTopology,
    mutationScope,
    focusNodeIds: [],
  };
}

/**
 * Tool Parameters Schema for single-turn structured model generation.
 * Generates both the DiagramIntent and the Intermediate SemanticPlan together.
 */
export function planToolSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      intent: {
        type: "object",
        description: "Classification of diagram objective, target representation, and topology",
        properties: {
          userObjective: { type: "string" },
          targetKind: {
            type: "string",
            enum: [
              "flowchart",
              "architecture",
              "mindmap",
              "sequence",
              "er",
              "neutral",
              "state-machine",
              "timeline",
              "matrix",
              "user-journey",
              "c4-context",
            ],
          },
          expectedTopology: {
            type: "string",
            enum: ["directed_flow", "tree_hierarchy", "relational_network", "independent_clusters"],
          },
          mutationScope: {
            type: "string",
            enum: ["new_canvas", "extend_region", "refine_selection", "reorganize_only"],
          },
        },
        required: ["userObjective", "targetKind", "expectedTopology", "mutationScope"],
      },
      nodes: {
        type: "array",
        description: "List of semantic nodes with symbolic references (n1, n2, ...)",
        items: {
          type: "object",
          properties: {
            ref: { type: "string", description: "Temporary symbolic ID (e.g. n1, n2)" },
            label: { type: "string", description: "Node label text" },
            role: {
              type: "string",
              description: "Semantic role (e.g. service, database, step, note)",
            },
            existingNodeId: {
              type: "string",
              description: "ID of an existing canvas node if referencing one",
            },
          },
          required: ["ref", "label"],
        },
      },
      edges: {
        type: "array",
        description: "Directed relationships connecting symbolic nodes",
        items: {
          type: "object",
          properties: {
            from: { type: "string", description: "Source symbolic ref or existing node ID" },
            to: { type: "string", description: "Target symbolic ref or existing node ID" },
            relation: {
              type: "string",
              enum: [
                "calls",
                "reads_writes",
                "produces",
                "consumes",
                "contains",
                "depends_on",
                "next",
                "relates_to",
              ],
            },
            label: { type: "string" },
          },
          required: ["from", "to"],
        },
      },
      groups: {
        type: "array",
        description: "Subsystem or thematic groupings",
        items: {
          type: "object",
          properties: {
            ref: { type: "string" },
            label: { type: "string" },
            memberRefs: { type: "array", items: { type: "string" } },
          },
          required: ["ref", "label", "memberRefs"],
        },
      },
      explanation: {
        type: "string",
        description: "Conversational summary of what was constructed",
      },
    },
    required: ["intent", "nodes", "edges"],
  };
}
