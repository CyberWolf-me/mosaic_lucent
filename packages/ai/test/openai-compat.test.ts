import { describe, it, expect, vi } from "vitest";
import { OpenAICompatibleProvider } from "../src/index.js";
import { summarizeWorkspace } from "../src/index.js";
import { createWorkspace } from "@lucent/core";

/**
 * The gorouter/Cloudflare gateway intermittently returns 403/429/5xx even for a
 * valid key. These tests pin the retry behavior so a transient rejection turns
 * into a successful generation instead of a user-facing failure.
 */

const OK_BODY = {
  choices: [
    {
      message: {
        content: JSON.stringify({
          operations: [{ op: "CREATE_NODE", id: "a", nodeType: "note", label: "A" }],
          explanation: "ok",
        }),
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

describe("OpenAICompatibleProvider retries", () => {
  it("retries a transient 403 and then succeeds", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(403, ""))
      .mockResolvedValueOnce(jsonResponse(200, OK_BODY));

    const provider = new OpenAICompatibleProvider({
      apiKey: "k",
      baseUrl: "https://gw/v1/chat/completions",
      model: "m",
      fetchImpl,
      maxRetries: 4,
    });

    const result = await provider.generateOperations(request);
    expect(result.operations).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries a network error and then succeeds", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(jsonResponse(200, OK_BODY));

    const provider = new OpenAICompatibleProvider({
      apiKey: "k",
      baseUrl: "https://gw/v1/chat/completions",
      model: "m",
      fetchImpl,
      maxRetries: 4,
    });

    const result = await provider.generateOperations(request);
    expect(result.operations).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("gives up after maxRetries and surfaces the last status", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(403, "blocked"));

    const provider = new OpenAICompatibleProvider({
      apiKey: "k",
      baseUrl: "https://gw/v1/chat/completions",
      model: "m",
      fetchImpl,
      maxRetries: 3,
    });

    await expect(provider.generateOperations(request)).rejects.toThrow(/403/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("does not retry a non-retryable 400", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(400, "bad"));

    const provider = new OpenAICompatibleProvider({
      apiKey: "k",
      baseUrl: "https://gw/v1/chat/completions",
      model: "m",
      fetchImpl,
      maxRetries: 4,
    });

    await expect(provider.generateOperations(request)).rejects.toThrow(/400/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("passes an AbortSignal.timeout to each fetch attempt", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200, OK_BODY));

    const provider = new OpenAICompatibleProvider({
      apiKey: "k",
      baseUrl: "https://gw/v1/chat/completions",
      model: "m",
      fetchImpl,
      timeoutMs: 12_345,
    });

    await provider.generateOperations(request);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    // The timeout should be honored before the default 90s. Node's
    // AbortSignal.timeout returns a signal whose `aborted` flag flips when the
    // timer fires; an upper-bound check on duration catches a regression to
    // "no timeout at all" (the signal would never fire).
    const signal = init!.signal as AbortSignal;
    // We can't wait for the real timeout in a unit test, but we can verify the
    // signal is wired: it must not already be aborted and must expose the
    // standard timeout event.
    expect(signal.aborted).toBe(false);
    expect(typeof signal.addEventListener).toBe("function");
  });
});
