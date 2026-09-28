import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { MockImageProvider, MockProvider, type LLMProvider } from "@lucent/ai";
import { createWorkspace, vectorDataSchema, type VectorData } from "@lucent/core";
import { createApp } from "../src/app.js";
import { InMemoryUserStore } from "../src/accounts.js";
import { InMemoryBoardStore } from "../src/boards.js";
import { InMemorySessionStore } from "../src/sessions.js";
import { UsageTracker, limitsFromEnv } from "../src/usage.js";
import { Telemetry } from "../src/telemetry.js";
import { Limiter } from "../src/limiter.js";
import { InMemoryTicketStore } from "../src/realtimeTicket.js";
import { readConfig } from "../src/config.js";

/**
 * docs/26 §6.3: POST /api/vector/edit rewrites one vector to an instruction
 * through the model. It writes nothing to the board — the reply is a vector
 * the schema accepts, for the person to preview and apply — and it holds the
 * same line as generation: the board's AI boundary, the editor floor, and an
 * honest refusal where there's no model, rather than a made-up edit.
 */

const SECRET = "test-secret-at-least-16-chars";

interface Harness {
  base: string;
  userStore: InMemoryUserStore;
  close: () => Promise<void>;
}
let open: Harness | null = null;
afterEach(async () => {
  await open?.close();
  open = null;
});

