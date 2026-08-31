import { openAiToolDefinition, TOOL_NAME } from "@lucent/core";
import type { GenerateRequest, GenerateResult, LLMProvider, StreamCallbacks } from "../provider.js";
import { sseEvents } from "./sse.js";
import { SYSTEM_PROMPT, buildUserPrompt } from "../prompt.js";
import { completionMeta, parseModelJson, parseToolArguments } from "./toolCall.js";

/**
 * Provider for OpenAI-compatible chat-completions gateways (e.g. gorouter.app,
 * OpenRouter, LiteLLM, local llama.cpp servers). Uses the standard
 * POST /v1/chat/completions shape with a Bearer token. Dependency-free (fetch),
 * so no SDK is needed and the same LLMProvider contract keeps the rest of the
 * system vendor-agnostic (docs/09 §0).
 *
 * The operation contract is sent as a real tool definition derived from the Zod
 * schema, so the model gets structural validation instead of being asked to
 * hand-write JSON in prose.
 */

export interface OpenAICompatOptions {
  apiKey: string;
  /** Full chat-completions URL, e.g. https://gorouter.app/v1/chat/completions */
  baseUrl: string;
  model: string;
  fetchImpl?: typeof fetch;
  /** Optional friendly name shown in /health. */
  name?: string;
  /** Attempts on transient gateway failures (403/408/429/5xx). Default 4. */
  maxRetries?: number;
  /** Hard upper bound for a single attempt. Default 90s. */
  timeoutMs?: number;
}

interface ToolCall {
  function?: { name?: string; arguments?: string };
}

interface ChatResponse {
  choices?: Array<{
    message?: { content?: string; tool_calls?: ToolCall[] };
  }>;
  /** What the gateway actually routed to, which need not be `this.model`. */
  model?: string;
  /** Standard chat-completions token accounting. */
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * Gateways like gorouter.app sit behind Cloudflare, which intermittently
 * rejects otherwise-valid requests with 403/429/5xx under load. Left unhandled,
 * those surface to the user as a failed generation on an empty board (nothing
 * appears). Retrying transient statuses with a short backoff turns most of them
 * into a successful call.
 */
const RETRYABLE_STATUS = new Set([403, 408, 425, 429, 500, 502, 503, 504]);
// Per-attempt ceiling. A full-board generation (~50 ops under a 16k output
// budget) can legitimately take over 90s to write; the old 90s per-attempt
// cap aborted exactly the large generations the budget was raised for (M1).
// The client's stream timeout (120s, reset per frame) remains the user-side
// guard. 180s keeps the provider comfortably above it.
const DEFAULT_TIMEOUT_MS = 180_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly name: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;

