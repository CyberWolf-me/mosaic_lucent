import * as z from "zod/v4";
import { AI_FORBIDDEN_OPS, AI_OPERATION_NAMES, operationUnionSchema } from "./operations.js";

/**
 * Provider tool definition derived from the Zod operation schema.
 *
 * The operation contract lives in exactly one place (operations.ts). Everything
 * a model is told about it is generated from that union here, so the advertised
 * operation list can never drift from what the validator accepts — the drift
 * that previously left eight shape operations invisible to the model.
 *
 * MOVE_NODE is filtered out: it is the one coordinate-bearing operation and is
 * reserved for direct human manipulation (docs/03 — the layout engine owns
 * positions, the AI never sets them).
 */

/** A JSON Schema object, loose enough to hand to any provider SDK. */
export type JsonSchema = Record<string, unknown>;

export const TOOL_NAME = "apply_canvas_operations";

export const TOOL_DESCRIPTION =
  "Apply a batch of structured operations to the Lucent canvas. This is the only " +
  "way to change the board: emit operations describing the intended semantic " +
  "change and the application validates and executes them. Never include " +
  "coordinates for nodes — a layout engine positions them. When the user is " +
  "asking a question about the board rather than requesting a change, call this " +
  "tool with an empty operations array and put the answer in `explanation`.";

/**
 * The union of AI-permitted operations. Built by filtering the single source of
 * truth, so it stays in step automatically.
 */
function aiOperationVariants() {
  const forbidden = AI_FORBIDDEN_OPS as readonly string[];
  return operationUnionSchema.options.filter(
    (variant) => !forbidden.includes(variant.shape.op.value as string),
  );
}

/**
 * JSON Schema for a single AI-permitted operation.
 *
 * `io: "input"` matters: it describes what the model should *send*, so fields
 * with defaults (e.g. wireframe `viewport`) are optional rather than required.
 */
export function operationJsonSchema(): JsonSchema {
  const variants = aiOperationVariants();
  const union = z.union(variants as unknown as [z.ZodTypeAny, z.ZodTypeAny]);
  const schema = z.toJSONSchema(union, {
    io: "input",
    target: "draft-2020-12",
  }) as JsonSchema;
  // The provider embeds this inside a larger schema; a nested $schema key is
  // noise at best and rejected by some gateways.
  delete schema.$schema;
  return schema;
}

/** JSON Schema for the tool's full argument object. */
export function toolParametersJsonSchema(): JsonSchema {
  return {
    type: "object",
    properties: {
      operations: {
        type: "array",
        description:
          `Operations to apply, in dependency order (create a node before connecting it, ` +
          `create a group before assigning nodes to it). Permitted operations: ` +
          `${AI_OPERATION_NAMES.join(", ")}. Empty when answering a question. ` +
          `Completeness beats polish: emit ALL the CONNECT_NODES the described ` +
          `system implies, even if it means shorter labels — a diagram missing ` +
          `its relationships is wrong, a diagram with terse labels is fine.`,
        items: operationJsonSchema(),
      },
      explanation: {
        type: "string",
        description:
          "One or two sentences describing what changed, or the full answer when " +
          "the user asked a question and `operations` is empty.",
      },
    },
    required: ["operations"],
    additionalProperties: false,
  };
}

/** Vendor-neutral tool descriptor; providers adapt it to their own wire format. */
export interface CanvasToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export function canvasToolDefinition(): CanvasToolDefinition {
  return {
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: toolParametersJsonSchema(),
  };
}

/** OpenAI / OpenAI-compatible `tools` entry. */
export function openAiToolDefinition(): {
  type: "function";
  function: { name: string; description: string; parameters: JsonSchema };
} {
  const t = canvasToolDefinition();
  return {
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  };
}

/** Anthropic `tools` entry (same schema, different key name). */
export function anthropicToolDefinition(): {
  name: string;
  description: string;
  input_schema: JsonSchema;
} {
  const t = canvasToolDefinition();
  return { name: t.name, description: t.description, input_schema: t.parameters };
}
