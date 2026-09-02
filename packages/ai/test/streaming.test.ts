import { describe, expect, it } from "vitest";
import { createWorkspace } from "@lucent/core";
import { summarizeWorkspace } from "../src/provider.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { MockProvider } from "../src/providers/mock.js";
import { OpenAICompatibleProvider } from "../src/providers/openai-compat.js";
import { streamViaGenerate } from "../src/provider.js";
import type { StreamCallbacks } from "../src/provider.js";

/**
 * Streaming providers (M5/E1). Each fake fetch returns an SSE body built from
 * encoded chunks — deliberately split mid-frame and mid-JSON so the reader's
 * reassembly, not the test's luck, is what's under test. The contract every
 * provider must hold: the deltas concatenated equal the payload the final
 * result parses from, and the resolved result matches the non-streaming path.
 */

const EMPTY_SUMMARY = summarizeWorkspace(createWorkspace());

const TOOL_ARGS = JSON.stringify({
  operations: [{ op: "CREATE_NODE", id: "a", nodeType: "step", label: "A" }],
  explanation: "added a node",
});

/** An SSE Response whose body arrives in the given string chunks. */
function sseResponse(frames: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { "content-type": "text/event-stream" } });
}

function collecting(): StreamCallbacks & { text: string } {
  return {
    text: "",
    onDelta(delta: string) {
      this.text += delta;
    },
  };
}

describe("OpenAI-compatible streaming", () => {
  it("reassembles tool-call argument deltas split across chunks", async () => {
    // Chunk boundaries fall mid-JSON and mid-frame on purpose: the slices are
    // taken from the real payload, then safely encoded into each SSE frame.
    const slices = [TOOL_ARGS.slice(0, 12), TOOL_ARGS.slice(12, 47), TOOL_ARGS.slice(47)];
    const frames = [
      ...slices.map(
        (slice) =>
          "data: " +
          JSON.stringify({
            model: "routed-model",
            choices: [{ delta: { tool_calls: [{ function: { arguments: slice } }] } }],
          }) +
          "\n\n",
      ),
      "data: " +
        JSON.stringify({
          choices: [{ delta: {} }],
          usage: { prompt_tokens: 11, completion_tokens: 7 },
        }) +
        "\n\n",
      "data: [DONE]\n\n",
    ];
    const provider = new OpenAICompatibleProvider({
      apiKey: "k",
      baseUrl: "https://gateway.test/v1/chat/completions",
      model: "m",
      fetchImpl: (async () => sseResponse(frames)) as typeof fetch,
    });
    const callbacks = collecting();
    const result = await provider.streamOperations(
      { message: "add a node", summary: EMPTY_SUMMARY },
      callbacks,
    );
    expect(result.operations).toEqual([
      { op: "CREATE_NODE", id: "a", nodeType: "step", label: "A" },
    ]);
    expect(result.explanation).toBe("added a node");
    expect(result.model).toBe("routed-model");
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
    // The deltas ARE the payload: concatenated they parse to the same thing.
    expect(JSON.parse(callbacks.text)).toEqual({
      operations: result.operations,
      explanation: "added a node",
    });
  });

  it("falls back to prose deltas when the gateway ignores tools", async () => {
    const frames = [
      'data: {"choices":[{"delta":{"content":"{\\"operations\\": []"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":", \\"explanation\\": null}"}}]}\n\n',
      "data: [DONE]\n\n",
    ];
    const provider = new OpenAICompatibleProvider({
      apiKey: "k",
      baseUrl: "https://gateway.test/v1/chat/completions",
      model: "m",
      fetchImpl: (async () => sseResponse(frames)) as typeof fetch,
    });
    const result = await provider.streamOperations(
      { message: "x", summary: EMPTY_SUMMARY },
      collecting(),
    );
    expect(result.operations).toEqual([]);
  });

  it("a non-2xx stream start is a provider failure", async () => {
    const provider = new OpenAICompatibleProvider({
      apiKey: "k",
      baseUrl: "https://gateway.test/v1/chat/completions",
      model: "m",
      fetchImpl: (async () => sseResponse(["nope"], 503)) as typeof fetch,
      maxRetries: 1,
    });
    await expect(
      provider.streamOperations({ message: "x", summary: EMPTY_SUMMARY }, collecting()),
    ).rejects.toThrow(/503/);
  });
});

