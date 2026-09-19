import { describe, expect, it, vi } from "vitest";
import { createWorkspace } from "@lucent/core";
import { streamGenerate } from "../src/api.js";

/**
 * The SSE reader behind `streamGenerate` (M5/E1). The server frames are
 * `event: X\ndata: {...}\n\n`, possibly split across body chunks; the client
 * must reassemble them whatever the chunk boundaries.
 */

function sseBody(frames: Array<[string, unknown]>, chunkSize = 1): ReadableStream<Uint8Array> {
  const raw = frames.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < raw.length; i += chunkSize) {
        controller.enqueue(new TextEncoder().encode(raw.slice(i, i + chunkSize)));
      }
      controller.close();
    },
  });
}

function mockFetchSse(frames: Array<[string, unknown]>, chunkSize = 1): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(sseBody(frames, chunkSize), { status: 200 })),
  );
}

const emptyWorkspace = createWorkspace();

describe("streamGenerate", () => {
  it("delivers deltas in order and resolves with the done frame", async () => {
    mockFetchSse(
      [
        ["start", { provider: "mock" }],
        ["delta", { text: '{"oper' }],
        ["delta", { text: 'ations":1}' }],
        [
          "done",
          {
            operations: [{ op: "CREATE_NODE", id: "a", nodeType: "step", label: "A" }],
            explanation: "made it",
            provider: "mock",
          },
        ],
      ],
      7,
    );
    const deltas: string[] = [];
    const result = await streamGenerate(
      "x",
      emptyWorkspace,
      (t) => deltas.push(t),
      undefined,
      undefined,
      undefined,
    );
    expect(deltas).toEqual(['{"oper', 'ations":1}']);
    expect(result.operations).toHaveLength(1);
    expect(result.explanation).toBe("made it");
  });

  it("throws the server's error message on an error frame", async () => {
    mockFetchSse([["error", { error: "operations failed validation" }]]);
    await expect(
      streamGenerate("x", emptyWorkspace, () => {}, undefined, undefined, undefined),
    ).rejects.toThrow(/validation/);
  });

  it("a missing done frame is a failure, not silence", async () => {
    mockFetchSse([["delta", { text: "partial" }]]);
    await expect(
      streamGenerate("x", emptyWorkspace, () => {}, undefined, undefined, undefined),
    ).rejects.toThrow(/without a result/);
  });

  it("skips an unparsable frame without losing the terminal one", async () => {
    // Hand-rolled body: one broken data line, then a good done.
    const raw =
      'event: delta\ndata: {not json}\n\nevent: done\ndata: {"operations":[],"explanation":null}\n\n';
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(c) {
                c.enqueue(new TextEncoder().encode(raw));
                c.close();
              },
            }),
            { status: 200 },
          ),
      ),
    );
    const result = await streamGenerate(
      "x",
      emptyWorkspace,
      () => {},
      undefined,
      undefined,
      undefined,
    );
    expect(result.operations).toEqual([]);
  });

  it("delivers progressive phase events to onPhase callback (UX-P1-004)", async () => {
    mockFetchSse([
      ["start", { provider: "mock" }],
      ["phase", { phase: "understanding", message: "Parsing intent..." }],
      ["phase", { phase: "constructing", message: "Designing architecture..." }],
      ["delta", { text: '{"ops":[]}' }],
      ["phase", { phase: "validating", message: "Optimizing layout..." }],
      ["phase", { phase: "applying", message: "Rendering nodes..." }],
      ["done", { operations: [], explanation: "done", provider: "mock" }],
    ]);
    const phases: string[] = [];
    const result = await streamGenerate(
      "x",
      emptyWorkspace,
      () => {},
      undefined,
      undefined,
      undefined,
      undefined,
      (phase) => phases.push(phase),
    );
    expect(phases).toEqual(["understanding", "constructing", "validating", "applying"]);
    expect(result.explanation).toBe("done");
  });
});
