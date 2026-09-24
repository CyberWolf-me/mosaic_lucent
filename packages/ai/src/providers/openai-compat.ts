import { openAiToolDefinition, TOOL_NAME } from "@lucent/core";
import type { GenerateRequest, GenerateResult, LLMProvider, StreamCallbacks } from "../provider.js";
import type { AnswerRequest, AnswerResult } from "../answer.js";
import { ANSWER_TOOL_NAME, openAiAnswerToolDefinition } from "../answer.js";
import type { ExternalPlanRequest, ExternalPlanResult } from "../externalPlan.js";
import { EXTERNAL_PLAN_TOOL_NAME, openAiExternalPlanToolDefinition } from "../externalPlan.js";
import {
  NOTES_TOOL_NAME,
  openAiNotesToolDefinition,
  parseNotesDraft,
  type NotesRequest,
  type NotesResult,
} from "../notes.js";
import { NOTES_SYSTEM_PROMPT, buildNotesUserPrompt } from "../prompt.js";
import { sseEvents } from "./sse.js";
import {
  ANSWER_SYSTEM_PROMPT,
  EXTERNAL_PLAN_SYSTEM_PROMPT,
  SYSTEM_PROMPT,
  buildAnswerUserPrompt,
  buildExternalPlanUserPrompt,
  buildUserPrompt,
} from "../prompt.js";
import {
  completionMeta,
  parseAnswerModelJson,
  parseAnswerToolArguments,
  parseExternalPlanModelJson,
  parseExternalPlanToolArguments,
  parseModelJson,
  parseToolArguments,
} from "./toolCall.js";

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
  /** Optional fallback model to use if the primary model fails. */
  fallbackModel?: string;
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
const RETRYABLE_STATUS = new Set([403, 408, 425, 429, 500, 502, 503, 504, 522, 524]);
// Per-attempt ceiling. A full-board generation (~50 ops under a 16k output
// budget) can legitimately take over 90s to write; the old 90s per-attempt
// cap aborted exactly the large generations the budget was raised for (M1).
// The client's stream timeout (120s, reset per frame) remains the user-side
// guard. 180s keeps the provider comfortably above it.
const DEFAULT_TIMEOUT_MS = 180_000;

/**
 * Some upstreams behind OpenAI-compatible gateways (e.g. muse-spark via
 * kiosapi) only accept `tool_choice: "auto"` and 400 on the named-function
 * form we send to force the tool. One probe is enough: the first such 400
 * flips this per-instance flag, and every later request goes out with
 * `"auto"` from the start. The tool definition stays in the request, and the
 * prose fallback below already covers a model that declines to call it.
 */
function isToolChoiceUnsupported(status: number, detail: string): boolean {
  return status === 400 && /tool_choice/i.test(detail) && /auto/i.test(detail);
}

function withAutoToolChoice(bodyText: string): string {
  const body = JSON.parse(bodyText) as Record<string, unknown>;
  body.tool_choice = "auto";
  return JSON.stringify(body);
}

/**
 * Gateways or upstreams (such as muse-spark via kiosapi) reject tools containing
 * recursive schemas with "Recursive JSON schemas are not currently supported".
 * When detected, we strip recursive self-references and retry immediately.
 */
function isRecursiveSchemaUnsupported(status: number, detail: string): boolean {
  return status === 400 && /recursive.*schema/i.test(detail);
}

function withNonRecursiveTools(bodyText: string): string {
  const body = JSON.parse(bodyText) as Record<string, unknown>;
  if (Array.isArray(body.tools)) {
    body.tools = JSON.parse(JSON.stringify(body.tools), (key, value) => {
      if (key === "children" && value && typeof value === "object" && value.items && value.items["$ref"]) {
        return { type: "array", items: { type: "object", additionalProperties: true } };
      }
      return value;
    });
    for (const t of body.tools as Array<{ function?: { parameters?: Record<string, unknown> } }>) {
      if (t.function?.parameters?.$defs) {
        delete t.function.parameters.$defs;
      }
    }
  }
  return JSON.stringify(body);
}

