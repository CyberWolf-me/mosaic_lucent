import type { TelemetryEvent } from "./telemetry.js";

export interface PostHogConfig {
  apiKey: string;
  host: string;
}

export interface PostHogCapturePayload {
  api_key: string;
  event: string;
  distinct_id: string;
  properties: Record<string, unknown>;
  timestamp?: string;
}

/**
 * Dependency-free PostHog capture sink for server telemetry events.
 *
 * Adheres strictly to security and privacy guidelines (docs/06):
 * - Prompts, board payloads, credentials, and user diagram content NEVER leave the server.
 * - Only operational and product signals (latencies, operation counts, outcome codes) are sent.
 * - Fire-and-forget: network errors are caught and never throw or block server requests.
 */
export function createPostHogSink(
  config: PostHogConfig,
  fetchFn: typeof fetch = globalThis.fetch,
): (event: TelemetryEvent) => void {
  const endpoint = `${config.host.replace(/\/+$/, "")}/capture/`;

  const send = (eventName: string, props: Record<string, unknown>, distinctId = "lucent-server") => {
    const payload: PostHogCapturePayload = {
      api_key: config.apiKey,
      event: eventName,
      distinct_id: distinctId,
      properties: {
        ...props,
        $lib: "lucent-server",
        $lib_version: "1.0.0",
      },
      timestamp: new Date().toISOString(),
    };

    fetchFn(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => {
      // Ignored: analytics vendor failures must never affect application execution.
    });
  };

  return (event: TelemetryEvent) => {
    switch (event.kind) {
      case "generate":
        send("ai_generation", {
          duration_ms: event.ms,
          provider: event.provider,
          operations_count: event.operations,
          outcome: event.outcome,
          repaired: event.repaired,
          request_id: event.requestId,
        });
        break;
      case "image":
        send("image_generation", {
          duration_ms: event.ms,
          provider: event.provider,
          request_id: event.requestId,
        });
        break;
      case "ask":
        send("board_ask", {
          duration_ms: event.ms,
          provider: event.provider,
          citations_count: event.citations,
          request_id: event.requestId,
        });
        break;
      case "ai-propose":
        send("ai_propose", {
          duration_ms: event.ms,
          provider: event.provider,
          candidates: event.candidates,
          selected: event.selected,
          request_id: event.requestId,
        });
        break;
      case "product":
        send(event.event, {});
        break;
      case "timeToFirstBoard":
        send("time_to_first_board", {
          seconds: event.seconds,
        });
        break;
      case "error":
        send("server_error", {
          route: event.route,
          status: event.status,
          request_id: event.requestId,
        });
        break;
      case "refused":
        send("request_refused", {
          route: event.route,
          reason: event.reason,
          request_id: event.requestId,
        });
        break;
    }
  };
}