describe("Anthropic streaming", () => {
  it("accumulates input_json_delta by block index and reads usage from the frame pair", async () => {
    // The JSON is split at arbitrary points across input_json_delta frames;
    // every event line is built by JSON.stringify so the fixture cannot have
    // an escaping bug of its own.
    const slices = [TOOL_ARGS.slice(0, 30), TOOL_ARGS.slice(30)];
    const frame = (event: unknown): string => "data: " + JSON.stringify(event) + "\n\n";
    const frames = [
      frame({ type: "message_start", message: { model: "claude-x", usage: { input_tokens: 9 } } }),
      frame({ type: "content_block_start", index: 0, content_block: { type: "tool_use" } }),
      ...slices.map((partial_json) =>
        frame({
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json },
        }),
      ),
      frame({ type: "content_block_stop", index: 0 }),
      frame({ type: "message_delta", usage: { output_tokens: 14 } }),
      frame({ type: "message_stop" }),
    ];
    const provider = new AnthropicProvider({
      apiKey: "k",
      fetchImpl: (async () => sseResponse(frames)) as typeof fetch,
    });
    const callbacks = collecting();
    const result = await provider.streamOperations(
      { message: "add a node", summary: EMPTY_SUMMARY },
      callbacks,
    );
    expect(result.operations).toEqual([
      { op: "CREATE_NODE", id: "a", nodeType: "step", label: "A" },
    ]);
    expect(result.explanation).toBe("added a node");
    expect(result.model).toBe("claude-x");
    expect(result.usage).toEqual({ inputTokens: 9, outputTokens: 14 });
    expect(JSON.parse(callbacks.text)).toEqual({
      operations: result.operations,
      explanation: "added a node",
    });
  });

  it("text deltas parse as prose when no tool block arrives", async () => {
    const frames = [
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"{\\"operations\\": []}"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":3}}\n\n',
      // The terminal frame Anthropic always sends. Since the Stage A retry
      // contract, a stream WITHOUT message_stop is truncation (discarded and
      // retried) — the prose fixture here needed the frame to stay a
      // completed answer rather than an error.
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    const provider = new AnthropicProvider({
      apiKey: "k",
      fetchImpl: (async () => sseResponse(frames)) as typeof fetch,
    });
    const result = await provider.streamOperations(
      { message: "x", summary: EMPTY_SUMMARY },
      collecting(),
    );
    expect(result.operations).toEqual([]);
  });
});

describe("fallback streams", () => {
  it("MockProvider streams its payload in slices and resolves the same result", async () => {
    const provider = new MockProvider();
    const callbacks = collecting();
    const result = await provider.streamOperations(
      { message: "build an e-commerce store", summary: EMPTY_SUMMARY },
      callbacks,
    );
    const expected = await provider.generateOperations({
      message: "build an e-commerce store",
      summary: EMPTY_SUMMARY,
    });
    expect(result.operations).toEqual(expected.operations);
    // More than one delta arrived (the point of the mock's slicing).
    expect(callbacks.text.length).toBeGreaterThan(64);
    expect(JSON.parse(callbacks.text)).toEqual({
      operations: result.operations,
      explanation: result.explanation ?? null,
    });
  });

  it("streamViaGenerate adapts a provider with no native streaming", async () => {
    const provider = new MockProvider();
    const callbacks = collecting();
    const result = await streamViaGenerate(
      provider,
      { message: "x", summary: EMPTY_SUMMARY },
      callbacks,
    );
    expect(result.operations.length).toBeGreaterThan(0);
    expect(JSON.parse(callbacks.text).operations).toEqual(result.operations);
  });
});
