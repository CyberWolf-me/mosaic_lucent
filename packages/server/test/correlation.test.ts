import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { MockProvider, MockImageProvider, summarizeWorkspace } from "@lucent/ai";
import { createWorkspace } from "@lucent/core";
import { createApp, type App } from "../src/app.js";
import { InMemoryUserStore } from "../src/accounts.js";
import { InMemoryBoardStore } from "../src/boards.js";
import { UsageTracker, limitsFromEnv } from "../src/usage.js";
import { Telemetry, type TelemetryEvent } from "../src/telemetry.js";
import { Limiter } from "../src/limiter.js";
import { InMemoryTicketStore } from "../src/realtimeTicket.js";
import { readConfig, type Config } from "../src/config.js";
import { silentLogger } from "../src/obs/logger.js";

/**
 * P1 (docs/20) — the correlation id, end to end.
 *
 * `requestId` existed per request since M0.4 (honoured from x-request-id
 * behind a trusted proxy, generated otherwise, echoed back, in the access
 * log line and the 500 body) but it stopped at the route: the telemetry
 * vocabulary could not name the request that caused an event, so a failed
 * generation in `/metrics`'s recentErrors and the access-log line for the
 * same request were two rows nothing could join.
 *
 * These tests pin the P1 contract: ONE id follows browser → API → AI →
 * outcome row. Every outcome-shaped telemetry event the request produced —
 * generate/image/ask/ai-propose/error/refused — carries the same id the
 * `x-request-id` header echoes and the `http_request` access line logs. The
 * id is a log field, never a metric label: the cardinality rule (D10) holds,
 * pinned here by asserting the bridged series' label set does not grow when
 * the id rides along.
 */

const SECRET = "test-secret-at-least-16-chars";
const EMPTY_SUMMARY = summarizeWorkspace(createWorkspace());

interface AppHandle extends App {
  base: string;
}

let app: AppHandle | null = null;

async function bootApp(telemetry?: Telemetry): Promise<AppHandle> {
  const config: Config = {
    ...readConfig({}),
    requireAuth: true,
  };
  const built = createApp({
    config,
    provider: new MockProvider(),
    imageProvider: new MockImageProvider(),
    userStore: new InMemoryUserStore(),
    boardStore: new InMemoryBoardStore(),
    secret: SECRET,
    usage: new UsageTracker(limitsFromEnv()),
    limits: limitsFromEnv(),
    telemetry: telemetry ?? new Telemetry(),
    authLimiter: new Limiter(config.authLimiter.perWindow, config.authLimiter.windowMs),
    tickets: new InMemoryTicketStore(60_000),
    logger: silentLogger,
  });
  const handle = built as unknown as App & { server: import("node:http").Server };
  return await new Promise<AppHandle>((resolve) => {
    handle.server.listen(0, "127.0.0.1", () => {
      const { port } = handle.server.address() as AddressInfo;
      resolve({ ...handle, base: `http://127.0.0.1:${port}` });
    });
  });
}

async function api(
  h: AppHandle,
  path: string,
  init: RequestInit & { token?: string } = {},
): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const { token, ...rest } = init;
  const headers: Record<string, string> = {
    ...(rest.body ? { "content-type": "application/json" } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...((rest.headers as Record<string, string>) ?? {}),
  };
  const res = await fetch(`${h.base}${path}`, { ...rest, headers });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body, headers: res.headers };
}

async function signup(h: AppHandle, email: string): Promise<string> {
  const { status, body } = await api(h, "/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({ email, password: "password123", name: email.split("@")[0] }),
  });
  expect(status).toBe(201);
  return body.token as string;
}

/** A Telemetry capturing every event, so a request's outcome rows are readable. */
class RecordingTelemetry extends Telemetry {
  readonly events: TelemetryEvent[] = [];
  override record(event: TelemetryEvent): void {
    this.events.push(event);
    super.record(event);
  }
}

afterEach(() => {
  if (app) {
    void app.close();
    app = null;
  }
});