/**
 * Salvage a chat-completion object from a response that arrived as an SSE body
 * (kilo-auto via kiosapi answers `stream:false` requests with `data: {...}`
 * framing). Returns the last parseable frame; surfaces the original JSON error
 * when the body holds nothing usable, so the failure reads the same as before.
 *
 * A frame's payload may span MULTIPLE `data:` lines (the SSE spec's reason for
 * the multi-line form) — the same reader rule `sseEvents` applies: all `data:`
 * lines within one frame join into one payload. Parsing line-by-line would
 * fail on exactly the bodies this exists to recover.
 */
function recoverSseBody(bodyText: string, originalError: Error): ChatResponse {
  const frames = bodyText.split(/\r?\n\r?\n/);
  for (const frame of frames.reverse()) {
    const payload = frame
      .split(/\r?\n/)
      .filter((line) => line.trim().startsWith("data:"))
      .map((line) => line.trim().slice(5).trim())
      .join("");
    if (!payload || payload === "[DONE]") continue;
    try {
      return JSON.parse(payload) as ChatResponse;
    } catch {
      // try an earlier frame
    }
  }
  throw originalError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly name: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fallbackModel?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  /** Flips after the first "only auto is supported" 400 — see the helper. */
  private forceAutoToolChoice = false;
  /** Flips after the first "recursive schemas not supported" 400. */
  private forceNonRecursiveTools = false;

  constructor(options: OpenAICompatOptions) {
    if (!options.apiKey) throw new Error("OpenAICompatibleProvider requires an apiKey");
    if (!options.baseUrl) throw new Error("OpenAICompatibleProvider requires a baseUrl");
    if (!options.model) throw new Error("OpenAICompatibleProvider requires a model");
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl;
    this.model = options.model;
    this.fallbackModel = options.fallbackModel;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.name = options.name ?? "openai-compat";
    this.maxRetries = Math.max(1, options.maxRetries ?? 4);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private candidateModels(): string[] {
    return [
      this.model,
      ...(this.fallbackModel && this.fallbackModel !== this.model ? [this.fallbackModel] : []),
    ];
  }

  async generateOperations(request: GenerateRequest): Promise<GenerateResult> {
    const models = this.candidateModels();
    let lastError: Error | null = null;
    for (const modelToUse of models) {
      try {
        return await this.executeGenerateOperations(request, modelToUse);
      } catch (err) {
        lastError = err as Error;
      }
    }
    throw lastError ?? new Error("Provider request failed");
  }

  private async executeGenerateOperations(
    request: GenerateRequest,
    modelToUse: string,
  ): Promise<GenerateResult> {
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

    let body = JSON.stringify({
      model: modelToUse,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
      tools: [openAiToolDefinition()],
      // Ask for the tool specifically; the schema then guarantees the shape.
      // An upstream that only accepts "auto" downgrades this once — see
      // isToolChoiceUnsupported.
      tool_choice: this.forceAutoToolChoice
        ? "auto"
        : { type: "function", function: { name: TOOL_NAME } },
      // An explicit output budget. Without one, the gateway's default
      // applies — often far below what a full board of operations needs —
      // and the tool args truncate mid-JSON (unparseable) or the model
      // self-shortens and silently drops the CONNECT_NODES, which emit last
      // per dependency order (M1 operation reliability).
      max_tokens: 16384,
      temperature: 0.2,
      // Explicit opt-OUT of streaming. Gateways differ on the default: some
      // stream unless asked otherwise, and a true chunk stream breaks the
      // below salvage (its first frames carry empty choices). The dedicated
      // streaming path (streamOperations) opts back in per call.
      stream: false,
    });
    if (this.forceNonRecursiveTools) body = withNonRecursiveTools(body);

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
        // Named tool_choice unsupported upstream: downgrade to "auto" and
        // retry immediately (not counted against the retry ladder).
        if (isToolChoiceUnsupported(lastStatus, lastDetail) && !this.forceAutoToolChoice) {
          this.forceAutoToolChoice = true;
          body = withAutoToolChoice(body);
          attempt--;
          continue;
        }
        // Recursive schema unsupported upstream: strip recursive refs and
        // retry immediately (not counted against the retry ladder).
        if (isRecursiveSchemaUnsupported(lastStatus, lastDetail) && !this.forceNonRecursiveTools) {
          this.forceNonRecursiveTools = true;
          body = withNonRecursiveTools(body);
          attempt--;
          continue;
        }
        if (RETRYABLE_STATUS.has(response.status) && attempt < this.maxRetries - 1) {
          // Exponential backoff with jitter: 400ms, 800ms, 1600ms (+ up to 250ms).
          await sleep(400 * 2 ** attempt + Math.random() * 250);
          continue;
        }
        throw new Error(`Provider request failed (${response.status}): ${lastDetail}`);
      }

      // A misbehaving route can STILL ignore `stream:false` and answer with
      // an SSE body ("data: {...}\n\n") — the old kiosapi host did exactly
      // this with single-frame completions. The raw text is read exactly once — after
      // .json() consumes the body, .text() throws "Body has already been
      // read" — then parsed as plain JSON, and on failure as an SSE frame.
      let data: ChatResponse;
      const raw = await response.text().catch(() => "");
      try {
        data = JSON.parse(raw) as ChatResponse;
      } catch {
        data = recoverSseBody(
          raw,
          new Error(`Provider returned non-JSON body: ${raw.slice(0, 120)}`),
        );
      }
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
   * The answer call type (Stage C1): the build path's request loop, retry
   * ladder, and prose fallback, with the historian prompt, the answer tool,
   * and the answer parsers swapped in. No streaming, no repair — see the
   * Anthropic provider's note for why (a dropped citation is not worth
   * re-asking the whole question).
   */
  async generateAnswer(request: AnswerRequest): Promise<AnswerResult> {
    const models = this.candidateModels();
    let lastError: Error | null = null;
    for (const modelToUse of models) {
      try {
        return await this.executeGenerateAnswer(request, modelToUse);
      } catch (err) {
        lastError = err as Error;
      }
    }
    throw lastError ?? new Error("Provider request failed");
  }

  private async executeGenerateAnswer(
    request: AnswerRequest,
    modelToUse: string,
  ): Promise<AnswerResult> {
    let body = JSON.stringify({
      model: modelToUse,
      messages: [
        { role: "system", content: ANSWER_SYSTEM_PROMPT },
        { role: "user", content: buildAnswerUserPrompt(request) },
      ],
      tools: [openAiAnswerToolDefinition()],
      tool_choice: this.forceAutoToolChoice
        ? "auto"
        : { type: "function", function: { name: ANSWER_TOOL_NAME } },
      // A few sentences plus a citation list, not a board.
      max_tokens: 4096,
      temperature: 0.2,
      // Explicit opt-out: the streaming path (streamOperations) opts in per
      // call; everything else asks for one JSON body (see generateOperations).
      stream: false,
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
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
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
        if (isToolChoiceUnsupported(lastStatus, lastDetail) && !this.forceAutoToolChoice) {
          this.forceAutoToolChoice = true;
          body = withAutoToolChoice(body);
          attempt--;
          continue;
        }
        if (RETRYABLE_STATUS.has(response.status) && attempt < this.maxRetries - 1) {
          await sleep(400 * 2 ** attempt + Math.random() * 250);
          continue;
        }
        throw new Error(`Provider request failed (${lastStatus}): ${lastDetail}`);
      }

      const data = (await response.json()) as ChatResponse;
      const message = data.choices?.[0]?.message;
      const meta = completionMeta(
        data.model ?? this.model,
        data.usage?.prompt_tokens,
        data.usage?.completion_tokens,
      );

      const call =
        message?.tool_calls?.find((c) => c.function?.name === ANSWER_TOOL_NAME) ??
        message?.tool_calls?.[0];
      if (call?.function?.arguments) {
        return parseAnswerToolArguments(call.function.arguments, meta);
      }

      const text = message?.content ?? "";
      if (!text) throw new Error("Provider returned neither a tool call nor content");
      return parseAnswerModelJson(text, meta);
    }

    throw new Error(`Provider request failed (${lastStatus}): ${lastDetail}`);
  }

  /**
   * The external-plan call type (Stage D9): the answer path's loop with the
   * selector prompt, the selector tool, and the selector parsers swapped
   * in. Same no-repair/no-streaming posture — a dropped selection is a
   * human-decided retry, not worth re-asking.
   */
  /** docs/27 N1: enhance a person's meeting notes — placements plus cited lines. */
  async generateNotes(request: NotesRequest): Promise<NotesResult> {
    const models = this.candidateModels();
    let lastError: Error | null = null;
    for (const modelToUse of models) {
      try {
        return await this.executeGenerateNotes(request, modelToUse);
      } catch (err) {
        lastError = err as Error;
      }
    }
    throw lastError ?? new Error("Provider request failed");
  }

  private async executeGenerateNotes(request: NotesRequest, modelToUse: string): Promise<NotesResult> {
    let body = JSON.stringify({
      model: modelToUse,
      messages: [
        { role: "system", content: NOTES_SYSTEM_PROMPT },
        { role: "user", content: buildNotesUserPrompt(request) },
      ],
      tools: [openAiNotesToolDefinition()],
      tool_choice: this.forceAutoToolChoice ? "auto" : { type: "function", function: { name: NOTES_TOOL_NAME } },
      max_tokens: 4096,
      temperature: 0.2,
      stream: false,
    });
    let lastDetail = "";
    let lastStatus = 0;
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      let response: Response;
      try {
        response = await this.fetchImpl(this.baseUrl, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
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
        if (isToolChoiceUnsupported(lastStatus, lastDetail) && !this.forceAutoToolChoice) {
          this.forceAutoToolChoice = true;
          body = withAutoToolChoice(body);
          attempt--;
          continue;
        }
        if (RETRYABLE_STATUS.has(response.status) && attempt < this.maxRetries - 1) {
          await sleep(400 * 2 ** attempt + Math.random() * 250);
          continue;
        }
        throw new Error(`Provider request failed (${lastStatus}): ${lastDetail}`);
      }
      const data = (await response.json()) as ChatResponse;
      const message = data.choices?.[0]?.message;
      const meta = completionMeta(data.model ?? modelToUse, data.usage?.prompt_tokens, data.usage?.completion_tokens);
      const call = message?.tool_calls?.find((c) => c.function?.name === NOTES_TOOL_NAME) ?? message?.tool_calls?.[0];
      const draft = call?.function?.arguments
        ? parseNotesDraft(call.function.arguments)
        : parseNotesDraft(message?.content ?? "");
      return { ...draft, ...meta };
    }
    throw new Error(`Provider request failed (${lastStatus}): ${lastDetail}`);
  }

  async generateExternalPlan(request: ExternalPlanRequest): Promise<ExternalPlanResult> {
    const models = this.candidateModels();
    let lastError: Error | null = null;
    for (const modelToUse of models) {
      try {
        return await this.executeGenerateExternalPlan(request, modelToUse);
      } catch (err) {
        lastError = err as Error;
      }
    }
    throw lastError ?? new Error("Provider request failed");
  }

  private async executeGenerateExternalPlan(
    request: ExternalPlanRequest,
    modelToUse: string,
  ): Promise<ExternalPlanResult> {
    let body = JSON.stringify({
      model: modelToUse,
      messages: [
        { role: "system", content: EXTERNAL_PLAN_SYSTEM_PROMPT },
        { role: "user", content: buildExternalPlanUserPrompt(request) },
      ],
      tools: [openAiExternalPlanToolDefinition()],
      tool_choice: this.forceAutoToolChoice
        ? "auto"
        : { type: "function", function: { name: EXTERNAL_PLAN_TOOL_NAME } },
      // A selection list plus one paragraph, not a board.
      max_tokens: 2048,
      temperature: 0.2,
      // Explicit opt-out, same rule as the other non-streaming paths.
      stream: false,
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
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
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
        if (isToolChoiceUnsupported(lastStatus, lastDetail) && !this.forceAutoToolChoice) {
          this.forceAutoToolChoice = true;
          body = withAutoToolChoice(body);
          attempt--;
          continue;
        }
        if (RETRYABLE_STATUS.has(response.status) && attempt < this.maxRetries - 1) {
          await sleep(400 * 2 ** attempt + Math.random() * 250);
          continue;
        }
        throw new Error(`Provider request failed (${lastStatus}): ${lastDetail}`);
      }

      const data = (await response.json()) as ChatResponse;
      const message = data.choices?.[0]?.message;
      const meta = completionMeta(
        data.model ?? modelToUse,
        data.usage?.prompt_tokens,
        data.usage?.completion_tokens,
      );

      const call =
        message?.tool_calls?.find((c) => c.function?.name === EXTERNAL_PLAN_TOOL_NAME) ??
        message?.tool_calls?.[0];
      if (call?.function?.arguments) {
        return parseExternalPlanToolArguments(call.function.arguments, meta);
      }

      const text = message?.content ?? "";
      if (!text) throw new Error("Provider returned neither a tool call nor content");
      return parseExternalPlanModelJson(text, meta);
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
    const models = this.candidateModels();
    let lastError: Error | null = null;
    for (const modelToUse of models) {
      let emittedDelta = false;
      const wrappedCallbacks: StreamCallbacks = {
        onDelta: (delta) => {
          emittedDelta = true;
          callbacks.onDelta(delta);
        },
      };
      try {
        return await this.executeStreamOperations(request, wrappedCallbacks, modelToUse);
      } catch (err) {
        lastError = err as Error;
        // If we already emitted deltas to the client, we cannot safely try another model
        // because the user/stream has already received partial text.
        if (emittedDelta) {
          throw err;
        }
      }
    }
    throw lastError ?? new Error("Provider request failed");
  }

  private async executeStreamOperations(
    request: GenerateRequest,
    callbacks: StreamCallbacks,
    modelToUse: string,
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

    const makeStreamBody = () => {
      let b = JSON.stringify({
        model: modelToUse,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
        tools: [openAiToolDefinition()],
        tool_choice: this.forceAutoToolChoice
          ? "auto"
          : { type: "function", function: { name: TOOL_NAME } },
        // Same explicit budget as the non-streaming path — see the note there.
        max_tokens: 16384,
        temperature: 0.2,
        stream: true,
        // Not every gateway honours this; absence just means no usage chunk.
        stream_options: { include_usage: true },
      });
      if (this.forceNonRecursiveTools) b = withNonRecursiveTools(b);
      return b;
    };

    const openStream = () =>
      this.fetchImpl(this.baseUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
          accept: "text/event-stream",
        },
        body: makeStreamBody(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

    // A pre-stream failure carries no streamed data, so a transient gateway
    // rejection (Cloudflare 522/524 from the routers we sit behind) is safe
    // to retry here. Once bytes have flowed, a failure is terminal — the
    // caller has already been shown the partial text.
    let response = await openStream();
    // Named tool_choice unsupported upstream: downgrade to "auto" and retry
    // once before surfacing the failure (see isToolChoiceUnsupported).
    if (
      !response.ok &&
      isToolChoiceUnsupported(response.status, await response.text().catch(() => "")) &&
      !this.forceAutoToolChoice
    ) {
      this.forceAutoToolChoice = true;
      response = await openStream();
    }
    if (
      !response.ok &&
      isRecursiveSchemaUnsupported(response.status, await response.text().catch(() => "")) &&
      !this.forceNonRecursiveTools
    ) {
      this.forceNonRecursiveTools = true;
      response = await openStream();
    }
    for (let attempt = 1; !response.ok && attempt < this.maxRetries; attempt++) {
      if (!RETRYABLE_STATUS.has(response.status)) break;
      await response.text().catch(() => "");
      await sleep(400 * 2 ** (attempt - 1) + Math.random() * 250);
      response = await openStream();
    }
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
      streamedModel ?? modelToUse,
      usage?.prompt_tokens,
      usage?.completion_tokens,
    );
    if (argumentsText !== "") return parseToolArguments(argumentsText, meta);
    if (proseText !== "") return parseModelJson(proseText, meta);
    // Some routes close an SSE stream with zero content even though the same request
    // answers over the non-streaming endpoint. Nothing was emitted to the caller,
    // so re-asking without streaming is invisible to the user and saves the route.
    return this.executeGenerateOperations(request, modelToUse);
  }
}

interface ChatStreamChunk {
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  choices?: Array<{
    delta?: { content?: string | null; tool_calls?: Array<{ function?: { arguments?: string } }> };
  }>;
}
