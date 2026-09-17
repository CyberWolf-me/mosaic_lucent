import { describe, expect, it } from "vitest";
import {
  GenericHttpSttService,
  MockSttService,
  createSttSessionRegistry,
  selectSttService,
  type SttUtterance,
} from "../src/stt.js";
import { effectiveSettings, parseOrgSettings, serverSttRefusal } from "../src/classification.js";

/**
 * docs/25 V1: the server STT seam.
 *
 * Three properties under test: the mock never invents speech (unseeded it is
 * pure standby; seeded it emits its script in order and then goes quiet),
 * the sidecar contract is validated minimally (garbage in the response never
 * becomes an utterance), and sessions are ephemeral and bounded (TTL +
 * oldest-eviction, no store anywhere).
 */

const SCRIPT: SttUtterance[] = [
  { text: "first turn", speaker: "spk_01" },
  { text: "second turn", speaker: "spk_02" },
];

describe("MockSttService", () => {
  it("is standby unseeded: chunks accepted, nothing finalizes, close is empty", async () => {
    const service = new MockSttService();
    expect(service.live).toBe(false);
    expect(service.name).toBe("mock");
    const session = service.createSession();
    // The mock has no VAD: verdict null, always.
    expect(await session.push(new Uint8Array([1, 2, 3]))).toEqual({ utterances: [], speech: null });
    const closed = await session.close();
    expect(closed.utterances).toEqual([]);
    expect(closed.audioSeconds).toBeGreaterThanOrEqual(0);
  });

  it("emits a seeded script in order, one utterance per stride, then goes quiet", async () => {
    const service = new MockSttService({ script: SCRIPT, bytesPerUtterance: 4 });
    expect(service.live).toBe(true);
    const session = service.createSession();
    // Below stride: buffered, nothing finalized.
    expect(await session.push(new Uint8Array([1, 2]))).toEqual({ utterances: [], speech: null });
    // Crossing the stride emits in script order with speakers intact.
    expect(await session.push(new Uint8Array([3, 4, 5, 6]))).toEqual({
      utterances: [SCRIPT[0]],
      speech: null,
    });
    expect(await session.push(new Uint8Array([7, 8, 9, 10]))).toEqual({
      utterances: [SCRIPT[1]],
      speech: null,
    });
    // Exhausted: further audio is absorbed, never invented into.
    expect(await session.push(new Uint8Array(100).fill(9))).toEqual({
      utterances: [],
      speech: null,
    });
    expect((await session.close()).utterances).toEqual([]);
  });

  it("reports wall-clock audio seconds from an injected clock", async () => {
    let at = 1_000_000;
    const service = new MockSttService({ now: () => at });
    const session = service.createSession();
    at += 61_000;
    expect((await session.close()).audioSeconds).toBe(61);
  });
});

describe("selectSttService", () => {
  it("is the standby mock unless key + URL are both set", () => {
    expect(selectSttService({}).live).toBe(false);
    expect(selectSttService({ LUCENT_STT_KEY: "k" }).live).toBe(false);
    expect(selectSttService({ LUCENT_STT_URL: "https://stt.internal" }).live).toBe(false);
    const live = selectSttService({ LUCENT_STT_KEY: "k", LUCENT_STT_URL: "https://stt.internal" });
    expect(live.live).toBe(true);
    expect(live.name).toBe("custom-http");
    expect(
      selectSttService({
        LUCENT_STT_KEY: "k",
        LUCENT_STT_URL: "https://stt.internal",
        LUCENT_STT_NAME: "deepgram",
      }).name,
    ).toBe("deepgram");
  });
});

