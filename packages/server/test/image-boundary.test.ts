import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { MockImageProvider, MockProvider, type ImageProvider } from "@lucent/ai";
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
 * POST /api/image and the board's AI boundary. The canvas folds a board's own
 * labels into the image prompt, so a request that names its board is judged
 * by that board's classification — the same gate /api/vector applies — and
 * the vendor never sees a prompt the board said may not leave.
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

/** An external image vendor that records every prompt it is handed. */
function recordingVendor(): ImageProvider & { prompts: unknown[] } {
  const prompts: unknown[] = [];
  return {
    name: "gateway-image",
    prompts,
    async generateImage(request) {
      prompts.push(request);
      return { src: "data:image/png;base64,AAAA" };
    },
  };
}

async function harness(imageProvider: ImageProvider): Promise<Harness> {
  const limits = limitsFromEnv();
  const config = {
    ...readConfig({ LUCENT_REQUIRE_AUTH: "1", LUCENT_WEB_ORIGIN: "http://127.0.0.1" }),
    requireAuth: true,
  };
  const userStore = new InMemoryUserStore();
  const { server, close } = createApp({
    config,
    provider: new MockProvider(),
    imageProvider,
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

async function boardFor(h: Harness, token: string, classification?: string): Promise<string> {
  const r = await api(h, "/api/boards", {
    method: "POST",
    token,
    body: {
      name: "B",
      workspace: createWorkspace(),
      ...(classification ? { classification } : {}),
    },
  });
  expect(r.status).toBe(201);
  return r.body.id as string;
}

const PROMPT = "Illustration of the Payments ledger for Project Falcon";

describe("POST /api/image — the board's AI boundary", () => {
  it("a restricted board's prompt never reaches the image vendor", async () => {
    const vendor = recordingVendor();
    const h = (open = await harness(vendor));
    const token = await signup(h, "rs@example.com");
    const boardId = await boardFor(h, token, "restricted");
    const r = await api(h, "/api/image", {
      method: "POST",
      token,
      body: { prompt: PROMPT, boardId },
    });
    expect(r.status).toBe(403);
    expect(r.body.classification).toBe("restricted");
    expect(vendor.prompts).toEqual([]);
  });

  it("an ordinary board generates, and the vendor gets the prompt without the board id", async () => {
    const vendor = recordingVendor();
    const h = (open = await harness(vendor));
    const token = await signup(h, "ok@example.com");
    const boardId = await boardFor(h, token);
    const r = await api(h, "/api/image", {
      method: "POST",
      token,
      body: { prompt: PROMPT, size: "landscape", boardId },
    });
    expect(r.status).toBe(200);
    expect(vendor.prompts).toEqual([{ prompt: PROMPT, size: "landscape" }]);
  });

  it("someone without edit rights on the board is refused before any spend", async () => {
    const vendor = recordingVendor();
    const h = (open = await harness(vendor));
    const owner = await signup(h, "ow@example.com");
    const boardId = await boardFor(h, owner);
    const stranger = await signup(h, "st@example.com");
    const r = await api(h, "/api/image", {
      method: "POST",
      token: stranger,
      body: { prompt: PROMPT, boardId },
    });
    expect([403, 404]).toContain(r.status);
    expect(vendor.prompts).toEqual([]);
  });

  it("the in-process placeholder still draws on a restricted board (nothing leaves)", async () => {
    const h = (open = await harness(new MockImageProvider()));
    const token = await signup(h, "mk@example.com");
    const boardId = await boardFor(h, token, "restricted");
    const r = await api(h, "/api/image", {
      method: "POST",
      token,
      body: { prompt: PROMPT, boardId },
    });
    expect(r.status).toBe(200);
  });

  it("a local board (no board id) behaves as before", async () => {
    const vendor = recordingVendor();
    const h = (open = await harness(vendor));
    const token = await signup(h, "lo@example.com");
    const r = await api(h, "/api/image", { method: "POST", token, body: { prompt: PROMPT } });
    expect(r.status).toBe(200);
    expect(vendor.prompts).toHaveLength(1);
  });
});
