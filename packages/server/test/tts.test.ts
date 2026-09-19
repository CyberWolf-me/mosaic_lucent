import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { MockProvider, MockImageProvider } from "@lucent/ai";
import { createApp } from "../src/app.js";
import { InMemoryUserStore } from "../src/accounts.js";
import { InMemoryBoardStore } from "../src/boards.js";
import { InMemoryOrgStore } from "../src/orgs.js";
import { InMemoryUsageStore } from "../src/usageStore.js";
import { InMemorySessionStore } from "../src/sessions.js";
import { InMemoryTicketStore } from "../src/realtimeTicket.js";
import { Limiter } from "../src/limiter.js";
import { Telemetry } from "../src/telemetry.js";
import { UsageTracker, limitsFromEnv } from "../src/usage.js";
import { readConfig } from "../src/config.js";
import {
  DeepgramTtsService,
  GenericHttpTtsService,
  MockTtsService,
  OpenAiTtsService,
  selectTtsService,
  type TtsService,
} from "../src/tts.js";

/**
 * docs/25 V7 (M6.2): the server voice proxy.
 *
 * The rules: standby by default (503, never faked audio); the org switch
 * refuses with a policy:tts telemetry refusal; metering is whole shared
 * voice minutes on success only (short answers free); provider failures
 * are 502s. The sidecar speaks OpenAI-style `/v1/audio/speech`.
 */

const SECRET = "test-secret-at-least-16-chars";

describe("selectTtsService", () => {
  it("is standby unless key + URL are both set", () => {
    expect(selectTtsService({}).live).toBe(false);
    expect(selectTtsService({ LUCENT_TTS_KEY: "k" }).live).toBe(false);
    const live = selectTtsService({ LUCENT_TTS_KEY: "k", LUCENT_TTS_URL: "https://tts.internal" });
    expect(live.live).toBe(true);
    expect(live.name).toBe("custom-http");
  });

  it("the mock synthesizes only when scripted", async () => {
    const standby = new MockTtsService();
    expect(standby.live).toBe(false);
    await expect(standby.synthesize({ text: "hi" })).rejects.toThrow("standby");
    const live = new MockTtsService({ audio: new Uint8Array([1, 2, 3]) });
    expect(live.live).toBe(true);
    const out = await live.synthesize({ text: "hi" });
    expect(out.audio).toEqual(new Uint8Array([1, 2, 3]));
    expect(out.contentType).toBe("audio/mpeg");
  });

  it("selects the Deepgram adapter on provider=deepgram, sharing the project key", () => {
    // One Deepgram project key serves every API: the TTS key falls back to
    // the STT key, documented in tts.ts rather than magic.
    const dg = selectTtsService({ LUCENT_STT_KEY: "k", LUCENT_TTS_PROVIDER: "deepgram" });
    expect(dg.live).toBe(true);
    expect(dg.name).toBe("deepgram");
    expect(selectTtsService({ LUCENT_TTS_PROVIDER: "deepgram" }).live).toBe(false);
    expect(() => selectTtsService({ LUCENT_TTS_PROVIDER: "deepvoxx" })).toThrow(
      "LUCENT_TTS_PROVIDER",
    );
  });
});

