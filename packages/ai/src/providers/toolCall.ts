import {
  type Operation,
  operationsSchema,
  safeParseOperations,
  sanitizeRawOperations,
} from "@lucent/core";
import type { GenerateResult, TokenUsage } from "../provider.js";
import type { AnswerResult } from "../answer.js";
import { answerArgumentsSchema } from "../answer.js";
import type { ExternalPlanResult } from "../externalPlan.js";
import { externalPlanArgumentsSchema } from "../externalPlan.js";

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
  reply?: unknown;
  clarification?: unknown;
  thinking?: unknown;
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
  thinking?: string;
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
  reasoningTokens?: unknown,
  thinking?: unknown,
): CompletionMeta {
  const input = tokenCount(inputTokens);
  const output = tokenCount(outputTokens);
  const reasoning = tokenCount(reasoningTokens);
  const usage: TokenUsage = {
    ...(input !== undefined ? { inputTokens: input } : {}),
    ...(output !== undefined ? { outputTokens: output } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
  };
  return {
    ...(typeof model === "string" && model ? { model } : {}),
    ...(Object.keys(usage).length ? { usage } : {}),
    ...(typeof thinking === "string" && thinking ? { thinking } : {}),
  };
}

function toResult(parsed: ToolArgs, source: string, meta?: CompletionMeta): GenerateResult {
  const sanitized = sanitizeRawOperations(parsed.operations ?? []);
  const result = safeParseOperations(sanitized);
  let operations: Operation[];

  if (result.success) {
    operations = result.data;
  } else {
    // If the full batch failed, filter out invalid operations while salvaging valid ones
    const salvaged: Operation[] = [];
    if (Array.isArray(sanitized)) {
      for (const op of sanitized) {
        const single = operationsSchema.element.safeParse(op);
        if (single.success) salvaged.push(single.data);
      }
    }
    if (salvaged.length > 0) {
      operations = salvaged;
    } else {
      const issues = result.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".") || "item"}: ${i.message}`)
        .join("; ");
      throw new Error(`Model returned invalid operations (${source}): ${issues}`);
    }
  }

  let clarification: import("@lucent/core").ClarificationChoice | undefined;
  if (
    parsed.clarification &&
    typeof parsed.clarification === "object" &&
    "question" in parsed.clarification &&
    "options" in parsed.clarification
  ) {
    const c = parsed.clarification as { question: unknown; options: unknown };
    if (typeof c.question === "string" && Array.isArray(c.options)) {
      const options = c.options.filter(
        (opt): opt is string => typeof opt === "string" && opt.trim().length > 0,
      );
      if (options.length >= 2) {
        clarification = { question: c.question.trim(), options };
      }
    }
  }

  const thinking =
    typeof parsed.thinking === "string" && parsed.thinking.trim()
      ? parsed.thinking.trim()
      : meta?.thinking;

  return {
    operations,
    ...(typeof parsed.explanation === "string" ? { explanation: parsed.explanation } : {}),
    ...(typeof parsed.reply === "string" && parsed.reply.trim()
      ? { reply: parsed.reply.trim() }
      : {}),
    ...(thinking ? { thinking } : {}),
    ...(clarification ? { clarification } : {}),
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
  let thinkText: string | undefined;
  const thinkMatch = text.match(/<think>([\s\S]*?)<\/think>/i);
  if (thinkMatch && thinkMatch[1]) {
    thinkText = thinkMatch[1].trim();
  }
  const clean = text.replace(/<think>[\s\S]*?<\/think>/gi, "");

  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("No JSON object found in model response");
  }
  let parsed: ToolArgs;
  try {
    parsed = JSON.parse(clean.slice(start, end + 1)) as ToolArgs;
  } catch (err) {
    throw new Error(`Model response was not valid JSON: ${(err as Error).message}`);
  }
  const effectiveMeta: CompletionMeta = {
    ...meta,
    ...(thinkText ? { thinking: thinkText } : {}),
  };
  return toResult(parsed, "text fallback", effectiveMeta);
}

/* -------------------------------------------------------------------------- */
/* The answer path (Stage C1)                                                 */
/* -------------------------------------------------------------------------- */

/** Tool-args shape the answer tool sends; structurally validated by the schema. */
interface AnswerArgs {
  answer?: unknown;
  citations?: unknown;
}

function toAnswerResult(parsed: AnswerArgs, source: string, meta?: CompletionMeta): AnswerResult {
  const result = answerArgumentsSchema.safeParse({
    answer: parsed.answer,
    // The schema defaults citations to [], but a raw `undefined` must reach
    // zod as a *missing* key for the default to apply — passing undefined
    // inside an object literal does exactly that.
    ...(parsed.citations !== undefined ? { citations: parsed.citations } : {}),
  });
  if (!result.success) {
    throw new Error(`Model returned an invalid answer (${source}): ${result.error.message}`);
  }
  return {
    answer: result.data.answer,
    citations: result.data.citations,
    ...(meta?.model ? { model: meta.model } : {}),
    ...(meta?.usage ? { usage: meta.usage } : {}),
  };
}

/** Parse the answer tool's call arguments (a JSON string or an object). */
export function parseAnswerToolArguments(
  raw: string | object,
  meta?: CompletionMeta,
): AnswerResult {
  let parsed: AnswerArgs;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw) as AnswerArgs;
    } catch (err) {
      throw new Error(`Tool arguments were not valid JSON: ${(err as Error).message}`);
    }
  } else {
    parsed = raw as AnswerArgs;
  }
  return toAnswerResult(parsed, "tool call", meta);
}

/** Prose fallback for the answer path — same narrow extraction as the build one. */
export function parseAnswerModelJson(text: string, meta?: CompletionMeta): AnswerResult {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("No JSON object found in model response");
  }
  let parsed: AnswerArgs;
  try {
    parsed = JSON.parse(text.slice(start, end + 1)) as AnswerArgs;
  } catch (err) {
    throw new Error(`Model response was not valid JSON: ${(err as Error).message}`);
  }
  return toAnswerResult(parsed, "text fallback", meta);
}

/* -------------------------------------------------------------------------- */
/* The external-plan path (Stage D9)                                          */
/* -------------------------------------------------------------------------- */

/** Tool-args shape the selector tool sends. */
interface ExternalPlanArgs {
  nodeIds?: unknown;
  explanation?: unknown;
}

function toExternalPlanResult(
  parsed: ExternalPlanArgs,
  source: string,
  meta?: CompletionMeta,
): ExternalPlanResult {
  const result = externalPlanArgumentsSchema.safeParse({
    ...(parsed.nodeIds !== undefined ? { nodeIds: parsed.nodeIds } : {}),
    ...(parsed.explanation !== undefined ? { explanation: parsed.explanation } : {}),
  });
  if (!result.success) {
    throw new Error(`Model returned an invalid external plan (${source}): ${result.error.message}`);
  }
  return {
    nodeIds: result.data.nodeIds,
    explanation: result.data.explanation,
    ...(meta?.model ? { model: meta.model } : {}),
    ...(meta?.usage ? { usage: meta.usage } : {}),
  };
}

/** Parse the selector tool's call arguments (a JSON string or an object). */
export function parseExternalPlanToolArguments(
  raw: string | object,
  meta?: CompletionMeta,
): ExternalPlanResult {
  let parsed: ExternalPlanArgs;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw) as ExternalPlanArgs;
    } catch (err) {
      throw new Error(`Tool arguments were not valid JSON: ${(err as Error).message}`);
    }
  } else {
    parsed = raw as ExternalPlanArgs;
  }
  return toExternalPlanResult(parsed, "tool call", meta);
}

/** Prose fallback — the same narrow brace extraction. */
export function parseExternalPlanModelJson(
  text: string,
  meta?: CompletionMeta,
): ExternalPlanResult {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("No JSON object found in model response");
  }
  let parsed: ExternalPlanArgs;
  try {
    parsed = JSON.parse(text.slice(start, end + 1)) as ExternalPlanArgs;
  } catch (err) {
    throw new Error(`Model response was not valid JSON: ${(err as Error).message}`);
  }
  return toExternalPlanResult(parsed, "text fallback", meta);
}
