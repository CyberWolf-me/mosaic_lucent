import { safeParseOperations } from "@lucent/core";
import type { GenerateResult, TokenUsage } from "../provider.js";

/**
 * Shared handling of a model's tool-call arguments.
 *
 * Providers now request a tool call whose arguments are validated against the
 * generated JSON Schema, so the payload arrives as structured JSON rather than
 * prose. This module converts those arguments into a GenerateResult and keeps a
 * tolerant text fallback for gateways that ignore tool definitions.
 */

interface ToolArgs {
  operations?: unknown;
  explanation?: unknown;
}

/**
 * What the response envelope said about the completion itself, as opposed to
 * what the model asked for. Threaded through the parsers because the two arrive
 * in one response but are read apart: each provider owns its vendor-specific
 * field names, this module owns the GenerateResult they both produce.
 */
export interface CompletionMeta {
  model?: string;
  usage?: TokenUsage;
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Normalise a provider's raw model/usage fields into a CompletionMeta, keeping
 * only the keys that actually arrived. A gateway that reports one count, or
 * none, contributes what it has rather than a zero the meter would bill on.
 */
export function completionMeta(
  model: unknown,
  inputTokens: unknown,
  outputTokens: unknown,
): CompletionMeta {
  const input = tokenCount(inputTokens);
  const output = tokenCount(outputTokens);
  const usage: TokenUsage = {
    ...(input !== undefined ? { inputTokens: input } : {}),
    ...(output !== undefined ? { outputTokens: output } : {}),
  };
  return {
    ...(typeof model === "string" && model ? { model } : {}),
    ...(Object.keys(usage).length ? { usage } : {}),
  };
}

function toResult(parsed: ToolArgs, source: string, meta?: CompletionMeta): GenerateResult {
  const result = safeParseOperations(parsed.operations ?? []);
  if (!result.success) {
    throw new Error(`Model returned invalid operations (${source}): ${result.error.message}`);
  }
  return {
    operations: result.data,
    ...(typeof parsed.explanation === "string" ? { explanation: parsed.explanation } : {}),
    ...(meta?.model ? { model: meta.model } : {}),
    ...(meta?.usage ? { usage: meta.usage } : {}),
  };
}

/** Parse tool-call arguments, which providers hand back as a JSON string. */
export function parseToolArguments(raw: string | object, meta?: CompletionMeta): GenerateResult {
  let parsed: ToolArgs;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw) as ToolArgs;
    } catch (err) {
      throw new Error(`Tool arguments were not valid JSON: ${(err as Error).message}`);
    }
  } else {
    parsed = raw as ToolArgs;
  }
  return toResult(parsed, "tool call", meta);
}

/**
 * Fallback for a gateway that answered with prose instead of a tool call.
 * Extracts the outermost JSON object. Kept deliberately narrow: it exists so an
 * imperfect gateway degrades instead of failing outright, not as the main path.
 */
export function parseModelJson(text: string, meta?: CompletionMeta): GenerateResult {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("No JSON object found in model response");
  }
  let parsed: ToolArgs;
  try {
    parsed = JSON.parse(text.slice(start, end + 1)) as ToolArgs;
  } catch (err) {
    throw new Error(`Model response was not valid JSON: ${(err as Error).message}`);
  }
  return toResult(parsed, "text fallback", meta);
}
