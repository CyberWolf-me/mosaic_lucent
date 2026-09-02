import { describe, it, expect, vi } from "vitest";
import { AnthropicProvider } from "../src/index.js";
import { summarizeWorkspace } from "../src/index.js";
import { createWorkspace } from "@lucent/core";

/**
 * Pin the Anthropic provider's request shape and timeout (M0.6e).
 *
 * The provider is the only path that dials Anthropic directly, so any drift
 * in headers/body shape or the timeout wiring is a silent user-visible break.
 */

const OK_BODY = {
  content: [
    {
      type: "tool_use",
      name: "diagram_ops",
      input: {
        operations: [{ op: "CREATE_NODE", id: "a", nodeType: "note", label: "A" }],
        explanation: "ok",
      },
    },
  ],
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const request = {
  message: "make a node",
  summary: summarizeWorkspace(createWorkspace()),
};

describe("AnthropicProvider", () => {
  it("sends a tool call and parses the tool_use input", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200, OK_BODY));

    const provider = new AnthropicProvider({ apiKey: "k", fetchImpl });
    const result = await provider.generateOperations(request);

    expect(result.operations).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("k");
    const body = JSON.parse(init.body as string);
    expect(body.tool_choice).toEqual({ type: "tool", name: "apply_canvas_operations" });
    expect(typeof body.system).toBe("string");
  });

  it("defaults to a pinned model when none is supplied", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200, OK_BODY));
    const provider = new AnthropicProvider({ apiKey: "k", fetchImpl });
    await provider.generateOperations(request);

    const body = JSON.parse((fetchImpl.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.model).toMatch(/^claude-/);
    // Anti-regression: do not silently revert to a `-latest` alias that
    // Anthropic can rename.
    expect(body.model.endsWith("-latest")).toBe(false);
  });

  it("passes an AbortSignal.timeout to fetch", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200, OK_BODY));
    const provider = new AnthropicProvider({ apiKey: "k", fetchImpl, timeoutMs: 5_000 });
    await provider.generateOperations(request);

    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect((init.signal as AbortSignal).aborted).toBe(false);
  });

  it("surfaces a non-2xx response with the upstream status and body", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(401, "unauthorized"));
    const provider = new AnthropicProvider({ apiKey: "k", fetchImpl });

    await expect(provider.generateOperations(request)).rejects.toThrow(/401/);
  });
});

// ---- Stage A: retry parity with the streaming restart contract ----------------
//
// The gate saw one mid-stream termination in fourteen calls. The contract the
// review pinned: a stream retry ALWAYS restarts the entire generation and
// discards the incomplete stream — partial A + complete B would be an invalid
// or duplicated result. That is enforced by attempt-local buffers plus the
// downstream rule that ops apply only from a complete, validated response.

function sseResponse(events: Array<string | { error: string }>): Response {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const event of events) {
    if (typeof event === "string") {
      chunks.push(encoder.encode(`data: ${JSON.stringify(JSON.parse(event))}\n\n`));
    } else {
      // A transport death mid-stream: the body errors before any terminal
      // frame arrives — exactly the partial-stream shape the contract covers.
      chunks.push(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      chunks.push(encoder.encode("data: ")); // truncated line, then the body ends
    }
  }
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const STREAM_TOOL_USE = [
  JSON.stringify({
    type: "message_start",
    message: { model: "claude-test", usage: { input_tokens: 10 } },
  }),
  JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use" } }),
  JSON.stringify({
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: '{"operations":[' },
  }),
  JSON.stringify({
    type: "content_block_delta",
    index: 0,
    delta: {
      type: "input_json_delta",
      partial_json: '{"op":"CREATE_NODE","id":"a","nodeType":"note","label":"A"}',
    },
  }),
  JSON.stringify({
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: '],"explanation":"ok"}' },
  }),
  JSON.stringify({ type: "content_block_stop", index: 0 }),
  JSON.stringify({ type: "message_delta", usage: { output_tokens: 20 } }),
  JSON.stringify({ type: "message_stop" }),
];

describe("AnthropicProvider retries (Stage A)", () => {
  it("retries a retryable status on the JSON path and succeeds", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(503, "overloaded"))
      .mockResolvedValueOnce(jsonResponse(200, OK_BODY));
    const provider = new AnthropicProvider({ apiKey: "k", fetchImpl, maxRetries: 3 });
    const result = await provider.generateOperations(request);
    expect(result.operations).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("gives up after maxRetries and surfaces the last status", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(503, "overloaded"));
    const provider = new AnthropicProvider({ apiKey: "k", fetchImpl, maxRetries: 2 });
    await expect(provider.generateOperations(request)).rejects.toThrow(/503/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a non-retryable status (401)", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(401, "no key"));
    const provider = new AnthropicProvider({ apiKey: "k", fetchImpl, maxRetries: 4 });
    await expect(provider.generateOperations(request)).rejects.toThrow(/401/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("PARTIAL STREAM → retry → complete response → exactly one result", async () => {
    // The review's named case. Attempt 1 dies mid-payload after emitting a
    // partial tool-args JSON; the retry must start the generation OVER (a
    // fresh request), never append to the dead buffers, and the final
    // result must come solely from the complete second stream.
    const fetchImpl = vi
      .fn<typeof fetch>()
      // Attempt 1: a stream that delivers a real fragment and then terminates.
      .mockResolvedValueOnce(
        sseResponse([
          STREAM_TOOL_USE[0]!,
          STREAM_TOOL_USE[1]!,
          STREAM_TOOL_USE[2]!,
          { error: "terminated" },
        ]),
      )
      // Attempt 2: the complete stream.
      .mockResolvedValueOnce(sseResponse(STREAM_TOOL_USE));

    const provider = new AnthropicProvider({ apiKey: "k", fetchImpl, maxRetries: 3 });
    const deltas: string[] = [];
    const result = await provider.streamOperations(request, {
      onDelta: (d) => deltas.push(d),
    });

    // Exactly one result, built from the complete response alone.
    expect(result.operations).toHaveLength(1);
    expect(result.operations[0]?.op).toBe("CREATE_NODE");
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    // The restarted generation re-emits its deltas from byte zero: the
    // fragment from the dead attempt is NOT carried into the result. (Both
    // attempts legitimately stream to onDelta — that is display material —
    // but the parsed result contains exactly one operation, proving the
    // buffers were not concatenated.)
    const parsed = JSON.parse(deltas.slice(-3).join("")) as { operations: unknown[] };
    expect(parsed.operations).toHaveLength(1);
  });

  it("a complete-but-invalid final stream still fails (no infinite retry)", async () => {
    // A stream that DOES deliver message_stop but whose accumulated args
    // don't parse is the model answering badly, not transport damage —
    // exactly ONE attempt, then the parse error surfaces.
    const completeButBad = [
      ...STREAM_TOOL_USE.slice(0, 3),
      // a fragment that never forms valid JSON, then the answer is "whole":
      JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"operations":[' },
      }),
      JSON.stringify({ type: "content_block_stop", index: 0 }),
      JSON.stringify({ type: "message_delta", usage: { output_tokens: 5 } }),
      JSON.stringify({ type: "message_stop" }),
    ];
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(sseResponse(completeButBad));
    const provider = new AnthropicProvider({ apiKey: "k", fetchImpl, maxRetries: 4 });
    await expect(provider.streamOperations(request, { onDelta: () => {} })).rejects.toThrow(
      /not valid JSON/,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