describe("GenericHttpTtsService", () => {
  function stubFetch(
    seen: Array<{ url: string; headers: Record<string, string>; body: unknown }>,
    audio: Uint8Array,
    status = 200,
    contentType = "audio/wav",
  ): typeof fetch {
    return (async (url: unknown, init: unknown) => {
      const typed = init as { headers: Record<string, string>; body: string };
      seen.push({ url: String(url), headers: typed.headers, body: JSON.parse(typed.body) });
      return new Response(Buffer.from(audio), {
        status,
        headers: { "content-type": contentType },
      });
    }) as typeof fetch;
  }

  it("posts input+voice with the key and returns audio with its type", async () => {
    const seen: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
    const service = new GenericHttpTtsService({
      url: "https://tts.internal///",
      apiKey: "secret",
      name: "kokoro",
      voice: "af_heart",
      fetchImpl: stubFetch(seen, new Uint8Array([9, 9])),
    });
    const out = await service.synthesize({ text: "hello" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://tts.internal/v1/audio/speech");
    expect(seen[0]!.headers.authorization).toBe("Bearer secret");
    expect(seen[0]!.body).toEqual({ input: "hello", voice: "af_heart" });
    expect(out.audio).toEqual(new Uint8Array([9, 9]));
    expect(out.contentType).toBe("audio/wav");
  });

  it("throws on non-2xx and empty audio — the route answers 502", async () => {
    const failing = new GenericHttpTtsService({
      url: "https://x",
      apiKey: "k",
      fetchImpl: stubFetch([], new Uint8Array([1]), 500),
    });
    await expect(failing.synthesize({ text: "hi" })).rejects.toThrow("500");
    const empty = new GenericHttpTtsService({
      url: "https://x",
      apiKey: "k",
      fetchImpl: stubFetch([], new Uint8Array(0)),
    });
    await expect(empty.synthesize({ text: "hi" })).rejects.toThrow("no audio");
  });
});

describe("OpenAiTtsService (UNVERIFIED — no key has exercised this path)", () => {
  function stubAudio(
    seen: Array<{ url: string; headers: Record<string, string>; body: unknown }>,
    audio: Uint8Array,
    status = 200,
  ): typeof fetch {
    return (async (url: unknown, init: unknown) => {
      const typed = init as { headers: Record<string, string>; body: string };
      seen.push({ url: String(url), headers: typed.headers, body: JSON.parse(typed.body) });
      return new Response(Buffer.from(audio), { status });
    }) as typeof fetch;
  }

  it("posts model/input/voice with Bearer auth and returns bytes", async () => {
    const seen: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
    const service = new OpenAiTtsService({
      apiKey: "sk-test",
      fetchImpl: stubAudio(seen, new Uint8Array([7, 7])),
    });
    expect(service.name).toBe("openai");
    const out = await service.synthesize({ text: "hello" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://api.openai.com/v1/audio/speech");
    expect(seen[0]!.headers.authorization).toBe("Bearer sk-test");
    expect(seen[0]!.body).toEqual({ model: "tts-1", input: "hello", voice: "alloy" });
    expect(out.audio).toEqual(new Uint8Array([7, 7]));
    // Per-request voice wins.
    await service.synthesize({ text: "hi", voice: "nova" });
    expect(seen[1]!.body).toEqual({ model: "tts-1", input: "hi", voice: "nova" });
  });

  it("refuses empty text and loud failures alike", async () => {
    const service = new OpenAiTtsService({
      apiKey: "k",
      fetchImpl: stubAudio([], new Uint8Array([1])),
    });
    await expect(service.synthesize({ text: "  " })).rejects.toThrow("nothing to speak");
    const failing = new OpenAiTtsService({
      apiKey: "k",
      fetchImpl: stubAudio([], new Uint8Array([1]), 429),
    });
    await expect(failing.synthesize({ text: "hi" })).rejects.toThrow("429");
  });
});

describe("DeepgramTtsService", () => {
  function stubAudio(
    seen: Array<{ url: string; headers: Record<string, string>; body: unknown }>,
    audio: Uint8Array,
    status = 200,
  ): typeof fetch {
    return (async (url: unknown, init: unknown) => {
      const typed = init as { headers: Record<string, string>; body: string };
      seen.push({ url: String(url), headers: typed.headers, body: JSON.parse(typed.body) });
      return new Response(Buffer.from(audio), { status });
    }) as typeof fetch;
  }

  it("speaks Aura-style: Token auth, model query, text body, bytes back", async () => {
    const seen: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
    const service = new DeepgramTtsService({
      apiKey: "dg-test",
      fetchImpl: stubAudio(seen, new Uint8Array([5, 5, 5])),
    });
    expect(service.name).toBe("deepgram");
    const out = await service.synthesize({ text: "hello" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://api.deepgram.com/v1/speak?model=aura-2-thalia-en");
    expect(seen[0]!.headers.authorization).toBe("Token dg-test");
    expect(seen[0]!.body).toEqual({ text: "hello" });
    expect(out.audio).toEqual(new Uint8Array([5, 5, 5]));
    // A per-request voice overrides the deployment default in the query.
    await service.synthesize({ text: "hi", voice: "aura-2-atlas-en" });
    expect(seen[1]!.url).toBe("https://api.deepgram.com/v1/speak?model=aura-2-atlas-en");
  });

  it("refuses empty text and loud failures alike", async () => {
    const service = new DeepgramTtsService({
      apiKey: "k",
      fetchImpl: stubAudio([], new Uint8Array([1])),
    });
    await expect(service.synthesize({ text: "   " })).rejects.toThrow("nothing to speak");
    const failing = new DeepgramTtsService({
      apiKey: "k",
      fetchImpl: stubAudio([], new Uint8Array([1]), 402),
    });
    await expect(failing.synthesize({ text: "hi" })).rejects.toThrow("402");
  });
});

interface Harness {
  base: string;
  userStore: InMemoryUserStore;
  usage: InMemoryUsageStore;
  telemetry: Telemetry;
  close: () => Promise<void>;
}

async function harness(tts?: TtsService): Promise<Harness> {
  const limits = limitsFromEnv();
  const userStore = new InMemoryUserStore();
  const usage = new InMemoryUsageStore();
  const telemetry = new Telemetry();
  const { server, close } = createApp({
    config: { ...readConfig({ LUCENT_REQUIRE_AUTH: "1" }), requireAuth: true },
    provider: new MockProvider(),
    imageProvider: new MockImageProvider(),
    ...(tts ? { tts } : {}),
    userStore,
    boardStore: new InMemoryBoardStore(),
    secret: SECRET,
    usage: new UsageTracker(limits),
    usageStore: usage,
    limits,
    telemetry,
    authLimiter: new Limiter(1000, 60_000),
    tickets: new InMemoryTicketStore(60_000),
    sessionStore: new InMemorySessionStore(),
    orgStore: new InMemoryOrgStore(),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, userStore, usage, telemetry, close };
}

let open: Harness | null = null;
afterEach(async () => {
  await open?.close();
  open = null;
});

async function api(
  h: Harness,
  path: string,
  init: RequestInit & { token?: string } = {},
): Promise<{
  status: number;
  headers: Headers;
  text: () => Promise<string>;
  json: () => Promise<any>;
}> {
  const { token, ...rest } = init;
  const res = await fetch(`${h.base}${path}`, {
    ...rest,
    headers: {
      ...(rest.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(rest.headers ?? {}),
    },
  });
  return {
    status: res.status,
    headers: res.headers,
    text: () => res.text(),
    json: () => res.json().catch(() => ({})),
  };
}

async function signup(h: Harness, email: string) {
  const created = await api(h, "/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({ email, password: "password123", name: email.split("@")[0] }),
  });
  expect(created.status).toBe(201);
  const createdBody = (await created.json()) as { token: string };
  const user = await h.userStore.findByEmail(email);
  if (user) await h.userStore.setEmailVerified(user.id, Date.now());
  const listed = await api(h, "/api/orgs", { token: createdBody.token });
  return {
    token: createdBody.token,
    orgId: ((await listed.json()).orgs[0] as { id: string }).id,
  };
}

const BYTES = new Uint8Array(64).fill(7);

describe("POST /api/tts/speak", () => {
  it("synthesizes through the injected service with its content type", async () => {
    const h = (open = await harness(
      new MockTtsService({ audio: BYTES, contentType: "audio/wav" }),
    ));
    const alice = await signup(h, "alice.tts@example.com");
    const res = await api(h, "/api/tts/speak", {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({ input: "The team decided on Postgres." }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/wav");
    expect((await res.text()).length).toBeGreaterThan(0);
    // Short answers cost nothing: floor(31/800) = 0 voice minutes.
    expect(await h.usage.monthToDate(alice.orgId, "voice.minute", Date.now())).toBe(0);
  });

  it("meters whole minutes on long answers, once", async () => {
    const h = (open = await harness(new MockTtsService({ audio: BYTES })));
    const alice = await signup(h, "alice.tts.meter@example.com");
    const res = await api(h, "/api/tts/speak", {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({ input: "x".repeat(900) }),
    });
    expect(res.status).toBe(200);
    expect(await h.usage.monthToDate(alice.orgId, "voice.minute", Date.now())).toBe(1);
  });

  it("503s on an unconfigured deployment — the client falls back locally", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "alice.tts.standby@example.com");
    const res = await api(h, "/api/tts/speak", {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({ input: "hi" }),
    });
    expect(res.status).toBe(503);
  });

  it("honors the org serverTts switch as a policy refusal, and validates input", async () => {
    const h = (open = await harness(new MockTtsService({ audio: BYTES })));
    const alice = await signup(h, "alice.tts.policy@example.com");
    const denied = await api(h, `/api/orgs/${alice.orgId}/settings`, {
      method: "PATCH",
      token: alice.token,
      body: JSON.stringify({ serverTts: "disabled" }),
    });
    expect(denied.status).toBe(200);
    const refused = await api(h, "/api/tts/speak", {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({ input: "hi" }),
    });
    expect(refused.status).toBe(403);
    expect((await refused.json()).boundary).toBe("tts");
    expect(h.telemetry.snapshot().refusals.policy).toBe(1);
    const policy = await api(h, `/api/orgs/${alice.orgId}/policy`, { token: alice.token });
    expect((await policy.json()).serverTts).toBe("disabled");
  });

  it("rejects empty and oversize input with 400", async () => {
    const h = (open = await harness(new MockTtsService({ audio: BYTES })));
    const alice = await signup(h, "alice.tts.bad@example.com");
    for (const bad of [{ input: "" }, { input: "   " }, { input: "x".repeat(2001) }, {}]) {
      const res = await api(h, "/api/tts/speak", {
        method: "POST",
        token: alice.token,
        body: JSON.stringify(bad),
      });
      expect(res.status, JSON.stringify(bad).slice(0, 40)).toBe(400);
    }
  });

  it("a provider failure is a 502 that never bills", async () => {
    const h = (open = await harness({
      name: "boom",
      live: true,
      synthesize: async () => {
        throw new Error("sidecar down");
      },
    }));
    const alice = await signup(h, "alice.tts.fail@example.com");
    const res = await api(h, "/api/tts/speak", {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({ input: "x".repeat(900) }),
    });
    expect(res.status).toBe(502);
    expect(await h.usage.monthToDate(alice.orgId, "voice.minute", Date.now())).toBe(0);
  });
});
