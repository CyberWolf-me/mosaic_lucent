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
