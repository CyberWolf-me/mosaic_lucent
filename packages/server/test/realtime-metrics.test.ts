import { describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { MockProvider, MockImageProvider } from "@lucent/ai";
import { createApp } from "../src/app.js";
import { InMemoryUserStore } from "../src/accounts.js";
import { InMemoryBoardStore, emptyWorkspace, newBoardId } from "../src/boards.js";
import { InMemorySessionStore } from "../src/sessions.js";
import { UsageTracker, limitsFromEnv } from "../src/usage.js";
import { Telemetry } from "../src/telemetry.js";
import { Limiter } from "../src/limiter.js";
import { InMemoryTicketStore } from "../src/realtimeTicket.js";
import { readConfig } from "../src/config.js";

/**
 * The realtime-reachability SLO's metric (docs/reliability/slo.md): one
 * observation per finished WebSocket connection, in seconds.
 *
 * The SLO document's own rule is "if the metric does not exist, the SLO does
 * not exist" — this test is what keeps that rule honest. It boots the real
 * app, signs up over HTTP, mints a realtime ticket through the real route,
 * opens a socket, joins a board, closes it, and asserts the histogram
 * appears on the Prometheus surface with a count for the closed connection.
 *
 * The signup → ticket path (rather than a hand-minted ticket) matters: the
 * app owns its ticket store, so an externally minted ticket is a 401 and the
 * socket never opens.
 */

const SECRET = "test-secret-at-least-16-chars";
const ORIGIN = "http://localhost:5173";

describe("lucent_realtime_connection_duration_seconds", () => {
  it("observes one closed connection on the Prometheus surface", async () => {
    const limits = limitsFromEnv();
    const config = readConfig({ LUCENT_REQUIRE_AUTH: "1", LUCENT_WEB_ORIGIN: ORIGIN });
    const userStore = new InMemoryUserStore();
    const boardStore = new InMemoryBoardStore();
    const { server, realtime, close } = createApp({
      config,
      provider: new MockProvider(),
      imageProvider: new MockImageProvider(),
      userStore,
      boardStore,
      secret: SECRET,
      usage: new UsageTracker(limits),
      limits,
      telemetry: new Telemetry(),
      authLimiter: new Limiter(1000, 60_000),
      tickets: new InMemoryTicketStore(60_000),
      sessionStore: new InMemorySessionStore(),
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    // Sign up over the real route; the bearer token is the `token` in the body.
    const signupRes = await fetch(`${base}/api/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "metric@example.com",
        password: "password123",
        name: "Metric",
      }),
    });
    expect(signupRes.status).toBe(201);
    const signupBody = (await signupRes.json()) as {
      token?: string;
      user: { id: string };
      memberships: Array<{ orgId: string }>;
    };
    const token = signupBody.token;
    if (!token) throw new Error("signup did not return a bearer token");
    const orgId = signupBody.memberships[0]!.orgId;

    // A board in that org, created through the same store the app reads.
    const boardId = newBoardId();
    await boardStore.put({
      id: boardId,
      ownerId: signupBody.user.id,
      orgId,
      name: "Metric board",
      workspace: emptyWorkspace("Metric board"),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // The single-use ticket the WS upgrade consumes.
    const ticketRes = await fetch(`${base}/api/realtime/ticket`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    });
    expect(ticketRes.status).toBe(200);
    const { ticket } = (await ticketRes.json()) as { ticket: string };

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${encodeURIComponent(ticket)}`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    ws.send(JSON.stringify({ type: "join", boardId }));
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    ws.close();
    // Give the server's close handler a beat to run.
    await new Promise<void>((resolve) => setTimeout(resolve, 200));

    const res = await fetch(`${base}/metrics/prometheus`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const text = await res.text();
    expect(text).toContain("lucent_realtime_connection_duration_seconds_bucket");
    const countLine = text
      .split("\n")
      .find((l) => l.startsWith("lucent_realtime_connection_duration_seconds_count"));
    expect(countLine).toBeTruthy();
    const count = countLine ? Number(countLine.split(" ")[1]) : 0;
    expect(count).toBeGreaterThanOrEqual(1);

    realtime.close();
    await close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