async function harness(provider: LLMProvider = new MockProvider()): Promise<Harness> {
  const limits = limitsFromEnv();
  const config = {
    ...readConfig({ LUCENT_REQUIRE_AUTH: "1", LUCENT_WEB_ORIGIN: "http://127.0.0.1" }),
    requireAuth: true,
  };
  const userStore = new InMemoryUserStore();
  const { server, close } = createApp({
    config,
    provider,
    imageProvider: new MockImageProvider(),
    userStore,
    boardStore: new InMemoryBoardStore(),
    sessionStore: new InMemorySessionStore(),
    secret: SECRET,
    usage: new UsageTracker(limits),
    limits,
    telemetry: new Telemetry(),
    authLimiter: new Limiter(1000, 60_000),
    tickets: new InMemoryTicketStore(60_000),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, userStore, close: async () => close() };
}

async function api(
  h: Harness,
  path: string,
  init: { method?: string; body?: unknown; token?: string } = {},
) {
  const res = await fetch(`${h.base}${path}`, {
    method: init.method ?? "GET",
    headers: {
      origin: h.base,
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

async function signup(h: Harness, email: string): Promise<string> {
  const r = await api(h, "/api/auth/signup", {
    method: "POST",
    body: { email, password: "password123", name: email },
  });
  expect(r.status).toBe(201);
  const user = await h.userStore.findByEmail(email);
  if (user) await h.userStore.setEmailVerified(user.id, Date.now());
  return r.body.token as string;
}

const VECTOR: VectorData = {
  viewBox: [0, 0, 24, 24],
  paths: [
    { d: "M2 2L22 2L22 22L2 22Z", fill: "#ff0000" },
    { d: "M6 12L18 12", fill: "none", stroke: "#0000ff", strokeWidth: 2 },
  ],
};

describe("POST /api/vector/edit", () => {
  it("returns the edited vector, schema-valid, with what changed", async () => {
    const h = (open = await harness());
    const token = await signup(h, "ve@example.com");
    const r = await api(h, "/api/vector/edit", {
      method: "POST",
      token,
      body: { vector: VECTOR, instruction: "outline only" },
    });
    expect(r.status).toBe(200);
    expect(r.body.summary).toMatch(/outlines/);
    expect(r.body.model).toBe("mock");
    expect(vectorDataSchema.safeParse(r.body.vector).success).toBe(true);
    expect(r.body.vector.paths.every((p: { fill?: string }) => p.fill === "none")).toBe(true);
    expect(r.body.vector.source).toMatchObject({ generator: "mock", prompt: "outline only" });
  });

  it("a model's hostile or broken drawing is cleaned or refused, never passed through", async () => {
    const shady = new MockProvider() as unknown as LLMProvider;
    let reply: unknown = {
      summary: "done",
      paths: [
        { d: "M0 0L10 10", fill: "url(javascript:alert(1))" },
        { d: "<script>alert(1)</script>" },
      ],
    };
    shady.editVector = async () => reply as never;
    const h = (open = await harness(shady));
    const token = await signup(h, "sh@example.com");
    const cleaned = await api(h, "/api/vector/edit", {
      method: "POST",
      token,
      body: { vector: VECTOR, instruction: "do something" },
    });
    expect(cleaned.status).toBe(200);
    expect(cleaned.body.vector.paths).toEqual([{ d: "M0 0L10 10" }]);
    expect(cleaned.body.dropped).toBe(1);
    reply = { summary: "nothing", paths: [{ d: "M1 1" }] };
    const empty = await api(h, "/api/vector/edit", {
      method: "POST",
      token,
      body: { vector: VECTOR, instruction: "do something" },
    });
    expect(empty.status).toBe(502);
    expect(empty.body.error).toMatch(/nothing drawable/);
  });

  it("a restricted board keeps its drawing from an outside model", async () => {
    const cloud = new MockProvider() as unknown as LLMProvider;
    Object.defineProperty(cloud, "name", { value: "cloud-model" });
    const h = (open = await harness(cloud));
    const token = await signup(h, "rv@example.com");
    const board = await api(h, "/api/boards", {
      method: "POST",
      token,
      body: { name: "Art", workspace: createWorkspace(), classification: "restricted" },
    });
    expect(board.status).toBe(201);
    const r = await api(h, "/api/vector/edit", {
      method: "POST",
      token,
      body: { vector: VECTOR, instruction: "make it blue", boardId: board.body.id },
    });
    expect(r.status).toBe(403);
  });

  it("says so when there's no model, and when the vector is too detailed", async () => {
    const none = new MockProvider() as unknown as LLMProvider;
    (none as { editVector?: unknown }).editVector = undefined;
    let h = (open = await harness(none));
    let token = await signup(h, "nm@example.com");
    let r = await api(h, "/api/vector/edit", {
      method: "POST",
      token,
      body: { vector: VECTOR, instruction: "make it blue" },
    });
    expect(r.status).toBe(503);
    await h.close();

    h = open = await harness();
    token = await signup(h, "big@example.com");
    const big: VectorData = {
      viewBox: [0, 0, 100, 100],
      paths: Array.from({ length: 90 }, (_, i) => ({ d: `M${i} 0L${i} 100` })),
    };
    r = await api(h, "/api/vector/edit", {
      method: "POST",
      token,
      body: { vector: big, instruction: "make it blue" },
    });
    expect(r.status).toBe(413);
    expect(r.body.error).toMatch(/simplify it first/);
  });

  it("refuses a stranger's board, anonymous callers, and a malformed vector", async () => {
    const h = (open = await harness());
    const owner = await signup(h, "ow@example.com");
    const board = await api(h, "/api/boards", {
      method: "POST",
      token: owner,
      body: { name: "Art", workspace: createWorkspace() },
    });
    const stranger = await signup(h, "st@example.com");
    const denied = await api(h, "/api/vector/edit", {
      method: "POST",
      token: stranger,
      body: { vector: VECTOR, instruction: "make it blue", boardId: board.body.id },
    });
    expect([403, 404]).toContain(denied.status);
    const anon = await api(h, "/api/vector/edit", {
      method: "POST",
      body: { vector: VECTOR, instruction: "make it blue" },
    });
    expect(anon.status).toBe(401);
    const bad = await api(h, "/api/vector/edit", {
      method: "POST",
      token: owner,
      body: { vector: { viewBox: [0, 0, 1, 1], paths: [{ d: "<svg/>" }] }, instruction: "x y" },
    });
    expect(bad.status).toBe(400);
  });
});
