import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import {
  MockImageProvider,
  MockProvider,
  MockVectorProvider,
  type VectorProvider,
} from "@lucent/ai";
import { createWorkspace, vectorDataSchema } from "@lucent/core";
import { createApp } from "../src/app.js";
import { InMemoryUserStore } from "../src/accounts.js";
import { InMemoryBoardStore } from "../src/boards.js";
import { InMemorySessionStore } from "../src/sessions.js";
import { UsageTracker, limitsFromEnv } from "../src/usage.js";
import { Telemetry } from "../src/telemetry.js";
import { Limiter } from "../src/limiter.js";
import { InMemoryTicketStore } from "../src/realtimeTicket.js";
import { readConfig } from "../src/config.js";
import { selectVectorProvider } from "../src/vector.js";

/**
 * docs/26 §6.3 V3: POST /api/vector. The vendor's SVG is untrusted: the route
 * answers structured paths only, sanitized server-side. It is gated like
 * generation — a signed-in editor of the board, and the board's AI boundary.
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

async function harness(vectorProvider: VectorProvider | null): Promise<Harness> {
  const limits = limitsFromEnv();
  const config = {
    ...readConfig({ LUCENT_REQUIRE_AUTH: "1", LUCENT_WEB_ORIGIN: "http://127.0.0.1" }),
    requireAuth: true,
  };
  const userStore = new InMemoryUserStore();
  const { server, close } = createApp({
    config,
    provider: new MockProvider(),
    imageProvider: new MockImageProvider(),
    vectorProvider,
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
  init: { method?: string; body?: unknown; token?: string; csrf?: boolean } = {},
) {
  const headers: Record<string, string> = { origin: h.base };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  const res = await fetch(`${h.base}${path}`, {
    method: init.method ?? "GET",
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await res.text();
  let body: any = {};
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body, text };
}

async function signup(h: Harness, email: string): Promise<string> {
  const r = await api(h, "/api/auth/signup", {
    method: "POST",
    body: { email, password: "password123", name: "T" },
  });
  expect(r.status).toBe(201);
  const user = await h.userStore.findByEmail(email);
  if (user) await h.userStore.setEmailVerified(user.id, Date.now());
  return r.body.token as string;
}

const post = (h: Harness, token: string | undefined, body: unknown) =>
  api(h, "/api/vector", { method: "POST", body, ...(token ? { token } : {}) });

describe("POST /api/vector", () => {
  it("answers editable vector variations — structured paths, never SVG text", async () => {
    const h = (open = await harness(new MockVectorProvider()));
    const token = await signup(h, "v1@example.com");
    const r = await post(h, token, { prompt: "a rocket", style: "icon", n: 3 });
    expect(r.status).toBe(200);
    expect(r.body.provider).toBe("mock");
    expect(r.body.variations).toHaveLength(3);
    for (const v of r.body.variations)
      expect(vectorDataSchema.safeParse(v.vector).success).toBe(true);
    // The mock paints a white backdrop; generated art arrives without it.
    expect(
      r.body.variations[0].vector.paths.some((p: { fill?: string }) => p.fill === "#ffffff"),
    ).toBe(false);
    expect(r.text).not.toContain("<svg");
    expect(r.body.variations[0].vector.source).toMatchObject({
      generator: "mock",
      prompt: "a rocket",
    });
  });

  it("sanitizes whatever the vendor returns", async () => {
    const hostile: VectorProvider = {
      name: "recraft",
      model: "recraftv4_1_vector",
      generateVectors: async () => ({
        svgs: [
          '<svg viewBox="0 0 10 10" onload="alert(1)"><script>fetch("//evil")</script><foreignObject><iframe src="//evil"/></foreignObject><path d="M0 0L10 10" stroke="red"/></svg>',
          "<html>not svg</html>",
        ],
      }),
    };
    const h = (open = await harness(hostile));
    const token = await signup(h, "v2@example.com");
    const r = await post(h, token, { prompt: "anything", n: 2 });
    expect(r.status).toBe(200);
    expect(r.body.variations).toHaveLength(1);
    for (const bad of ["script", "evil", "iframe", "onload", "alert"])
      expect(r.text).not.toContain(bad);
  });

  it("fails honestly: vendor error 502, nothing importable 502, not configured 503", async () => {
    const failing: VectorProvider = {
      name: "recraft",
      generateVectors: async () => {
        throw new Error("Recraft 402: Insufficient credits");
      },
    };
    let h = (open = await harness(failing));
    let token = await signup(h, "v3@example.com");
    let r = await post(h, token, { prompt: "x y" });
    expect(r.status).toBe(502);
    expect(r.body.detail).toMatch(/Insufficient credits/);
    await h.close();

    h = open = await harness({
      name: "recraft",
      generateVectors: async () => ({ svgs: ["<svg><text>hi</text></svg>"] }),
    });
    token = await signup(h, "v4@example.com");
    r = await post(h, token, { prompt: "x y" });
    expect(r.status).toBe(502);
    await h.close();

    h = open = await harness(null);
    token = await signup(h, "v5@example.com");
    r = await post(h, token, { prompt: "x y" });
    expect(r.status).toBe(503);
  });

  it("requires a signed-in caller, a valid body, and an editor of the named board", async () => {
    const h = (open = await harness(new MockVectorProvider()));
    expect((await post(h, undefined, { prompt: "x y" })).status).toBe(401);
    const alice = await signup(h, "va@example.com");
    const mallory = await signup(h, "vm@example.com");
    expect((await post(h, alice, { prompt: "" })).status).toBe(400);
    expect((await post(h, alice, { prompt: "x y", n: 9 })).status).toBe(400);
    const created = await api(h, "/api/boards", {
      method: "POST",
      token: alice,
      body: { name: "B", workspace: createWorkspace() },
    });
    const boardId = created.body.id as string;
    expect((await post(h, alice, { prompt: "a tree", boardId })).status).toBe(200);
    expect((await post(h, mallory, { prompt: "a tree", boardId })).status).toBe(404);
  });
});

describe("selectVectorProvider", () => {
  it("Recraft with a key, the mock without, nothing when switched off", () => {
    expect(selectVectorProvider({ LUCENT_RECRAFT_API_KEY: "k" } as NodeJS.ProcessEnv)?.name).toBe(
      "recraft",
    );
    expect(selectVectorProvider({} as NodeJS.ProcessEnv)?.name).toBe("mock");
    expect(
      selectVectorProvider({
        LUCENT_RECRAFT_API_KEY: "k",
        LUCENT_VECTOR_PROVIDER: "mock",
      } as NodeJS.ProcessEnv)?.name,
    ).toBe("mock");
    expect(selectVectorProvider({ LUCENT_VECTOR_PROVIDER: "off" } as NodeJS.ProcessEnv)).toBeNull();
  });
});