  constructor(options: OpenAICompatOptions) {
    if (!options.apiKey) throw new Error("OpenAICompatibleProvider requires an apiKey");
    if (!options.baseUrl) throw new Error("OpenAICompatibleProvider requires a baseUrl");
    if (!options.model) throw new Error("OpenAICompatibleProvider requires a model");
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl;
    this.model = options.model;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.name = options.name ?? "openai-compat";
    this.maxRetries = Math.max(1, options.maxRetries ?? 4);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async generateOperations(request: GenerateRequest): Promise<GenerateResult> {
    // Vision: OpenAI-compatible gateways take an array of content parts. Text
    // only when there are no images, so a text-only gateway is unaffected.
    const text = buildUserPrompt(request);
    const userContent = request.images?.length
      ? [
          { type: "text", text },
          ...request.images.map((img) => ({
            type: "image_url",
            image_url: { url: `data:${img.mediaType};base64,${img.data}` },
          })),
        ]
      : text;

    const body = JSON.stringify({
      model: this.model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
      tools: [openAiToolDefinition()],
      // Ask for the tool specifically; the schema then guarantees the shape.
      tool_choice: { type: "function", function: { name: TOOL_NAME } },
      // An explicit output budget. Without one, the gateway's default
      // applies — often far below what a full board of operations needs —
      // and the tool args truncate mid-JSON (unparseable) or the model
      // self-shortens and silently drops the CONNECT_NODES, which emit last
      // per dependency order (M1 operation reliability).
      max_tokens: 16384,
      temperature: 0.2,
    });

    let lastDetail = "";
    let lastStatus = 0;
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      let response: Response;
      try {
        response = await this.fetchImpl(this.baseUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.apiKey}`,
          },
          body,
          // Per-attempt timeout so retries don't compound and a stuck socket
          // can't keep the user waiting indefinitely.
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        // Network-level failure (DNS, reset, timeout) — retry.
        lastDetail = (err as Error).message;
        lastStatus = 0;
        if (attempt < this.maxRetries - 1) {
          await sleep(400 * 2 ** attempt);
          continue;
        }
        throw new Error(`Provider request failed (network): ${lastDetail}`);
      }

      if (!response.ok) {
        lastStatus = response.status;
        lastDetail = await response.text().catch(() => "");
        if (RETRYABLE_STATUS.has(response.status) && attempt < this.maxRetries - 1) {
          // Exponential backoff with jitter: 400ms, 800ms, 1600ms (+ up to 250ms).
          await sleep(400 * 2 ** attempt + Math.random() * 250);
          continue;
        }
        throw new Error(`Provider request failed (${response.status}): ${lastDetail}`);
      }

      const data = (await response.json()) as ChatResponse;
      const message = data.choices?.[0]?.message;

      // A gateway may reroute, so the echoed model is preferred over the
      // configured one; both response paths carry it so a prose fallback is
      // billed the same as a tool call.
      const meta = completionMeta(
        data.model ?? this.model,
        data.usage?.prompt_tokens,
        data.usage?.completion_tokens,
      );

      const call =
        message?.tool_calls?.find((c) => c.function?.name === TOOL_NAME) ??
        message?.tool_calls?.[0];
      if (call?.function?.arguments) {
        return parseToolArguments(call.function.arguments, meta);
      }

      // Some gateways ignore tool definitions and answer in prose; degrade
      // rather than fail so a partial-support gateway still works.
      const text = message?.content ?? "";
      if (!text) throw new Error("Provider returned neither a tool call nor content");
      return parseModelJson(text, meta);
    }

    throw new Error(`Provider request failed (${lastStatus}): ${lastDetail}`);
  }

  /**
   * Streaming generation (M5/E1): chat completions with `stream: true`, read
   * as an SSE byte stream. Two accumulation lanes, because a tool-call answer
   * streams through `delta.tool_calls[].function.arguments` while a prose
   * answer streams through `delta.content` — either way the deltas ARE the
   * payload text, so they go straight to the caller's `onDelta`, and whatever
   * accumulated by `[DONE]` parses exactly once into a GenerateResult. Usage
   * arrives on a trailing chunk when the gateway supports
   * `stream_options.include_usage`, and is read when present.
   */
  async streamOperations(
    request: GenerateRequest,
    callbacks: StreamCallbacks,
  ): Promise<GenerateResult> {
    const text = buildUserPrompt(request);
    const userContent = request.images?.length
      ? [
          { type: "text", text },
          ...request.images.map((img) => ({
            type: "image_url",
            image_url: { url: `data:${img.mediaType};base64,${img.data}` },
          })),
        ]
      : text;

    const response = await this.fetchImpl(this.baseUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
        accept: "text/event-stream",
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
        tools: [openAiToolDefinition()],
        tool_choice: { type: "function", function: { name: TOOL_NAME } },
        // Same explicit budget as the non-streaming path — see the note there.
        max_tokens: 16384,
        temperature: 0.2,
        stream: true,
        // Not every gateway honours this; absence just means no usage chunk.
        stream_options: { include_usage: true },
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Provider stream failed (${response.status}): ${detail}`);
    }

    let argumentsText = "";
    let proseText = "";
    let streamedModel: string | undefined;
    let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;

    for await (const event of sseEvents(response.body)) {
      if (event === "[DONE]") break;
      let chunk: ChatStreamChunk;
      try {
        chunk = JSON.parse(event) as ChatStreamChunk;
      } catch {
        continue; // a keep-alive line or a gateway quirk — never fatal mid-stream
      }
      if (chunk.model && !streamedModel) streamedModel = chunk.model;
      if (chunk.usage) usage = chunk.usage;
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;
      const args = delta.tool_calls?.[0]?.function?.arguments;
      if (typeof args === "string" && args !== "") {
        argumentsText += args;
        callbacks.onDelta(args);
      } else if (typeof delta.content === "string" && delta.content !== "") {
        proseText += delta.content;
        callbacks.onDelta(delta.content);
      }
    }

    const meta = completionMeta(
      streamedModel ?? this.model,
      usage?.prompt_tokens,
      usage?.completion_tokens,
    );
    if (argumentsText !== "") return parseToolArguments(argumentsText, meta);
    if (proseText !== "") return parseModelJson(proseText, meta);
    throw new Error("Provider stream ended without a tool call or content");
  }
}

interface ChatStreamChunk {
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  choices?: Array<{
    delta?: { content?: string | null; tool_calls?: Array<{ function?: { arguments?: string } }> };
  }>;
}
