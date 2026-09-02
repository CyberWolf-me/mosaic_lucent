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
  /** Hard upper bound for a single attempt. Default 90s. */
  timeoutMs?: number;
  /**
   * Attempts per generation (Stage A retry parity). Default 4, matching the
   * OpenAI-compatible provider. Retries cover transport failures and
   * retryable statuses on BOTH paths; on the streaming path the retry
   * always restarts the entire generation (see streamOperations).
   */
  maxRetries?: number;
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

// Provider-call ceiling. A full-board generation (~50 ops under a 16k output
// budget) can legitimately take over 90s to write; the old 90s cap aborted
// exactly the large generations this output budget was raised FOR (M1), and
// the client's own stream timeout (120s, reset per frame) is the ceiling that
// actually protects the user. 180s keeps the provider ceiling comfortably
// above it.
const DEFAULT_TIMEOUT_MS = 180_000;
// Default to a pinned dated snapshot rather than `-latest`. Anthropic retires
// aliases periodically and a build that ships today shouldn't pin a model
// name that won't exist tomorrow. Operators should set LUCENT_AI_MODEL when
// they upgrade on purpose.
const DEFAULT_MODEL = "claude-3-5-sonnet-20241022";

/**
 * Statuses worth another attempt (mirrors openai-compat). 403 is included:
 * gateways answer with it under transient auth-routing pressure, and dropping
 * it made the OpenAI-compatible client give up where a retry succeeded.
 */
const RETRYABLE_STATUS = new Set([403, 408, 425, 429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(options: AnthropicProviderOptions) {
    if (!options.apiKey) throw new Error("AnthropicProvider requires an apiKey");
    this.apiKey = options.apiKey;
    this.model = options.model ?? DEFAULT_MODEL;
    this.baseUrl = options.baseUrl ?? "https://api.anthropic.com/v1/messages";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = Math.max(1, options.maxRetries ?? 4);
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

    // Abort per attempt so retries don't compound and a stalled gateway can't
    // pin the user's UI on "thinking" forever.
    let lastDetail = "";
    let lastStatus = 0;
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      let response: Response;
      try {
        response = await this.fetchImpl(this.baseUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": this.apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: this.model,
            // Output budget for one full board of operations. A large generation
            // (~20 CREATE_NODE + ~30 CONNECT_NODES) can exceed 8k JSON tokens; a
            // truncated tool-args payload then fails to parse and the whole
            // generation is lost — or the model self-shortens and silently drops
            // the CONNECT_NODES, which emit last per dependency order. 16k covers
            // a full board with headroom (M1 operation reliability).
            max_tokens: 16384,
            system: SYSTEM_PROMPT,
            messages: [{ role: "user", content: userContent }],
            tools: [anthropicToolDefinition()],
            tool_choice: { type: "tool", name: TOOL_NAME },
          }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        // Network-level failure (DNS, reset, timeout) — one more try.
        lastDetail = (err as Error).message;
        lastStatus = 0;
        if (attempt < this.maxRetries - 1) {
          await sleep(400 * 2 ** attempt);
          continue;
        }
        throw new Error(`Anthropic request failed (network): ${lastDetail}`);
      }

      if (!response.ok) {
        lastStatus = response.status;
        lastDetail = await response.text().catch(() => "");
        if (RETRYABLE_STATUS.has(response.status) && attempt < this.maxRetries - 1) {
          // Exponential backoff with jitter, matching the OpenAI-compatible path.
          await sleep(400 * 2 ** attempt + Math.random() * 250);
          continue;
        }
        throw new Error(`Anthropic request failed (${response.status}): ${lastDetail}`);
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
    // Unreachable: the loop returns or throws on every path.
    throw new Error(`Anthropic request failed (${lastStatus}): ${lastDetail}`);
  }

  /**
   * Streaming generation (M5/E1): messages with `stream: true`, read as an
   * SSE byte stream. Anthropic's event grammar does the structuring: the tool
   * payload arrives as `input_json_delta` fragments on one content block
   * (accumulated by index), prose as `text_delta` on another, usage on
   * `message_start`/`message_delta`, and the terminal `message_stop` is the
   * signal that whatever accumulated parses now — exactly once, exactly as the
   * non-streaming path would have parsed it.
   *
   * THE STREAM RETRY CONTRACT (Stage A): a failed stream attempt always
   * RESTARTS THE ENTIRE GENERATION and discards the incomplete stream.
   * Never append: partial response A + complete response B would yield an
   * invalid or duplicated result. This is safe here because buffers live
   * inside the per-attempt function — a retry begins with every accumulator
   * empty — and because the downstream client only ever applies operations
   * from the terminal `done` frame of a COMPLETE, VALIDATED response. A
   * stream that dies mid-payload simply never produces one. (The gate saw
   * exactly this: a mid-stream termination surfaced as an error, the board
   * stayed untouched, and a fresh request succeeded.)
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

    /** One whole streaming attempt; all accumulators are attempt-local. */
    const attemptStream = async (): Promise<GenerateResult> => {
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
          // Same budget as the non-streaming path — see the note there (M1).
          max_tokens: 16384,
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
      // tool_use block and text blocks side by side. These die with the
      // attempt — nothing here outlives a retry.
      const argumentsByIndex = new Map<number, string>();
      let proseText = "";
      let streamedModel: string | undefined;
      let inputTokens: number | undefined;
      let outputTokens: number | undefined;
      // The retry classification turns on this: `message_stop` is Anthropic's
      // "the answer is whole" frame. A stream that ends WITHOUT it was
      // truncated in transit, so whatever it accumulated is a partial payload
      // — a parse failure on that is transport damage, retryable, while the
      // same failure on a COMPLETED stream is the model answering badly and
      // must not re-ask (found by the Stage A retry tests).
      let sawMessageStop = false;

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
        if (parsed.type === "message_stop") {
          sawMessageStop = true;
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

      if (!sawMessageStop) {
        // Truncated in transit. Whatever the buffers hold is partial; the
        // retry discards it and starts the generation over.
        throw new Error("Anthropic stream terminated before completion");
      }

      const meta = completionMeta(streamedModel ?? this.model, inputTokens, outputTokens);
      const argumentsText = [...argumentsByIndex.values()].find((v) => v !== "");
      if (argumentsText) return parseToolArguments(argumentsText, meta);
      if (proseText !== "") return parseModelJson(proseText, meta);
      throw new Error("Anthropic stream ended without a tool call or text");
    };

    let lastError: Error | undefined;
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        // The previous attempt's buffers died with it: this call starts the
        // generation over from the first byte, discarding any partial stream.
        return await attemptStream();
      } catch (err) {
        lastError = err as Error;
        const message = lastError.message;
        // Only transient failures restart a generation: a mid-stream
        // termination (our own explicit signal), a retryable HTTP status on
        // the stream request, or a network-level transport death. A parse
        // failure on a COMPLETE stream is the model's answer being wrong —
        // retrying would only re-ask for the same shape.
        const statusMatch = message.match(/Anthropic stream failed \((\d+)\)/);
        const retryable =
          /terminated before completion/.test(message) ||
          (statusMatch !== null && RETRYABLE_STATUS.has(Number(statusMatch[1]))) ||
          (statusMatch === null && /network|fetch failed|aborted|timeout|ECONN/i.test(message));
        if (retryable && attempt < this.maxRetries - 1) {
          await sleep(400 * 2 ** attempt + Math.random() * 250);
          continue;
        }
        throw lastError;
      }
    }
    throw lastError ?? new Error("Anthropic stream failed");
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
