import * as z from "zod/v4";
import type { JsonSchema } from "@lucent/core";
import type { ConversationTurn, TokenUsage } from "./provider.js";

/**
 * The answer call type (Stage C1): the second thing a provider can be asked
 * to do, next to generating operations.
 *
 * Build and Ask are two directions over one board. Build turns a request into
 * operations (generateOperations); Ask turns a question into an answer plus
 * citations (generateAnswer). The contracts stay separate on purpose: an
 * answer never mutates the board, so there is no validation/repair pipeline
 * downstream — instead the server checks each citation against real state and
 * drops the ones that do not resolve, exactly as applyValidOperations keeps
 * the valid remainder of a batch (the Stage A partial-application rule). AI
 * output is untrusted input on both paths.
 *
 * The context is structured rather than one opaque string for everything
 * except the board digest: the history window, meeting extracts, and node
 * index are data the harness renders (and the tests assert on), and the
 * offline MockProvider cites real ids from them — a mock that cited made-up
 * ids would be dropped by the very server validation it is supposed to
 * exercise.
 */

export const ANSWER_TOOL_NAME = "answer_with_citations";

export const ANSWER_TOOL_DESCRIPTION =
  "Answer a question about a Lucent board's current state and revision history. " +
  "This is the only way to answer: the answer and its evidence citations arrive " +
  "as structured JSON. Every citation id MUST be one the context actually shows " +
  "(a revision number, a node id, or a meeting id) — never an invented one. " +
  "Asking never modifies the board.";

/** A piece of evidence the answer points at. The server resolves each one. */
export interface AnswerCitation {
  kind: "node" | "meeting" | "revision";
  /**
   * For revisions: the revision number as a string (e.g. "1042"). For nodes
   * and meetings: the id exactly as it appears in the context.
   */
  id: string;
  /** One short clause on why this citation supports the claim. */
  detail?: string;
}

export const answerCitationSchema = z.object({
  kind: z.enum(["node", "meeting", "revision"]),
  id: z
    .string()
    .min(1)
    .max(200)
    .describe("The id as shown in the context: node id, meeting id, or revision number"),
  detail: z.string().max(300).optional(),
});

/** What a model sends back; the model/usage fields come from the envelope. */
export interface AnswerResult {
  answer: string;
  citations: AnswerCitation[];
  model?: string;
  usage?: TokenUsage;
}

/** One visible revision of the op log, as the model may cite it. */
export interface AnswerHistoryEntry {
  seq: number;
  at: number;
  label: string;
  actorName: string;
  actorType: "user" | "ai" | "system";
  opCount: number;
}

/**
 * One classified turn of a meeting extract. Unclassified turns stay in the
 * transcript, where search can find them — Ask surfaces only the statements
 * the meeting pipeline already tagged (decision/action/…).
 */
export interface AnswerMeetingTurn {
  speaker: string;
  at: number;
  kind: string;
  text: string;
}

/** One visible meeting, reduced to its classified turns. */
export interface AnswerMeetingSummary {
  id: string;
  startedAt: number;
  speakers: string[];
  turns: AnswerMeetingTurn[];
}

/**
 * The question plus the board's context projection. The caller (the server's
 * askContext) is responsible for windowing: everything here must already be
 * inside the caller's visible-history entitlement, so the entitlement cannot
 * be bypassed by asking about what the history list refuses to show.
 */
export interface AnswerRequest {
  question: string;
  boardName: string;
  /**
   * Pre-rendered current-state text (nodes, edges, provenance). A separate
   * projection from the Build summary: it includes node `metadata.meeting`
   * provenance, which Build's summary deliberately omits.
   */
  boardDigest: string;
  /** The visible revision window, newest first. */
  history: AnswerHistoryEntry[];
  /** True when older revisions exist beyond the visible window. */
  historyTruncated: boolean;
  /** The plan's visible-revision depth; null when unlimited. */
  historyDepth: number | null;
  /** Visible meetings, newest first. */
  meetings: AnswerMeetingSummary[];
  /** Compact id→label index so the model can cite nodes precisely. */
  nodeIndex: Array<{ id: string; label: string }>;
  /** Recent conversation turns, so follow-up questions resolve. */
  conversation?: ConversationTurn[];
}

/**
 * What the model itself sends. `citations` defaults to empty because a "what
 * does this board show?" answer may legitimately have no evidence to point
 * at beyond the board itself.
 */
const answerArgsSchema = z.object({
  answer: z
    .string()
    .min(1)
    .max(8000)
    .describe("The full answer, a few sentences. It renders in a chat bubble."),
  citations: z
    .array(answerCitationSchema)
    .max(10)
    .describe(
      "Evidence for the claims in the answer. Cite only ids the context shows. " +
        "Prefer the revision where a change happened over describing it vaguely.",
    )
    .default([]),
});

/** Exported for the provider parsers and the route's own assertions. */
export const answerArgumentsSchema = answerArgsSchema;

/** JSON Schema for the answer tool's arguments, derived from the Zod schema. */
export function answerToolParametersJsonSchema(): JsonSchema {
  const schema = z.toJSONSchema(answerArgsSchema, {
    io: "input",
    target: "draft-2020-12",
  }) as JsonSchema;
  // Same as the canvas tool: the schema is embedded, a $schema key is noise.
  delete schema.$schema;
  return schema;
}

/** Vendor-neutral descriptor; providers adapt it to their wire format. */
export function answerToolDefinition(): {
  name: string;
  description: string;
  parameters: JsonSchema;
} {
  return {
    name: ANSWER_TOOL_NAME,
    description: ANSWER_TOOL_DESCRIPTION,
    parameters: answerToolParametersJsonSchema(),
  };
}

/** OpenAI / OpenAI-compatible `tools` entry. */
export function openAiAnswerToolDefinition(): {
  type: "function";
  function: { name: string; description: string; parameters: JsonSchema };
} {
  const t = answerToolDefinition();
  return {
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  };
}

/** Anthropic `tools` entry. */
export function anthropicAnswerToolDefinition(): {
  name: string;
  description: string;
  input_schema: JsonSchema;
} {
  const t = answerToolDefinition();
  return { name: t.name, description: t.description, input_schema: t.parameters };
}
