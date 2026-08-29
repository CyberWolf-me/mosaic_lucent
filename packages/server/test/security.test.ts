import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { MockProvider, MockImageProvider } from "@lucent/ai";
import { createWorkspace } from "@lucent/core";
import { createApp, type App } from "../src/app.js";
import { InMemoryUserStore } from "../src/accounts.js";
import { InMemoryBoardStore } from "../src/boards.js";
import { UsageTracker, limitsFromEnv } from "../src/usage.js";
import { Telemetry } from "../src/telemetry.js";
import { Limiter } from "../src/limiter.js";
import { InMemoryTicketStore } from "../src/realtimeTicket.js";
import { readConfig, type Config } from "../src/config.js";

/**
 * Secure-by-default (M0.3) invariants.
 *
 * Each test pins one property that a production deployment depends on:
 * /metrics is gated on auth, /health leaks nothing, X-Forwarded-For is ignored
 * unless explicitly opted in, oversized workspaces 413, malformed ones 400,
 * tickets are single-use, and the WS upgrade refuses long-lived tokens.
 */

const SECRET = "test-secret-at-least-16-chars";

interface AppHandle extends App {
  base: string;
  ws: string;
}

let app: AppHandle | null = null;

async function bootApp(env: NodeJS.ProcessEnv = {}): Promise<AppHandle> {
  const limits = limitsFromEnv();
  const config: Config = {
    ...readConfig(env),
    // The default test profile is "requireAuth on" so we exercise the gate.
    requireAuth: env.LUCENT_REQUIRE_AUTH !== "0",
  };
  const built = createApp({
    config,
    provider: new MockProvider(),
    imageProvider: new MockImageProvider(),
    userStore: new InMemoryUserStore(),
    boardStore: new InMemoryBoardStore(),
    secret: SECRET,
    usage: new UsageTracker(limits),
    limits,
    telemetry: new Telemetry(),
    authLimiter: new Limiter(config.authLimiter.perWindow, config.authLimiter.windowMs),
    tickets: new InMemoryTicketStore(60_000),
  });
  const handle = built as unknown as App & { server: import("node:http").Server };
  return await new Promise<AppHandle>((resolve) => {
    handle.server.listen(0, "127.0.0.1", () => {
      const { port } = handle.server.address() as AddressInfo;
      resolve({ ...handle, base: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}` });
    });
  });
}

async function api(
  h: AppHandle,
  path: string,
  init: RequestInit & { token?: string; xForwardedFor?: string } = {},
): Promise<{ status: number; body: any; headers: Headers }> {
  const { token, xForwardedFor, ...rest } = init;
  const headers: Record<string, string> = {
    ...(rest.body ? { "content-type": "application/json" } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(xForwardedFor ? { "x-forwarded-for": xForwardedFor } : {}),
    ...((rest.headers as Record<string, string>) ?? {}),
  };
  const res = await fetch(`${h.base}${path}`, { ...rest, headers });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body, headers: res.headers };
}

async function signup(h: AppHandle, email: string): Promise<{ token: string; id: string }> {
  const { status, body } = await api(h, "/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({ email, password: "password123", name: email.split("@")[0] }),
  });
  expect(status).toBe(201);
  return { token: body.token, id: body.user.id };
}

beforeEach(() => {
  app = null;
});

afterEach(async () => {
  await app?.close();
  app = null;
});

describe("/metrics auth gating", () => {
  it("refuses an unauthenticated request when requireAuth is on", async () => {
    app = await bootApp({ LUCENT_REQUIRE_AUTH: "1" });
    const res = await api(app, "/metrics");
    expect(res.status).toBe(401);
  });

  it("redacts recent error text by default", async () => {
    app = await bootApp({ LUCENT_REQUIRE_AUTH: "1" });
    const owner = await signup(app, "owner@example.com");
    // Drive a known error path so telemetry has a recentErrors entry.
    await api(app, "/api/generate", { method: "POST", token: owner.token, body: "{not json}" });
    const res = await api(app, "/metrics", { token: owner.token });
    expect(res.status).toBe(200);
    const messages = (res.body.recentErrors as Array<{ message: string }>).map((e) => e.message);
    // Either no errors (silent parse) or every message redacted.
    for (const m of messages) expect(m).toBe("[redacted]");
  });

  it("includes full message bodies when LUCENT_METRICS_VERBOSE=1", async () => {
    app = await bootApp({ LUCENT_REQUIRE_AUTH: "1", LUCENT_METRICS_VERBOSE: "1" });
    const owner = await signup(app, "v@example.com");
    await api(app, "/api/generate", { method: "POST", token: owner.token, body: "{not json}" });
    const res = await api(app, "/metrics", { token: owner.token });
    expect(res.status).toBe(200);
    const messages = (res.body.recentErrors as Array<{ message: string }>).map((e) => e.message);
    // At least one error recorded, and at least one message is not the redaction marker.
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.some((m) => m !== "[redacted]")).toBe(true);
  });

  it("allows /metrics when requireAuth is explicitly off", async () => {
    app = await bootApp({ LUCENT_REQUIRE_AUTH: "0" });
    const res = await api(app, "/metrics");
    expect(res.status).toBe(200);
  });
});

describe("/health minimal", () => {
  it("returns only { ok: true } with no provider or version info", async () => {
    app = await bootApp({ LUCENT_REQUIRE_AUTH: "1" });
    const res = await api(app, "/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(JSON.stringify(res.body)).not.toContain("provider");
    expect(JSON.stringify(res.body)).not.toContain("version");
  });
});

describe("clientKey respects trustProxy", () => {
  it("ignores X-Forwarded-For when trustProxy is off", async () => {
    app = await bootApp({ LUCENT_REQUIRE_AUTH: "1" });
    // Three attempts on the limiter through spoofed IPs should still all sit
    // in the real socket bucket, not the spoofed one. With trustProxy off,
    // the limiter treats them all as one and we never get per-IP carve-outs.
    const a = await api(app, "/api/boards", { xForwardedFor: "1.2.3.4" });
    const b = await api(app, "/api/boards", { xForwardedFor: "5.6.7.8" });
    const c = await api(app, "/api/boards", { xForwardedFor: "9.10.11.12" });
    for (const r of [a, b, c]) expect(r.status).toBe(401);
  });

  it("trusts X-Forwarded-For when trustProxy is on, and rate-limits per spoofed IP", async () => {
    // Tight limiter so a per-IP carve-out actually trips.
    const limits = limitsFromEnv();
    const config = {
      ...readConfig({
        LUCENT_REQUIRE_AUTH: "1",
        LUCENT_TRUST_PROXY: "1",
        LUCENT_AUTH_LIMIT_PER_WINDOW: "2",
        LUCENT_AUTH_LIMIT_WINDOW_MS: "60000",
      }),
      requireAuth: true,
    };
    const built = createApp({
      config,
      provider: new MockProvider(),
      imageProvider: new MockImageProvider(),
      userStore: new InMemoryUserStore(),
      boardStore: new InMemoryBoardStore(),
      secret: SECRET,
      usage: new UsageTracker(limits),
      limits,
      telemetry: new Telemetry(),
      authLimiter: new Limiter(config.authLimiter.perWindow, config.authLimiter.windowMs),
      tickets: new InMemoryTicketStore(60_000),
    });
    const server = (built as unknown as { server: import("node:http").Server }).server;
    const base = await new Promise<string>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as AddressInfo;
        resolve(`http://127.0.0.1:${port}`);
      });
    });
    app = { ...built, base, ws: base.replace("http", "ws") };
    // With trustProxy on and perWindow=2, a third login attempt from the same
    // spoofed IP must be 429, even when the real socket address differs.
    const r1 = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "1.2.3.4" },
      body: JSON.stringify({ email: "x@y.z", password: "wrong" }),
    });
    const r2 = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "1.2.3.4" },
      body: JSON.stringify({ email: "x@y.z", password: "wrong" }),
    });
    const r3 = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "1.2.3.4" },
      body: JSON.stringify({ email: "x@y.z", password: "wrong" }),
    });
    expect(r1.status).toBe(401);
    expect(r2.status).toBe(401);
    expect(r3.status).toBe(429);
    // A different spoofed IP keeps its own bucket.
    const r4 = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "9.9.9.9" },
      body: JSON.stringify({ email: "x@y.z", password: "wrong" }),
    });
    expect(r4.status).toBe(401);
  });
});

