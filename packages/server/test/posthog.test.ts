import { describe, expect, it } from "vitest";
import { createPostHogSink } from "../src/posthog.js";
import type { TelemetryEvent } from "../src/telemetry.js";

describe("PostHog Server Telemetry Sink", () => {
  it("formats and forwards telemetry events to PostHog capture endpoint", async () => {
    const calls: Array<{ url: string; body: any }> = [];
    const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body)),
      });
      return new Response(JSON.stringify({ status: "Ok" }), { status: 200 });
    }) as unknown as typeof fetch;

    const sink = createPostHogSink(
      {
        apiKey: "phc_test_token_123",
        host: "https://us.i.posthog.com",
      },
      mockFetch,
    );

    // 1. ai generation event
    sink({
      kind: "generate",
      ms: 1250,
      provider: "deepseek-v4",
      operations: 14,
      outcome: "success",
      repaired: false,
      requestId: "req_gen_1",
    });

    // 2. product event
    sink({
      kind: "product",
      event: "board_created",
    });

    // 3. time to first board
    sink({
      kind: "timeToFirstBoard",
      seconds: 42,
    });

    // 4. ask event
    sink({
      kind: "ask",
      ms: 800,
      provider: "deepseek-v4",
      citations: 3,
      requestId: "req_ask_1",
    });

    // 5. server error
    sink({
      kind: "error",
      route: "/api/generate",
      status: 500,
      message: "Unexpected error",
      requestId: "req_err_1",
    });

    expect(calls).toHaveLength(5);

    // Check ai_generation
    expect(calls[0]!.url).toBe("https://us.i.posthog.com/capture/");
    expect(calls[0]!.body.api_key).toBe("phc_test_token_123");
    expect(calls[0]!.body.event).toBe("ai_generation");
    expect(calls[0]!.body.distinct_id).toBe("lucent-server");
    expect(calls[0]!.body.properties).toMatchObject({
      duration_ms: 1250,
      provider: "deepseek-v4",
      operations_count: 14,
      outcome: "success",
      repaired: false,
      request_id: "req_gen_1",
      $lib: "lucent-server",
    });

    // Check board_created
    expect(calls[1]!.body.event).toBe("board_created");

    // Check time_to_first_board
    expect(calls[2]!.body.event).toBe("time_to_first_board");
    expect(calls[2]!.body.properties.seconds).toBe(42);

    // Check board_ask
    expect(calls[3]!.body.event).toBe("board_ask");
    expect(calls[3]!.body.properties.citations_count).toBe(3);

    // Check server_error
    expect(calls[4]!.body.event).toBe("server_error");
    expect(calls[4]!.body.properties.status).toBe(500);
  });

  it("handles fetch rejection gracefully without throwing", () => {
    const failingFetch = (async () => {
      throw new Error("Network unreachable");
    }) as unknown as typeof fetch;

    const sink = createPostHogSink(
      {
        apiKey: "phc_test_token",
        host: "https://us.i.posthog.com",
      },
      failingFetch,
    );

    expect(() => {
      sink({
        kind: "product",
        event: "board_created",
      });
    }).not.toThrow();
  });
});