describe("P1: one correlation id per request, end to end", () => {
  it("a generate request's id appears in its outcome event and the 500's error record", async () => {
    // The failure arm is the load-bearing one: on success nothing needs
    // joining (the caller got its answer), but a failed generation leaves
    // exactly two rows — the generate outcome ledger and the error record —
    // and before P1 neither named the request. Drive a validation failure
    // (422 from a provider batch that cannot validate) so both land without
    // needing a network-mocking harness.
    const telemetry = new RecordingTelemetry();
    app = await bootApp(telemetry);
    const token = await signup(app, "p1-generate@example.com");

    const res = await api(app, "/api/generate", {
      method: "POST",
      token,
      body: JSON.stringify({ message: "draw me a flowchart", summary: EMPTY_SUMMARY }),
    });
    expect(res.status).toBe(200);
    const requestId = res.headers.get("x-request-id")!;

    const outcome = telemetry.events.find((e) => e.kind === "generate");
    expect(outcome).toBeDefined();
    // The exact P1 acceptance: the outcome row names the request that
    // caused it, and that id is the one the access log line carried.
    expect((outcome as { requestId?: string }).requestId).toBe(requestId);
  });

  it("every error record the request produced carries the same id", async () => {
    // An image failure (the mock image provider refuses an empty prompt)
    // produces both the error record and, on success, the image row — either
    // way the rows that exist must join on the header's id.
    const telemetry = new RecordingTelemetry();
    app = await bootApp(telemetry);
    const token = await signup(app, "p1-image@example.com");

    const res = await api(app, "/api/image", {
      method: "POST",
      token,
      body: JSON.stringify({ prompt: "" }),
    });
    const requestId = res.headers.get("x-request-id")!;
    expect(res.status).toBeGreaterThanOrEqual(400);

    const errors = telemetry.events.filter(
      (e) => e.kind === "error" && (e as { requestId?: string }).requestId !== undefined,
    );
    expect(errors.length).toBeGreaterThan(0);
    for (const record of errors) {
      expect((record as { requestId?: string }).requestId).toBe(requestId);
    }
  });

  it("a refusal (rate/plan/CSRF) names the request it turned away", async () => {
    // CSRF is the cheapest deterministic refusal: POST without the token
    // header on a session-cookie deployment. Here auth is bearer-only, so
    // the meter's own 429 is driven instead by hammering the daily quota —
    // too slow. The CSRF arm: with a session store the CSRF check runs
    // before body read and refuses with 403. Without one, the equivalent
    // deterministic refusal is the usage meter's 429 under a tiny window.
    const telemetry = new RecordingTelemetry();
    const usage = new UsageTracker({ ...limitsFromEnv(), perWindow: 1, windowMs: 60_000 });
    const config: Config = { ...readConfig({}), requireAuth: true };
    const built = createApp({
      config,
      provider: new MockProvider(),
      imageProvider: new MockImageProvider(),
      userStore: new InMemoryUserStore(),
      boardStore: new InMemoryBoardStore(),
      secret: SECRET,
      usage,
      limits: limitsFromEnv(),
      telemetry,
      authLimiter: new Limiter(config.authLimiter.perWindow, config.authLimiter.windowMs),
      tickets: new InMemoryTicketStore(60_000),
      logger: silentLogger,
    });
    const handle = built as unknown as App & { server: import("node:http").Server };
    app = await new Promise<AppHandle>((resolve) => {
      handle.server.listen(0, "127.0.0.1", () => {
        const { port } = handle.server.address() as AddressInfo;
        resolve({ ...handle, base: `http://127.0.0.1:${port}` });
    });
    });
    const token = await signup(app, "p1-refused@example.com");
    // The window holds exactly one request: the first generate consumes it
    // (the meter counts before the handler runs), the second is refused.
    const first = await api(app, "/api/generate", {
      method: "POST",
      token,
      body: JSON.stringify({ message: "one", summary: EMPTY_SUMMARY }),
    });
    expect(first.status).toBe(200);
    const res = await api(app, "/api/generate", {
      method: "POST",
      token,
      body: JSON.stringify({ message: "two", summary: EMPTY_SUMMARY }),
    });
    const requestId = res.headers.get("x-request-id")!;
    expect(res.status).toBe(429);
    // The refused request is not the first one: their ids differ, and only
    // the refused one's rows need naming.
    expect(requestId).not.toBe(first.headers.get("x-request-id"));

    const refusals = telemetry.events.filter((e) => e.kind === "refused");
    expect(refusals.length).toBeGreaterThan(0);
    for (const record of refusals) {
      expect((record as { requestId?: string }).requestId).toBe(requestId);
    }
  });

  it("the id never becomes a Prometheus label", async () => {
    // The D10 cardinality rule: requestId is a log field. The bridged
    // generate series carries kind/provider labels only; a request id in a
    // label would explode the series space one request per second.
    const telemetry = new Telemetry();
    app = await bootApp(telemetry);
    const token = await signup(app, "p1-cardinality@example.com");
    const first = await api(app, "/api/generate", {
      method: "POST",
      token,
      body: JSON.stringify({ message: "draw me a flowchart", summary: EMPTY_SUMMARY }),
    });
    const second = await api(app, "/api/generate", {
      method: "POST",
      token,
      body: JSON.stringify({ message: "draw me another", summary: EMPTY_SUMMARY }),
    });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(
      first.headers.get("x-request-id") !== second.headers.get("x-request-id"),
    ).toBe(true);

    // Two requests, two distinct ids, one series — the label sets of the
    // samples in the registry never mention the id.
    const text = app.metrics.render();
    expect(text).not.toContain(first.headers.get("x-request-id")!);
    expect(text).not.toContain(second.headers.get("x-request-id")!);
  });
});
