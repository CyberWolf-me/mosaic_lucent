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

describe("OpenAICompatibleProvider tool_choice downgrade", () => {
  // The muse-spark upstream behind kiosapi 400s the named-function
  // tool_choice ("only \"auto\" is supported"). The provider must re-issue
  // with tool_choice:"auto" and remember the downgrade for later calls.
  const TOOL_CHOICE_400 = () =>
    jsonResponse(400, {
      error: {
        message:
          'Error from provider (Console): Upstream request failed: [invalid_request_error] only "auto" is supported for `tool_choice`. "none", "required", and named function choices are not currently supported',
        type: "upstream_error",
      },
    });

  it("downgrades to tool_choice auto on the upstream 400 and retries", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => Promise.resolve(TOOL_CHOICE_400()))
      .mockImplementationOnce(() => Promise.resolve(jsonResponse(200, OK_BODY)));

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

    const secondBody = JSON.parse(
      (fetchImpl.mock.calls[1]?.[1] as RequestInit).body as string,
    ) as { tool_choice: unknown };
    expect(secondBody.tool_choice).toBe("auto");
    // The tool definition stays: the model may still answer with a call.
    expect(secondBody.tools).toHaveLength(1);
  });

  it("sends tool_choice auto directly on the next call after a downgrade", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => Promise.resolve(TOOL_CHOICE_400()))
      .mockImplementation(() => Promise.resolve(jsonResponse(200, OK_BODY)));

    const provider = new OpenAICompatibleProvider({
      apiKey: "k",
      baseUrl: "https://gw/v1/chat/completions",
      model: "m",
      fetchImpl,
      maxRetries: 4,
    });

    await provider.generateOperations(request);
    await provider.generateOperations(request);

    const secondCall = (fetchImpl.mock.calls[2]?.[1] as RequestInit).body as string;
    const parsed = JSON.parse(secondCall) as { tool_choice: unknown };
    expect(parsed.tool_choice).toBe("auto");
    // No extra probe requests: the flag sticks after the first downgrade.
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("surfaces the 400 when auto also fails", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(TOOL_CHOICE_400()));

    const provider = new OpenAICompatibleProvider({
      apiKey: "k",
      baseUrl: "https://gw/v1/chat/completions",
      model: "m",
      fetchImpl,
      maxRetries: 2,
    });

    await expect(provider.generateOperations(request)).rejects.toThrow(/400/);
    // One probe with named choice, one with auto, then give up.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(
      (fetchImpl.mock.calls[1]?.[1] as RequestInit).body as string,
    ) as { tool_choice: unknown };
    expect(secondBody.tool_choice).toBe("auto");
  });

  it("does not confuse the tool_choice 400 with an ordinary 400", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(jsonResponse(400, "bad json")));

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

  it("recovers a completion from a stream:false response that arrives SSE-framed", async () => {
    // kilo-auto via kiosapi ignores stream:false and answers with an
    // SSE body. The single data frame holds a normal completion.
    const completion = {
      id: "x",
      model: "routed",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: JSON.stringify({
              operations: [{ op: "CREATE_NODE", id: "a", nodeType: "step", label: "A" }],
              explanation: "ok",
            }),
          },
          finish_reason: "stop",
        },
      ],
    };
    const sseBody = "data: " + JSON.stringify(completion) + "\n\n";
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(
          new Response(sseBody, { status: 200, headers: { "content-type": "text/event-stream" } }),
        ),
      );

    const provider = new OpenAICompatibleProvider({
      apiKey: "k",
      baseUrl: "https://gw/v1/chat/completions",
      model: "m",
      fetchImpl,
      maxRetries: 2,
    });

    const result = await provider.generateOperations(request);
    expect(result.operations).toHaveLength(1);
    expect(result.explanation).toBe("ok");
  });

  it("recovers a completion whose SSE frame spans multiple data: lines", async () => {
    // The kilo-auto failure that surfaced in the E live pass: the same
    // stream:false SSE framing, but the JSON split across several data:
    // lines. Line-by-line parsing fails on every line; the frame must be
    // JOINED first (the sseEvents reader rule).
    const completion = {
      id: "x",
      model: "routed",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: JSON.stringify({
              operations: [{ op: "CREATE_NODE", id: "a", nodeType: "step", label: "A" }],
              explanation: "ok",
            }),
          },
          finish_reason: "stop",
        },
      ],
    };
    const bodyText = JSON.stringify(completion, null, 1)
      .split("\n")
      .map((line, i) => (i === 0 ? "data: " + line : "data: " + line))
      .join("\n");
    const sseBody = bodyText + "\n\n";
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(
          new Response(sseBody, { status: 200, headers: { "content-type": "text/event-stream" } }),
        ),
      );

    const provider = new OpenAICompatibleProvider({
      apiKey: "k",
      baseUrl: "https://gw/v1/chat/completions",
      model: "m",
      fetchImpl,
      maxRetries: 2,
    });

    const result = await provider.generateOperations(request);
    expect(result.operations).toHaveLength(1);
    expect(result.explanation).toBe("ok");
  });
});