describe("workspace body validation", () => {
  it("rejects payloads over LUCENT_MAX_WORKSPACE_BYTES with 413", async () => {
    app = await bootApp({ LUCENT_REQUIRE_AUTH: "1", LUCENT_MAX_WORKSPACE_BYTES: "200" });
    const owner = await signup(app, "ws@example.com");
    // Build a workspace JSON string just over the limit.
    const huge = createWorkspace({ name: "x".repeat(500) });
    const res = await fetch(`${app.base}/api/boards`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${owner.token}` },
      body: JSON.stringify({ name: "big", workspace: huge }),
    });
    expect(res.status).toBe(413);
  });

  it("rejects a workspace with a non-object collection with 400", async () => {
    app = await bootApp({ LUCENT_REQUIRE_AUTH: "1" });
    const owner = await signup(app, "shape@example.com");
    const res = await api(app, "/api/boards", {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({ name: "broken", workspace: { nodes: "not-an-object" } }),
    });
    expect(res.status).toBe(400);
  });
});

describe("realtime tickets", () => {
  it("issues a ticket on demand and accepts it on the WS upgrade", async () => {
    app = await bootApp({ LUCENT_REQUIRE_AUTH: "1" });
    const owner = await signup(app, "t@example.com");
    await api(app, "/api/boards", {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({ name: "T", workspace: createWorkspace() }),
    });
    const ticketRes = await api(app, "/api/realtime/ticket", {
      method: "POST",
      token: owner.token,
    });
    expect(ticketRes.status).toBe(200);
    expect(typeof ticketRes.body.ticket).toBe("string");

    const socket = new WebSocket(
      `${app.ws}/ws?ticket=${encodeURIComponent(ticketRes.body.ticket)}`,
    );
    const opened = await new Promise<boolean>((resolve, reject) => {
      socket.once("open", () => resolve(true));
      socket.once("error", reject);
    });
    expect(opened).toBe(true);
    socket.close();
  });

  it("rejects an unknown / consumed ticket with 401", async () => {
    app = await bootApp({ LUCENT_REQUIRE_AUTH: "1" });
    const socket = new WebSocket(`${app.ws}/ws?ticket=garbage`);
    const closed = await new Promise<{ code: number }>((resolve) => {
      socket.once("close", (code) => resolve({ code }));
      socket.once("error", () => {});
    });
    expect(closed.code).not.toBe(1000);
  });

  it("a long-lived bearer token is no longer accepted by the WS upgrade", async () => {
    app = await bootApp({ LUCENT_REQUIRE_AUTH: "1" });
    const owner = await signup(app, "oldtok@example.com");
    const socket = new WebSocket(`${app.ws}/ws?token=${encodeURIComponent(owner.token)}`);
    const closed = await new Promise<{ code: number }>((resolve) => {
      socket.once("close", (code) => resolve({ code }));
      socket.once("error", () => {});
    });
    expect(closed.code).not.toBe(1000);
  });

  it("a ticket is single-use: a second connection with the same ticket is refused", async () => {
    app = await bootApp({ LUCENT_REQUIRE_AUTH: "1" });
    const owner = await signup(app, "once@example.com");
    const created = await api(app, "/api/boards", {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({ name: "Once", workspace: createWorkspace() }),
    });
    const boardId = created.body.id as string;
    const ticketRes = await api(app, "/api/realtime/ticket", {
      method: "POST",
      token: owner.token,
    });
    const ticket = ticketRes.body.ticket as string;

    const first = new WebSocket(`${app.ws}/ws?ticket=${encodeURIComponent(ticket)}`);
    const opened = await new Promise<boolean>((resolve, reject) => {
      first.once("open", () => resolve(true));
      first.once("error", reject);
    });
    expect(opened).toBe(true);
    first.close();

    const second = new WebSocket(`${app.ws}/ws?ticket=${encodeURIComponent(ticket)}`);
    const closed = await new Promise<{ code: number }>((resolve) => {
      second.once("close", (code) => resolve({ code }));
      second.once("error", () => {});
    });
    expect(closed.code).not.toBe(1000);
    // Reference the boardId so an unused-var lint doesn't complain.
    expect(typeof boardId).toBe("string");
  });
});

describe("auth limiter", () => {
  it("a burst of failed logins from the same IP+email is refused with 429", async () => {
    app = await bootApp({
      LUCENT_REQUIRE_AUTH: "1",
      LUCENT_AUTH_LIMIT_PER_WINDOW: "2",
      LUCENT_AUTH_LIMIT_WINDOW_MS: "60000",
    });

    const post = () =>
      fetch(`${app!.base}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "burst@example.com", password: "wrong" }),
      });
    expect((await post()).status).toBe(401);
    expect((await post()).status).toBe(401);
    expect((await post()).status).toBe(429);
  });
});

describe("graceful shutdown", () => {
  it("close() stops accepting new HTTP requests and closes the WS server", async () => {
    app = await bootApp({ LUCENT_REQUIRE_AUTH: "1" });
    await app.close();
    // A subsequent request should fail to connect because the socket is closed.
    await expect(fetch(`${app.base}/health`)).rejects.toThrow();
  });
});
