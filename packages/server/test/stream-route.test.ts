import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { MockProvider, MockImageProvider } from "@lucent/ai";
import { createApp } from "../src/app.js";
import { InMemoryUserStore } from "../src/accounts.js";
import { InMemoryBoardStore } from "../src/boards.js";
import { InMemoryOrgStore } from "../src/orgs.js";
import { InMemoryOrgInviteStore } from "../src/invites.js";
import { InMemoryNotificationStore } from "../src/notifications.js";
import { InMemorySessionStore } from "../src/sessions.js";
import { InMemoryUsageStore } from "../src/usageStore.js";
import { UsageTracker, limitsFromEnv } from "../src/usage.js";
import { Telemetry } from "../src/telemetry.js";
import { Limiter } from "../src/limiter.js";
import { InMemoryTicketStore } from "../src/realtimeTicket.js";
import { readConfig } from "../src/config.js";
import {
  BYO_KEY_HEADER,
  BYO_MODEL_HEADER,
  BYO_PROVIDER_HEADER,
  resolveProvider,
} from "../src/modelRouter.js";

/**
 * M5/E1 over HTTP: the model router and the SSE generation route.
 */

describe("modelRouter", () => {
  const defaultProvider = new MockProvider();

  it("answers with the default provider when the caller brings nothing", () => {
    const result = resolveProvider(
      { allowByoKeys: true, defaultProvider },
      { key: null, provider: null, model: null },
    );
    expect(result).toMatchObject({ ok: true, byok: false });
  });

  it("refuses a BYO key on a deployment that has not opted in", () => {
    const result = resolveProvider(
      { allowByoKeys: false, defaultProvider },
      { key: "sk-user", provider: "openai", model: null },
    );
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it("builds a per-request provider around the caller's key", () => {
    const result = resolveProvider(
      { allowByoKeys: true, defaultProvider },
      { key: "sk-user", provider: "anthropic", model: "claude-x" },
    );
    expect(result).toMatchObject({ ok: true, byok: true });
    if (result.ok) expect(result.provider.name).toBe("anthropic");
  });

  it("rejects an unknown provider name without touching the key", () => {
    const result = resolveProvider(
      { allowByoKeys: true, defaultProvider },
      { key: "sk-user", provider: "myspace", model: null },
    );
    expect(result).toMatchObject({ ok: false, status: 400 });
  });
});

interface Harness {
  base: string;
  usage: InMemoryUsageStore;
  close: () => Promise<void>;
}

async function harness(env: Record<string, string> = {}): Promise<Harness> {
  const config = readConfig({ LUCENT_REQUIRE_AUTH: "1", ...env });
  const usage = new InMemoryUsageStore();
  const { server, close } = createApp({
    config,
    provider: new MockProvider(),
    imageProvider: new MockImageProvider(),
    userStore: new InMemoryUserStore(),
    boardStore: new InMemoryBoardStore(),
    sessionStore: new InMemorySessionStore(),
    secret: "test-secret-at-least-16-chars",
    usage: new UsageTracker(limitsFromEnv()),
    limits: limitsFromEnv(),
    telemetry: new Telemetry(),
    authLimiter: new Limiter(50, 60_000),
    tickets: new InMemoryTicketStore(60_000),
    orgStore: new InMemoryOrgStore(),
    inviteStore: new InMemoryOrgInviteStore(),
    notifications: new InMemoryNotificationStore(),
    usageStore: usage,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, usage, close };
}

const ORIGIN = "http://localhost:5173";

async function signup(base: string, email: string): Promise<string> {
  const csrfRes = await fetch(`${base}/api/auth/csrf`, { headers: { origin: ORIGIN } });
  const csrfBody = (await csrfRes.json()) as { token: string };
  const res = await fetch(`${base}/api/auth/signup`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      cookie: `lucent_csrf=${csrfBody.token}`,
      "x-csrf-token": csrfBody.token,
    },
    body: JSON.stringify({ email, password: "password123", name: "u" }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { token: string }).token;
}

/** Parse an SSE body into {event, data} pairs. */
function parseSse(raw: string): Array<{ event: string; data: Record<string, unknown> }> {
  const frames: Array<{ event: string; data: Record<string, unknown> }> = [];
  for (const block of raw.split("\n\n")) {
    if (!block.trim()) continue;
    let event = "message";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    try {
      frames.push({ event, data: JSON.parse(data) as Record<string, unknown> });
    } catch {
      // ignore
    }
  }
  return frames;
}

describe("POST /api/generate/stream", () => {
  const fetchStubs: Array<() => void> = [];
  afterEach(() => {
    for (const restore of fetchStubs.splice(0)) restore();
  });

  it("streams start → deltas → done with validated operations, and meters", async () => {
    const h = await harness();
    try {
      const token = await signup(h.base, "stream@example.com");
      const res = await fetch(`${h.base}/api/generate/stream`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          origin: ORIGIN,
          // Bearer-only, so no CSRF pair is required (csrf.ts SAFE_METHODS
          // applies to the header path like every other route).
        },
        body: JSON.stringify({
          message: "build an e-commerce store",
          summary: {
            diagramKind: "flowchart",
            nodes: [],
            edges: [],
            shapes: [],
            shapeLinks: [],
            groups: [],
            comments: [],
            reactions: [],
            wireframes: [],
          },
        }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const raw = await res.text();
      const frames = parseSse(raw);
      expect(frames[0]!.event).toBe("start");
      // The mock streams in slices: several deltas, then exactly one terminal.
      const deltas = frames.filter((f) => f.event === "delta");
      expect(deltas.length).toBeGreaterThan(1);
      const done = frames.find((f) => f.event === "done");
      expect(done).toBeDefined();
      const operations = (done!.data.operations as Array<{ op: string }>).map((o) => o.op);
      expect(operations).toContain("CREATE_NODE");
      // The conversational reply rides the done frame too.
      expect(done!.data.reply).toMatch(/\?$/);
      expect(frames.find((f) => f.event === "error")).toBeUndefined();
    } finally {
      await h.close();
    }
  });

  it("refuses an anonymous caller when auth is required", async () => {
    const h = await harness();
    try {
      const res = await fetch(`${h.base}/api/generate/stream`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ message: "x", summary: {} }),
      });
      expect(res.status).toBe(401);
    } finally {
      await h.close();
    }
  });

  it("BYO keys route through the caller's provider when enabled, and 403 when not", async () => {
    const { base, close } = await harness({ LUCENT_ALLOW_BYO_KEYS: "1" });
    try {
      const token = await signup(base, "byo@example.com");
      // The BYO provider would call api.openai.com — stub global fetch for
      // everything that is not this test server.
      const original = globalThis.fetch;
      globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
        const target = String(url);
        if (target.startsWith(base) || target.startsWith("/")) return original(target, init);
        const sse =
          'data: {"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"{\\"operations\\": []}"}}]}}]}\n\n' +
          "data: [DONE]\n\n";
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(sse));
              controller.close();
            },
          }),
          { status: 200 },
        );
      }) as typeof fetch;
      fetchStubs.push(() => {
        globalThis.fetch = original;
      });

      const res = await fetch(`${base}/api/generate/stream`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          origin: ORIGIN,
          [BYO_KEY_HEADER]: "sk-user-key",
          [BYO_PROVIDER_HEADER]: "openai",
          [BYO_MODEL_HEADER]: "gpt-x",
        },
        body: JSON.stringify({
          message: "x",
          summary: {
            diagramKind: "flowchart",
            nodes: [],
            edges: [],
            shapes: [],
            shapeLinks: [],
            groups: [],
            comments: [],
            reactions: [],
            wireframes: [],
          },
        }),
      });
      expect(res.status).toBe(200);
      const frames = parseSse(await res.text());
      const done = frames.find((f) => f.event === "done");
      expect(done!.data.provider as string).toBe("openai-byo");
      fetchStubs[0]?.();
      fetchStubs.length = 0;
    } finally {
      await close();
    }

    const bare = await harness();
    try {
      const token = await signup(bare.base, "byo2@example.com");
      const res = await fetch(`${bare.base}/api/generate/stream`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          origin: ORIGIN,
          [BYO_KEY_HEADER]: "sk-user-key",
        },
        body: JSON.stringify({ message: "x", summary: {} }),
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: /not enabled/ });
    } finally {
      await bare.close();
    }
  });
});