describe("GenericHttpSttService", () => {
  function stubFetch(
    seen: Array<{ url: string; headers: Record<string, string>; bytes: number }>,
    body: unknown,
    status = 200,
  ): typeof fetch {
    return (async (url: unknown, init: unknown) => {
      const headers = (init as { headers: Record<string, string> }).headers;
      const raw = (init as { body: Uint8Array }).body;
      seen.push({ url: String(url), headers, bytes: raw.byteLength });
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;
  }

  it("posts chunks to {url}/transcribe with the key and session, parsing finals", async () => {
    const seen: Array<{ url: string; headers: Record<string, string>; bytes: number }> = [];
    const service = new GenericHttpSttService({
      url: "https://stt.internal///",
      apiKey: "secret",
      name: "sidecar",
      fetchImpl: stubFetch(seen, {
        finals: [
          { text: "hello", speaker: "spk_01", start: 0.5, end: 1.2, confidence: 0.9 },
          { text: "  ", speaker: "spk_02" },
          { nope: true },
        ],
      }),
    });
    const session = service.createSession();
    const pushed = await session.push(new Uint8Array([1, 2, 3]));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://stt.internal/transcribe");
    expect(seen[0]!.headers.authorization).toBe("Bearer secret");
    expect(seen[0]!.headers["x-lucent-session"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen[0]!.headers["x-lucent-finalize"]).toBeUndefined();
    expect(seen[0]!.bytes).toBe(3);
    // Empty text and non-utterance shapes are dropped, never surfaced.
    expect(pushed).toEqual({
      utterances: [
        { text: "hello", speaker: "spk_01", startedAt: 0.5, endedAt: 1.2, confidence: 0.9 },
      ],
      // No verdict offered → null, never a guessed boolean.
      speech: null,
    });
    // Close finalizes (the header) and still reports the clock.
    const closed = await session.close();
    expect(seen).toHaveLength(2);
    expect(seen[1]!.headers["x-lucent-finalize"]).toBe("true");
    expect(closed.audioSeconds).toBeGreaterThanOrEqual(0);
  });

  it("forwards the sidecar's VAD verdict, degrading garbage to null", async () => {
    // docs/25 V5 stage 1: approximate boundaries, validated like finals.
    const verdict = (body: unknown) =>
      new GenericHttpSttService({
        url: "https://stt.internal",
        apiKey: "k",
        fetchImpl: stubFetch([], body),
      })
        .createSession()
        .push(new Uint8Array([1]));
    expect((await verdict({ finals: [], speech: true })).speech).toBe(true);
    expect((await verdict({ finals: [], speech: false })).speech).toBe(false);
    expect((await verdict({ finals: [] })).speech).toBeNull();
    expect((await verdict({ finals: [], speech: "yes" })).speech).toBeNull();
    expect((await verdict({ finals: [], speech: 1 })).speech).toBeNull();
  });

  it("throws on non-2xx and unparseable bodies — the route answers 502", async () => {
    const failing = new GenericHttpSttService({
      url: "https://stt.internal",
      apiKey: "k",
      fetchImpl: stubFetch([], { error: "bad" }, 500),
    });
    await expect(failing.createSession().push(new Uint8Array([1]))).rejects.toThrow("500");
    const garbage = new GenericHttpSttService({
      url: "https://stt.internal",
      apiKey: "k",
      fetchImpl: (async () => new Response("not json{{", { status: 200 })) as typeof fetch,
    });
    // Unparseable is not an utterance — and not a throw either: an empty
    // result degrades to silence, a 5xx to a loud failure.
    expect(await garbage.createSession().push(new Uint8Array([1]))).toEqual({
      utterances: [],
      speech: null,
    });
  });
});

describe("createSttSessionRegistry", () => {
  function fakeService(): {
    createSession: () => {
      push: () => Promise<{ utterances: []; speech: null }>;
      close: () => Promise<{ utterances: []; audioSeconds: number }>;
    };
  } {
    return {
      createSession: () => ({
        push: async () => ({ utterances: [], speech: null }) as { utterances: []; speech: null },
        close: async () => ({ utterances: [], audioSeconds: 0 }),
      }),
    };
  }

  it("creates, gets, touches bytes, and removes", () => {
    const registry = createSttSessionRegistry();
    const entry = registry.create("usr_1", "org_1", fakeService().createSession());
    expect(entry.id.startsWith("stt_")).toBe(true);
    expect(registry.get(entry.id)?.userId).toBe("usr_1");
    registry.touch(entry, 512);
    expect(registry.get(entry.id)?.audioBytes).toBe(512);
    expect(registry.remove(entry.id)).toBe(true);
    expect(registry.get(entry.id)).toBeUndefined();
    expect(registry.remove(entry.id)).toBe(false);
  });

  it("expires sessions lazily past the TTL and evicts the oldest past the cap", () => {
    let at = 0;
    const registry = createSttSessionRegistry({ now: () => at, ttlMs: 1000, maxSessions: 2 });
    const first = registry.create("u", undefined, fakeService().createSession());
    at += 1001;
    expect(registry.get(first.id)).toBeUndefined();
    const a = registry.create("u", undefined, fakeService().createSession());
    const b = registry.create("u", undefined, fakeService().createSession());
    const c = registry.create("u", undefined, fakeService().createSession());
    expect(registry.size()).toBe(2);
    expect(registry.get(a.id)).toBeUndefined();
    expect(registry.get(b.id)).toBeDefined();
    expect(registry.get(c.id)).toBeDefined();
  });
});

describe("serverStt org switch (docs/25 §3.1)", () => {
  it("absent is allowed; disabled refuses; garbage fails closed", () => {
    expect(serverSttRefusal(effectiveSettings(undefined))).toBeNull();
    expect(serverSttRefusal(effectiveSettings({ settings: { serverStt: "allowed" } }))).toBeNull();
    expect(serverSttRefusal(effectiveSettings({ settings: { serverStt: "disabled" } }))).toContain(
      "disables server-hosted transcription",
    );
    expect(
      serverSttRefusal(effectiveSettings({ settings: { serverStt: "sometimes" as never } })),
    ).not.toBeNull();
  });

  it("parseOrgSettings accepts the switch strictly", () => {
    expect(parseOrgSettings({ serverStt: "disabled" })).toEqual({
      ok: true,
      settings: { serverStt: "disabled" },
    });
    expect(parseOrgSettings({ serverStt: "sometimes" }).ok).toBe(false);
  });
});
