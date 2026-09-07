import * as z from "zod/v4";
import type { JsonSchema } from "@lucent/core";
import type { TokenUsage } from "./provider.js";

/**
 * The external-plan call type (Stage D9, ADR 0035): the third thing a
 * provider can be asked to do, next to generating operations and answering.
 *
 * THE NARROWING CONTRACT: the model is a SELECTOR, never an author. It
 * receives the board's executable actions as candidate ids and emits a
 * subset plus a rationale. The server builds every external-work item from
 * real board state through the D5 item builder — the model cannot
 * manufacture a node, a title, an assignee, a due date, a status, or a
 * provider; it can only narrow a set the server already computed. Unknown
 * ids are dropped with a visible warning (the citation discipline), and
 * the selection is capped server-side.
 *
 * THE CONTEXT BOUNDARY: the request carries SEMANTIC data only — the board
 * name, the user's request, and per candidate its label/statement/issue
 * fields. NEVER credential refs, API keys, external ids, urls, webhook
 * secrets, or any connection internals: the provider connection is
 * resolved and used server-side AFTER the selection, so the model has
 * nothing it could leak and nothing it needs. Pinned by test.
 *
 * UNTRUSTED BOARD CONTENT: node labels, descriptions, and any board text
 * are data, not instructions. The prompt states the clause verbatim (the
 * registry file), and the narrow output schema is the structural defence:
 * even a fully-injected model can only return ids the server will
 * intersect against real candidates anyway.
 */

export const EXTERNAL_PLAN_TOOL_NAME = "propose_external_sync";

export const EXTERNAL_PLAN_TOOL_DESCRIPTION =
  "Select which of a Lucent board's executable actions should be proposed for external sync. " +
  "You are a selector, never an author: return a subset of the candidate node ids exactly as " +
  "shown, plus a short rationale. Never invent ids, never modify fields — the server builds " +
  "every work item from the board's own state. A human reviews and approves the proposal; " +
  "nothing is sent to the external system until they do.";

/**
 * The hard server-side selection cap (D5's batch shape). The route rejects
 * a larger selection with the honest 422 — never a silent truncate; the
 * model's choice is never silently reinterpreted. Pinned by test.
 */
export const MAX_AI_SELECTED_ACTIONS = 10;

/** One executable action the model may select — semantic fields only. */
export interface ExternalPlanCandidate {
  /** The node id, exactly as the server computed it from real state. */
  nodeId: string;
  label: string;
  /** The statement's kind/topic when the node carries one. */
  statementKind?: string;
  statementTopic?: string;
  /** The issue fields the D5 item builder would carry. */
  status?: string;
  assignee?: string;
  dueDate?: string;
}

export interface ExternalPlanRequest {
  /** The user's natural-language request ("send the launch-critical ones"). */
  request: string;
  boardName: string;
  /** The target provider's DISPLAY name (e.g. "Linear") — no internals. */
  providerName: string;
  /** The server-computed candidate set (the narrowing upper bound). */
  candidates: ExternalPlanCandidate[];
  /** How many candidates exist in total, when capped for context. */
  totalCandidates: number;
}

/** What the model itself sends; the model/usage fields come from the envelope. */
export interface ExternalPlanResult {
  /** The selected node ids — the server intersects these with the candidates. */
  nodeIds: string[];
  /**
   * The model's rationale, ONE paragraph. Rendered as "Lucent's rationale" —
   * a recommendation, never board truth (the C2/C5 doctrine: AI
   * interpretation is not automatically semantic state).
   */
  explanation: string;
  model?: string;
  usage?: TokenUsage;
}

/** What a model sends back; the strict tool-arguments shape. */
const externalPlanArgsSchema = z.object({
  nodeIds: z
    .array(z.string().min(1).max(200))
    .max(50)
    .describe(
      "The candidate node ids to propose for external sync, exactly as shown. " +
        "A subset of the candidates — never invented ids, never duplicates.",
    ),
  explanation: z
    .string()
    .min(1)
    .max(2000)
    .describe(
      "One short paragraph on why these actions — the rationale the human reads. " +
        "A recommendation, not a factual claim about the board.",
    ),
});

/** Exported for the provider parsers and the route's own assertions. */
export const externalPlanArgumentsSchema = externalPlanArgsSchema;

/** JSON Schema for the tool's arguments, derived from the Zod schema. */
export function externalPlanToolParametersJsonSchema(): JsonSchema {
  const schema = z.toJSONSchema(externalPlanArgsSchema, {
    io: "input",
    target: "draft-2020-12",
  }) as JsonSchema;
  delete schema.$schema;
  return schema;
}

/** Vendor-neutral descriptor; providers adapt it to their wire format. */
export function externalPlanToolDefinition(): {
  name: string;
  description: string;
  parameters: JsonSchema;
} {
  return {
    name: EXTERNAL_PLAN_TOOL_NAME,
    description: EXTERNAL_PLAN_TOOL_DESCRIPTION,
    parameters: externalPlanToolParametersJsonSchema(),
  };
}

/** OpenAI / OpenAI-compatible `tools` entry. */
export function openAiExternalPlanToolDefinition(): {
  type: "function";
  function: { name: string; description: string; parameters: JsonSchema };
} {
  const t = externalPlanToolDefinition();
  return {
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  };
}

/** Anthropic `tools` entry. */
export function anthropicExternalPlanToolDefinition(): {
  name: string;
  description: string;
  input_schema: JsonSchema;
} {
  const t = externalPlanToolDefinition();
  return { name: t.name, description: t.description, input_schema: t.parameters };
}
