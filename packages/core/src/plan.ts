import { z } from "zod";
import { DIAGRAM_KINDS } from "./model.js";

export const ExpectedTopologySchema = z.enum([
  "directed_flow", // Strict DAG (flowchart, user journey, process map)
  "tree_hierarchy", // Rooted tree or acyclic forest (mind map, org chart, decision tree)
  "relational_network", // Interconnected mesh/graph (system architecture, ERD, network diagram)
  "independent_clusters", // Freeform ideation, brainstorming cards, unlinked item buckets
]);
export type ExpectedTopology = z.infer<typeof ExpectedTopologySchema>;

export const MutationScopeSchema = z.enum([
  "new_canvas", // Greenfield generation on blank or cleared board
  "extend_region", // Adding a subsystem or step to an existing board
  "refine_selection", // Modifying, renaming, or refactoring focused elements
  "reorganize_only", // Structural regrouping without adding semantic entities
]);
export type MutationScope = z.infer<typeof MutationScopeSchema>;

export const DiagramIntentSchema = z.object({
  userObjective: z.string().min(1).describe("Concise statement of the user's architectural goal"),
  targetKind: z.enum(DIAGRAM_KINDS).describe("Target Lucent diagram representation"),
  expectedTopology: ExpectedTopologySchema.describe("Expected structural connectivity rule"),
  mutationScope: MutationScopeSchema.describe("Scope of change relative to current canvas"),
  focusNodeIds: z
    .array(z.string())
    .default([])
    .describe("Existing node IDs relevant to this mutation"),
  allowCycles: z
    .boolean()
    .optional()
    .describe("Whether deliberate loops or retry cycles are permitted"),
  strictAcyclic: z
    .boolean()
    .optional()
    .describe("Strictly disallow cycles even in directed workflows"),
  hierarchyStructure: z
    .enum(["single_root", "forest"])
    .optional()
    .describe("Tree hierarchy expectation"),
  allowStandalone: z
    .boolean()
    .optional()
    .describe("Allow intentional unlinked entities in relational network"),
});
export type DiagramIntent = z.infer<typeof DiagramIntentSchema>;

export const PlanRelationKindSchema = z.enum([
  "calls",
  "reads_writes",
  "produces",
  "consumes",
  "contains",
  "depends_on",
  "next",
  "relates_to",
]);
export type PlanRelationKind = z.infer<typeof PlanRelationKindSchema>;

export const PlanNodeSchema = z.object({
  ref: z.string().min(1).describe("Local temporary symbolic identifier (e.g. n1, n2)"),
  label: z.string().min(1).describe("Human-readable label for the node"),
  role: z
    .string()
    .optional()
    .describe("Semantic role or nodeType (e.g. service, database, client, step)"),
  existingNodeId: z
    .string()
    .optional()
    .describe("If referencing an existing canvas node, its exact ID"),
  standalone: z.boolean().optional().describe("Explicitly marks an intentional standalone entity"),
});
export type PlanNode = z.infer<typeof PlanNodeSchema>;

export const PlanEdgeSchema = z.object({
  from: z.string().min(1).describe("Symbolic ref or existing canvas node ID"),
  to: z.string().min(1).describe("Symbolic ref or existing canvas node ID"),
  relation: PlanRelationKindSchema.default("relates_to").describe("Semantic relationship type"),
  label: z.string().optional().describe("Optional edge text label"),
});
export type PlanEdge = z.infer<typeof PlanEdgeSchema>;

export const PlanGroupSchema = z.object({
  ref: z.string().min(1).describe("Symbolic group ref (e.g. g1)"),
  label: z.string().min(1).describe("Group title"),
  memberRefs: z.array(z.string().min(1)).describe("Symbolic node refs belonging to this group"),
});
export type PlanGroup = z.infer<typeof PlanGroupSchema>;

export const SemanticPlanSchema = z.object({
  intent: DiagramIntentSchema,
  nodes: z.array(PlanNodeSchema),
  edges: z.array(PlanEdgeSchema),
  groups: z.array(PlanGroupSchema).default([]),
  explanation: z
    .string()
    .default("")
    .describe("Brief conversational explanation of the construction"),
});
export type SemanticPlan = z.infer<typeof SemanticPlanSchema>;
