import { anthropicToolDefinition, TOOL_NAME } from "@lucent/core";
import type { GenerateRequest, GenerateResult, LLMProvider, StreamCallbacks } from "../provider.js";
import { SYSTEM_PROMPT, buildUserPrompt } from "../prompt.js";
import { completionMeta, parseModelJson, parseToolArguments } from "./toolCall.js";
import { sseEvents } from "./sse.js";

/**
 * Anthropic-backed provider. Kept dependency-free (uses fetch) so the repo
 * builds without an SDK or key; it only runs when an API key is supplied.
 * Swap-in point: any provider implementing LLMProvider works identically
 * downstream (docs/09 section 0).
 *
 * The operation contract is sent as a tool definition generated from the Zod
 * schema, so the model returns validated structured input rather than prose.
 */

export interface AnthropicProviderOptions {
  apiKey: string;
  model?: string;
  /** Override for testing / proxies. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Hard upper bound for a single request. Default 90s. */
  timeoutMs?: number;
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
  /** Present on tool_use blocks. */
  name?: string;
  input?: unknown;
}

interface AnthropicResponse {
  content?: AnthropicContentBlock[];
  /** The model that answered; echoed back and not always the one requested. */
  model?: string;
  /** Anthropic's token accounting for this call. */
  usage?: { input_tokens?: number; output_tokens?: number };
}

const DEFAULT_TIMEOUT_MS = 90_000;
// Default to a pinned dated snapshot rather than `-latest`. Anthropic retires
// aliases periodically and a build that ships today shouldn't pin a model
// name that won't exist tomorrow. Operators should set LUCENT_AI_MODEL when
// they upgrade on purpose.
const DEFAULT_MODEL = "claude-3-5-sonnet-20241022";

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: AnthropicProviderOptions) {
    if (!options.apiKey) throw new Error("AnthropicProvider requires an apiKey");
    this.apiKey = options.apiKey;
    this.model = options.model ?? DEFAULT_MODEL;
    this.baseUrl = options.baseUrl ?? "https://api.anthropic.com/v1/messages";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async generateOperations(request: GenerateRequest): Promise<GenerateResult> {
    // Vision: Anthropic takes content blocks, images before the text so the
    // model reads the attachment as context for the instruction.
    const prompt = buildUserPrompt(request);
    const userContent = request.images?.length
      ? [
          ...request.images.map((img) => ({
            type: "image" as const,
            source: { type: "base64" as const, media_type: img.mediaType, data: img.data },
          })),
          { type: "text" as const, text: prompt },
        ]
      : prompt;

    // Abort the request after the timeout so a stalled gateway can't pin the
    // user's UI on "thinking" forever.
    const signal = AbortSignal.timeout(this.timeoutMs);
    const response = await this.fetchImpl(this.baseUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
        // A full board of operations exceeds the old 2048 ceiling.
        max_tokens: 8192,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userContent }],
        tools: [anthropicToolDefinition()],
        tool_choice: { type: "tool", name: TOOL_NAME },
      }),
      signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Anthropic request failed (${response.status}): ${detail}`);
    }

    const data = (await response.json()) as AnthropicResponse;

    // Carried on both paths so a prose fallback is still billed correctly. The
    // requested model is the fallback for a response that omits it, since that
    // is the only thing we know was asked for.
    const meta = completionMeta(
      data.model ?? this.model,
      data.usage?.input_tokens,
      data.usage?.output_tokens,
    );

    const toolUse = data.content?.find((c) => c.type === "tool_use");
    if (toolUse?.input !== undefined) {
      return parseToolArguments(toolUse.input as object, meta);
    }

    // Fallback for a response that arrived as text despite the tool request.
    const text = data.content?.find((c) => c.type === "text")?.text ?? "";
    if (!text) throw new Error("Anthropic returned neither a tool call nor text");
    return parseModelJson(text, meta);
  }

  /**
   * Streaming generation (M5/E1): messages with `stream: true`, read as an
   * SSE byte stream. Anthropic's event grammar does the structuring: the tool
   * payload arrives as `input_json_delta` fragments on one content block
   * (accumulated by index), prose as `text_delta` on another, usage on
   * `message_start`/`message_delta`, and the terminal `message_stop` is the
   * signal that whatever accumulated parses now — exactly once, exactly as the
   * non-streaming path would have parsed it.
   */
  async streamOperations(
    request: GenerateRequest,
    callbacks: StreamCallbacks,
  ): Promise<GenerateResult> {
    const prompt = buildUserPrompt(request);
    const userContent = request.images?.length
      ? [
          ...request.images.map((img) => ({
            type: "image" as const,
            source: { type: "base64" as const, media_type: img.mediaType, data: img.data },
          })),
          { type: "text" as const, text: prompt },
        ]
      : prompt;

    const response = await this.fetchImpl(this.baseUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        accept: "text/event-stream",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 8192,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userContent }],
        tools: [anthropicToolDefinition()],
        tool_choice: { type: "tool", name: TOOL_NAME },
        stream: true,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Anthropic stream failed (${response.status}): ${detail}`);
    }

    // One argument buffer per content-block index: a response can carry a
    // tool_use block and text blocks side by side.
    const argumentsByIndex = new Map<number, string>();
    let proseText = "";
    let streamedModel: string | undefined;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;

    for await (const event of sseEvents(response.body)) {
      let parsed: AnthropicStreamEvent;
      try {
        parsed = JSON.parse(event) as AnthropicStreamEvent;
      } catch {
        continue;
      }
      if (parsed.type === "message_start") {
        streamedModel = parsed.message?.model ?? streamedModel;
        inputTokens = parsed.message?.usage?.input_tokens ?? inputTokens;
        continue;
      }
      if (parsed.type === "message_delta") {
        outputTokens = parsed.usage?.output_tokens ?? outputTokens;
        continue;
      }
      if (parsed.type === "content_block_start" && parsed.content_block?.type === "tool_use") {
        argumentsByIndex.set(parsed.index ?? 0, "");
        continue;
      }
      if (parsed.type !== "content_block_delta") continue;
      if (
        parsed.delta?.type === "input_json_delta" &&
        typeof parsed.delta.partial_json === "string"
      ) {
        const index = parsed.index ?? 0;
        argumentsByIndex.set(
          index,
          (argumentsByIndex.get(index) ?? "") + parsed.delta.partial_json,
        );
        callbacks.onDelta(parsed.delta.partial_json);
      } else if (parsed.delta?.type === "text_delta" && typeof parsed.delta.text === "string") {
        proseText += parsed.delta.text;
        callbacks.onDelta(parsed.delta.text);
      }
    }

    const meta = completionMeta(streamedModel ?? this.model, inputTokens, outputTokens);
    const argumentsText = [...argumentsByIndex.values()].find((v) => v !== "");
    if (argumentsText) return parseToolArguments(argumentsText, meta);
    if (proseText !== "") return parseModelJson(proseText, meta);
    throw new Error("Anthropic stream ended without a tool call or text");
  }
}

interface AnthropicStreamEvent {
  type?: string;
  index?: number;
  message?: { model?: string; usage?: { input_tokens?: number } };
  usage?: { output_tokens?: number };
  content_block?: { type?: string };
  delta?: { type?: string; text?: string; partial_json?: string };
}

// Re-exported so existing imports of the extractor from this module keep working.
export { parseModelJson } from "./toolCall.js";
