import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { MockImageProvider, MockProvider, type LLMProvider } from "@lucent/ai";
import { createWorkspace } from "@lucent/core";
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
 * docs/27 D2: POST /api/themes sorts sticky notes into themes by index. The
 * board's AI boundary decides whether a model sees the notes — and a refusal,
 * a missing model or a failed one still sorts the wall, offline and labelled.
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

const ITEMS = [
  { text: "Signup form asks for too much" },
  { text: "Pricing page is confusing" },
  { text: "Pricing tiers overlap" },
  { text: "Signup needs SSO" },
  { text: "Dark mode" },
];

describe("POST /api/themes", () => {
  it("sorts every note into exactly one theme", async () => {
    const h = (open = await harness());
    const token = await signup(h, "th@example.com");
    const r = await api(h, "/api/themes", { method: "POST", token, body: { items: ITEMS } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ by: "model", model: "mock" });
    const all = r.body.themes.flatMap((t: { items: number[] }) => t.items).sort();
    expect(all).toEqual([0, 1, 2, 3, 4]);
    expect(r.body.offline).toBeUndefined();
  });

  it("a restricted board keeps its notes from the model — sorted offline, labelled", async () => {
    // The in-process mock is exempt from the boundary; stand in a provider
    // that would send data out.
    const cloud = new MockProvider() as unknown as LLMProvider;
    Object.defineProperty(cloud, "name", { value: "cloud-model" });
    const h = (open = await harness(cloud));
    const token = await signup(h, "rs@example.com");
    const board = await api(h, "/api/boards", {
      method: "POST",
      token,
      body: { name: "Wall", workspace: createWorkspace(), classification: "restricted" },
    });
    expect(board.status).toBe(201);
    const r = await api(h, "/api/themes", {
      method: "POST",
      token,
      body: { items: ITEMS, boardId: board.body.id },
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ by: "fallback", offline: "policy" });
  });

  it("no themes call, or a failing one, falls back honestly", async () => {
    const none = new MockProvider() as unknown as LLMProvider;
    (none as { generateThemes?: unknown }).generateThemes = undefined;
    let h = (open = await harness(none));
    let token = await signup(h, "nm@example.com");
    let r = await api(h, "/api/themes", { method: "POST", token, body: { items: ITEMS } });
    expect(r.body.offline).toBe("no-model");
    await h.close();

    const failing = new MockProvider() as unknown as LLMProvider;
    failing.generateThemes = async () => {
      throw new Error("model down");
    };
    h = open = await harness(failing);
    token = await signup(h, "mf@example.com");
    r = await api(h, "/api/themes", { method: "POST", token, body: { items: ITEMS } });
    expect(r.status).toBe(200);
    expect(r.body.offline).toBe("model-failed");
  });

  it("refuses a stranger's board, anonymous callers, and a malformed body", async () => {
    const h = (open = await harness());
    const owner = await signup(h, "ow@example.com");
    const board = await api(h, "/api/boards", {
      method: "POST",
      token: owner,
      body: { name: "Wall", workspace: createWorkspace() },
    });
    const stranger = await signup(h, "st@example.com");
    const denied = await api(h, "/api/themes", {
      method: "POST",
      token: stranger,
      body: { items: ITEMS, boardId: board.body.id },
    });
    expect([403, 404]).toContain(denied.status);
    expect((await api(h, "/api/themes", { method: "POST", body: { items: ITEMS } })).status).toBe(
      401,
    );
    expect(
      (await api(h, "/api/themes", { method: "POST", token: owner, body: { items: [] } })).status,
    ).toBe(400);
  });
});
