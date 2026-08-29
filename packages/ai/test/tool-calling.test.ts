import { describe, it, expect, vi } from "vitest";
import { AnthropicProvider, OpenAICompatibleProvider, parseToolArguments } from "../src/index.js";
import { summarizeWorkspace } from "../src/index.js";
import { createWorkspace, TOOL_NAME } from "@lucent/core";

/**
 * Providers now request a real tool call, so the operation payload arrives as
 * structured arguments validated against the generated JSON Schema instead of
 * being scraped out of prose. These tests pin the tool request wiring, the
 * tool-call response path, and the prose fallback for gateways that ignore
 * tool definitions.
 */

const request = {
  message: "add a sticky note",
  summary: summarizeWorkspace(createWorkspace()),
};

const OPS = [{ op: "CREATE_NODE", id: "a", nodeType: "note", label: "A" }];

function jsonResponse(status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function openAiToolResponse(args: unknown) {
  return jsonResponse(200, {
    choices: [
      {
        message: {
          tool_calls: [
            {
              function: {
                name: TOOL_NAME,
                arguments: typeof args === "string" ? args : JSON.stringify(args),
              },
            },
          ],
        },
      },
    ],
  });
}

function makeOpenAi(fetchImpl: typeof fetch) {
  return new OpenAICompatibleProvider({
    apiKey: "k",
    baseUrl: "https://gw/v1/chat/completions",
    model: "m",
    fetchImpl,
    maxRetries: 1,
  });
}

describe("OpenAI-compatible tool calling", () => {
  it("sends the generated tool definition and asks for that tool", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(openAiToolResponse({ operations: OPS, explanation: "ok" }));
    await makeOpenAi(fetchImpl).generateOperations(request);

    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].type).toBe("function");
    expect(body.tools[0].function.name).toBe(TOOL_NAME);
    expect(body.tool_choice).toEqual({ type: "function", function: { name: TOOL_NAME } });
    // The shape operations must be advertised in the schema we send.
    expect(JSON.stringify(body.tools[0].function.parameters)).toContain("CREATE_SHAPE");
  });

  it("reads operations from the tool call", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(openAiToolResponse({ operations: OPS, explanation: "made a node" }));
    const result = await makeOpenAi(fetchImpl).generateOperations(request);
    expect(result.operations).toHaveLength(1);
    expect(result.explanation).toBe("made a node");
  });

  it("accepts an empty operations array as a question answer", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(openAiToolResponse({ operations: [], explanation: "3 nodes." }));
    const result = await makeOpenAi(fetchImpl).generateOperations(request);
    expect(result.operations).toEqual([]);
    expect(result.explanation).toBe("3 nodes.");
  });

  it("accepts shape operations, which the old prompt never advertised", async () => {
    const shapeOps = [
      {
        op: "CREATE_SHAPE",
        id: "s1",
        kind: "sticky",
        position: { x: 80, y: 80 },
        size: { width: 150, height: 110 },
        text: "Check refunds",
      },
    ];
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(openAiToolResponse({ operations: shapeOps }));
    const result = await makeOpenAi(fetchImpl).generateOperations(request);
    expect(result.operations[0]?.op).toBe("CREATE_SHAPE");
  });

  it("rejects invalid operations from a tool call", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(openAiToolResponse({ operations: [{ op: "NOT_A_REAL_OP" }] }));
    await expect(makeOpenAi(fetchImpl).generateOperations(request)).rejects.toThrow(
      /invalid operations/i,
    );
  });

  it("reports unparseable tool arguments clearly", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(openAiToolResponse("{not json"));
    await expect(makeOpenAi(fetchImpl).generateOperations(request)).rejects.toThrow(
      /not valid JSON/i,
    );
  });

  it("falls back to prose for a gateway that ignores tool definitions", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(200, {
        choices: [
          {
            message: {
              content: `Sure:\n${JSON.stringify({ operations: OPS, explanation: "via text" })}`,
            },
          },
        ],
      }),
    );
    const result = await makeOpenAi(fetchImpl).generateOperations(request);
    expect(result.operations).toHaveLength(1);
    expect(result.explanation).toBe("via text");
  });

  it("errors when the response has neither a tool call nor content", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, { choices: [{ message: {} }] }));
    await expect(makeOpenAi(fetchImpl).generateOperations(request)).rejects.toThrow(
      /neither a tool call nor content/i,
    );
  });
});

describe("Anthropic tool calling", () => {
  function makeAnthropic(fetchImpl: typeof fetch) {
    return new AnthropicProvider({ apiKey: "k", baseUrl: "https://api/x", fetchImpl });
  }

  it("sends the tool definition with input_schema and forces the tool", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(200, {
        content: [{ type: "tool_use", name: TOOL_NAME, input: { operations: OPS } }],
      }),
    );
    await makeAnthropic(fetchImpl).generateOperations(request);

    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body.tools[0].name).toBe(TOOL_NAME);
    expect(body.tools[0].input_schema).toBeDefined();
    expect(body.tool_choice).toEqual({ type: "tool", name: TOOL_NAME });
    expect(body.max_tokens).toBeGreaterThan(2048);
  });

  it("reads operations from a tool_use block", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(200, {
        content: [
          { type: "text", text: "thinking" },
          { type: "tool_use", name: TOOL_NAME, input: { operations: OPS, explanation: "done" } },
        ],
      }),
    );
    const result = await makeAnthropic(fetchImpl).generateOperations(request);
    expect(result.operations).toHaveLength(1);
    expect(result.explanation).toBe("done");
  });

  it("falls back to a text block when no tool_use is returned", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(200, {
        content: [{ type: "text", text: JSON.stringify({ operations: OPS }) }],
      }),
    );
    const result = await makeAnthropic(fetchImpl).generateOperations(request);
    expect(result.operations).toHaveLength(1);
  });
});

describe("parseToolArguments", () => {
  it("accepts an already-parsed object", () => {
    expect(parseToolArguments({ operations: OPS }).operations).toHaveLength(1);
  });

  it("defaults a missing operations field to empty", () => {
    expect(parseToolArguments({ explanation: "just answering" }).operations).toEqual([]);
  });

  it("ignores a non-string explanation", () => {
    expect(parseToolArguments({ operations: [], explanation: 42 }).explanation).toBeUndefined();
  });
});
