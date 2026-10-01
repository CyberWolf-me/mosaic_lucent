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

  it("retries a transient 522 before any bytes stream, then succeeds", async () => {
    // kiosapi's Cloudflare front intermittently 522s while contacting the
    // upstream. Nothing has streamed yet, so a retry is safe.
    let calls = 0;
    const frames = [
      "data: " +
        JSON.stringify({
          model: "routed-model",
          choices: [{ delta: { tool_calls: [{ function: { arguments: TOOL_ARGS } }] } }],
        }) +
        "\n\n",
      "data: [DONE]\n\n",
    ];
    const provider = new OpenAICompatibleProvider({
      apiKey: "k",
      baseUrl: "https://gateway.test/v1/chat/completions",
      model: "m",
      fetchImpl: (async () => {
        calls += 1;
        if (calls === 1) return sseResponse([], 522);
        return sseResponse(frames);
      }) as typeof fetch,
      maxRetries: 3,
    });
    const callbacks = collecting();
    const result = await provider.streamOperations(
      { message: "x", summary: EMPTY_SUMMARY },
      callbacks,
    );
    expect(result.operations).toHaveLength(1);
    expect(callbacks.text).toBe(TOOL_ARGS);
    expect(calls).toBe(2);
  });

  it("does not retry a stream failure after bytes have flowed", async () => {
    // The first response is OK and streams content, so once the read is under
    // way any failure is terminal — the caller already received that text.
    // The prose here deliberately isn't JSON: the final parse throws, and the
    // point of the test is that exactly ONE upstream call was made (no retry
    // ladder once bytes have flowed).
    const frames = [
      "data: " + JSON.stringify({ choices: [{ delta: { content: "partial" } }] }) + "\n\n",
      "data: [DONE]\n\n",
    ];
    let calls = 0;
    const provider = new OpenAICompatibleProvider({
      apiKey: "k",
      baseUrl: "https://gateway.test/v1/chat/completions",
      model: "m",
      fetchImpl: (async () => {
        calls += 1;
        return sseResponse(frames, 200);
      }) as typeof fetch,
      maxRetries: 3,
    });
    const callbacks = collecting();
    await expect(
      provider.streamOperations({ message: "x", summary: EMPTY_SUMMARY }, callbacks),
    ).rejects.toThrow(/No JSON object/);
    expect(callbacks.text).toBe("partial");
    expect(calls).toBe(1);
  });

  it("downgrades tool_choice to auto on the stream 400 and retries", async () => {
    // muse-spark rejects named tool_choice with a 400; the stream path must
    // degrade the same way the non-streaming path does.
    const toolChoice400 = () =>
      sseResponse(
        [
          'event: error\ndata: {"error":{"message":"only \\"auto\\" is supported for `tool_choice`"}}\n\n',
        ],
        400,
      );
    let calls = 0;
    const bodies: unknown[] = [];
    const frames = [
      "data: " +
        JSON.stringify({
          model: "routed-model",
          choices: [{ delta: { tool_calls: [{ function: { arguments: TOOL_ARGS } }] } }],
        }) +
        "\n\n",
      "data: [DONE]\n\n",
    ];
    const provider = new OpenAICompatibleProvider({
      apiKey: "k",
      baseUrl: "https://gateway.test/v1/chat/completions",
      model: "m",
      fetchImpl: (async (_url, init) => {
        calls += 1;
        bodies.push(JSON.parse((init?.body as string) ?? "{}"));
        if (calls === 1) return toolChoice400();
        return sseResponse(frames);
      }) as typeof fetch,
      maxRetries: 3,
    });
    const result = await provider.streamOperations(
      { message: "x", summary: EMPTY_SUMMARY },
      collecting(),
    );
    expect(result.operations).toHaveLength(1);
    expect(calls).toBe(2);
    expect(bodies[1]).toMatchObject({ tool_choice: "auto" });
  });

  it("falls back to the non-streaming path when the streamed tool JSON is malformed", async () => {
    // A flaky gateway dumps a buffered response that stops mid-array, so the
    // accumulated tool arguments won't parse. The stream path must recover by
    // re-asking without streaming rather than failing the whole generation.
    const broken = '{"operations": [{"op": "CREATE_NODE", "id": "a", "nodeType": "step"'; // truncated
    const streamFrames = [
      "data: " +
        JSON.stringify({
          model: "routed-model",
          choices: [{ delta: { tool_calls: [{ function: { arguments: broken } }] } }],
        }) +
        "\n\n",
      "data: [DONE]\n\n",
    ];
    const okBody = {
      choices: [
        {
          message: {
            content: JSON.stringify({
              operations: [{ op: "CREATE_NODE", id: "a", nodeType: "step", label: "A" }],
              explanation: "ok",
            }),
          },
        },
      ],
    };
    let calls = 0;
    const provider = new OpenAICompatibleProvider({
      apiKey: "k",
      baseUrl: "https://gateway.test/v1/chat/completions",
      model: "m",
      fetchImpl: (async () => {
        calls += 1;
        if (calls === 1) return sseResponse(streamFrames);
        return new Response(JSON.stringify(okBody), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
      maxRetries: 3,
    });
    const result = await provider.streamOperations(
      { message: "x", summary: EMPTY_SUMMARY },
      collecting(),
    );
    expect(result.operations).toHaveLength(1);
    expect(result.operations[0]).toMatchObject({ op: "CREATE_NODE", id: "a" });
    expect(calls).toBe(2); // streamed JSON unparseable → exactly one non-streaming re-ask
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
      reply: result.reply ?? null,
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
