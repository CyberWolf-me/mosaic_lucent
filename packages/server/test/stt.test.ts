import { describe, expect, it, vi } from "vitest";
import type { IncomingMessage } from "node:http";
import { WebSocketServer } from "ws";
import {
  DeepgramStreamingSttService,
  DeepgramSttService,
  GenericHttpSttService,
  MockSttService,
  OpenAiSttService,
  createSttSessionRegistry,
  deepgramSpeaker,
  groupWordsIntoUtterances,
  mapDeepgramTranscript,
  mapOpenAiTranscript,
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

  it("selects the Deepgram adapter on provider=deepgram, and fails loud on typos", () => {
    const dg = selectSttService({ LUCENT_STT_KEY: "k", LUCENT_STT_PROVIDER: "deepgram" });
    expect(dg.live).toBe(true);
    expect(dg.name).toBe("deepgram");
    // Keyless deepgram is standby (503), never a silent anything.
    expect(selectSttService({ LUCENT_STT_PROVIDER: "deepgram" }).live).toBe(false);
    expect(() => selectSttService({ LUCENT_STT_PROVIDER: "deepfgram" })).toThrow(
      "LUCENT_STT_PROVIDER",
    );
  });

  it("selects the OpenAI adapter on provider=openai (own key or the shared one)", () => {
    expect(selectSttService({ LUCENT_STT_KEY: "k", LUCENT_STT_PROVIDER: "openai" }).name).toBe(
      "openai",
    );
    expect(selectSttService({ OPENAI_API_KEY: "k", LUCENT_STT_PROVIDER: "openai" }).name).toBe(
      "openai",
    );
    expect(selectSttService({ LUCENT_STT_PROVIDER: "openai" }).live).toBe(false);
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

describe("DeepgramSttService", () => {
  const UTTERANCES_BODY = {
    metadata: { duration: 4.5 },
    results: {
      utterances: [
        {
          transcript: "hello there",
          start: 0.5,
          end: 1.5,
          speaker: 0,
          words: [
            { word: "hello", start: 0.5, end: 0.9, confidence: 0.9 },
            { word: "there", start: 1.0, end: 1.5, confidence: 0.8 },
          ],
        },
        {
          transcript: "hi back",
          start: 2.0,
          end: 3.0,
          speaker: 1,
          words: [{ word: "hi", start: 2.0, end: 2.4, confidence: 0.7 }],
        },
        { transcript: "   ", start: 3.0, end: 3.2 },
      ],
    },
  };

  function stubDeepgram(
    seen: Array<{ url: string; headers: Record<string, string>; bytes: number }>,
    body: unknown,
    status = 200,
  ): typeof fetch {
    return (async (url: unknown, init: unknown) => {
      const typed = init as { headers: Record<string, string>; body: Uint8Array };
      seen.push({ url: String(url), headers: typed.headers, bytes: typed.body.byteLength });
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;
  }

  it("buffers chunks and transcribes once at close with Token auth", async () => {
    const seen: Array<{ url: string; headers: Record<string, string>; bytes: number }> = [];
    const service = new DeepgramSttService({
      apiKey: "dg-test",
      fetchImpl: stubDeepgram(seen, UTTERANCES_BODY),
    });
    expect(service.name).toBe("deepgram");
    const session = service.createSession();
    // REST+diarization correctness: pushes buffer, never finalize early —
    // per-chunk labels would restart per request and merge strangers.
    expect(await session.push(new Uint8Array([1, 2]))).toEqual({ utterances: [], speech: null });
    expect(await session.push(new Uint8Array([3]))).toEqual({ utterances: [], speech: null });
    expect(seen).toHaveLength(0);
    const closed = await session.close();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toContain("https://api.deepgram.com/v1/listen?");
    expect(seen[0]!.url).toContain("diarize_model=latest");
    expect(seen[0]!.url).toContain("utterances=true");
    expect(seen[0]!.headers.authorization).toBe("Token dg-test");
    expect(seen[0]!.bytes).toBe(3);
    expect(closed.utterances).toEqual([
      {
        text: "hello there",
        speaker: "spk_01",
        startedAt: 0.5,
        endedAt: 1.5,
        confidence: 0.85,
      },
      { text: "hi back", speaker: "spk_02", startedAt: 2.0, endedAt: 3.0, confidence: 0.7 },
    ]);
    // Duration comes from the response metadata, never a byte guess.
    expect(closed.audioSeconds).toBe(4.5);
  });

  it("empty sessions close silently; failures throw for the route's 502", async () => {
    const empty = new DeepgramSttService({
      apiKey: "k",
      fetchImpl: stubDeepgram([], UTTERANCES_BODY),
    });
    expect(await empty.createSession().close()).toEqual({ utterances: [], audioSeconds: 0 });
    const failing = new DeepgramSttService({
      apiKey: "k",
      fetchImpl: stubDeepgram([], { error: "nope" }, 401),
    });
    const session = failing.createSession();
    await session.push(new Uint8Array([1]));
    await expect(session.close()).rejects.toThrow("401");
  });

  describe("DeepgramStreamingSttService (V8 continuous transport)", () => {
    interface StubScript {
      /** Authorization header the stub saw (Token scheme, like REST). */
      auth?: string;
      /** Query string of the listen URL. */
      query?: string;
      binaries: number;
      closeStreams: number;
      connections: number;
    }

    function finalResults(text: string, speaker: number, start: number): string {
      const words = text.split(" ").map((word, i) => ({
        word,
        start: start + i * 0.2,
        end: start + (i + 1) * 0.2,
        confidence: 0.9,
        speaker,
      }));
      return JSON.stringify({
        type: "Results",
        is_final: true,
        duration: start + words.length * 0.2,
        channel: { alternatives: [{ transcript: text, confidence: 0.9, words }] },
      });
    }

    /** A local stand-in speaking the streaming protocol (real WS wire). */
    async function withStub(
      onBinary: (data: Buffer, send: (msg: string) => void, state: { n: number }) => void,
      run: (url: string, seen: StubScript) => Promise<void>,
    ): Promise<StubScript> {
      const seen: StubScript = { binaries: 0, closeStreams: 0, connections: 0 };
      const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      await new Promise<void>((resolve) => wss.on("listening", resolve));
      const addr = wss.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      wss.on("connection", (ws: import("ws").WebSocket, req: IncomingMessage) => {
        seen.connections += 1;
        const auth = req.headers.authorization;
        seen.auth = Array.isArray(auth) ? auth[0] : auth;
        seen.query = (req.url ?? "").split("?")[1] ?? "";
        const state = { n: 0 };
        ws.on("message", (data: import("ws").RawData, isBinary: boolean) => {
          if (isBinary) {
            seen.binaries += 1;
            state.n += 1;
            onBinary(Buffer.from(data as Uint8Array), (msg) => ws.send(msg), state);
            return;
          }
          const text = data.toString();
          if (text.includes("CloseStream")) {
            seen.closeStreams += 1;
            ws.close(1000);
          }
        });
      });
      try {
        await run(`ws://127.0.0.1:${port}`, seen);
      } finally {
        wss.close();
      }
      return seen;
    }

    /** Empty pushes are the deterministic collect pump: no send, just drain. */
    async function collect(
      session: {
        push(chunk: Uint8Array): Promise<{ utterances: SttUtterance[]; speech: boolean | null }>;
      },
      want = 1,
    ): Promise<SttUtterance[]> {
      const deadline = Date.now() + 3000;
      for (;;) {
        const r = await session.push(new Uint8Array(0));
        if (r.utterances.length >= want) return r.utterances;
        if (Date.now() > deadline) throw new Error("timed out waiting for streamed finals");
        await new Promise((r2) => setTimeout(r2, 25));
      }
    }

    function streamingService(url: string) {
      return new DeepgramStreamingSttService({ apiKey: "dg-test", wsUrl: url });
    }

    it("streams finals per chunk with stable speaker labels + Token auth + diarize params", async () => {
      const seen = await withStub(
        (data, send, state) => {
          send(
            finalResults(
              state.n === 1 ? "hello world" : "second turn",
              state.n === 1 ? 0 : 1,
              state.n,
            ),
          );
        },
        async (url, seenInner) => {
          const session = streamingService(url).createSession();
          // Sends ride the socket; arrivals drain on later pushes — the
          // first push asserts nothing about content (the reply races it).
          await session.push(new Uint8Array([1, 2]));
          expect(await collect(session)).toEqual([
            {
              text: "hello world",
              speaker: "spk_01",
              startedAt: 1,
              endedAt: 1.4,
              confidence: 0.9,
            },
          ]);
          await session.push(new Uint8Array([3, 4]));
          expect(await collect(session)).toEqual([
            {
              text: "second turn",
              speaker: "spk_02",
              startedAt: 2,
              endedAt: 2.4,
              confidence: 0.9,
            },
          ]);
          // Labels do NOT restart per chunk: chunk 2's speaker 1 is spk_02
          // against chunk 1's spk_01 — the whole point of the socket.
          const closed = await session.close();
          expect(closed.utterances).toEqual([]);
          expect(closed.audioSeconds).toBeGreaterThan(0);
          expect(seenInner.auth).toBe("Token dg-test");
          expect(seenInner.query).toContain("diarize=true");
          expect(seenInner.query).toContain("interim_results=true");
          expect(seenInner.query).toContain("vad_events=true");
          expect(seenInner.closeStreams).toBe(1);
        },
      );
      expect(seen.binaries).toBe(2);
    });

    it("drops interim results and latches VAD onset exactly once", async () => {
      await withStub(
        (data, send, state) => {
          if (state.n === 1) {
            send(
              JSON.stringify({
                type: "Results",
                is_final: false,
                channel: { alternatives: [{ transcript: "hel", words: [] }] },
              }),
            );
            send(JSON.stringify({ type: "SpeechStarted", channel_index: [0] }));
          } else {
            send(finalResults("hello", 0, 0));
          }
        },
        async (url) => {
          const session = streamingService(url).createSession();
          await session.push(new Uint8Array([9]));
          // Interim never becomes an utterance; the onset latches. Poll:
          // the SpeechStarted reply races the pushes by design.
          const seenUtterances: SttUtterance[] = [];
          let latched = false;
          const deadline = Date.now() + 3000;
          for (;;) {
            const r = await session.push(new Uint8Array(0));
            seenUtterances.push(...r.utterances);
            if (r.speech === true) {
              latched = true;
              break;
            }
            if (Date.now() > deadline) break;
            await new Promise((r2) => setTimeout(r2, 25));
          }
          expect(latched).toBe(true);
          expect(seenUtterances).toEqual([]);
          // Reported exactly once: the next drain is quiet again.
          expect((await session.push(new Uint8Array(0))).speech).toBe(null);
          await session.push(new Uint8Array([9]));
          expect(await collect(session)).toEqual([
            { text: "hello", speaker: "spk_01", startedAt: 0, endedAt: 0.2, confidence: 0.9 },
          ]);
          await session.close();
        },
      );
    });

    it("provider errors fail loud: push and close throw, never empty-finals", async () => {
      await withStub(
        (data, send) => {
          send(JSON.stringify({ type: "Error", description: "quota exceeded" }));
        },
        async (url) => {
          const session = streamingService(url).createSession();
          // The Error reply races the send: poll until the latch trips —
          // from then on every call fails, which is the guarantee.
          await session.push(new Uint8Array([1])).catch(() => {});
          await vi.waitFor(async () => {
            await expect(session.push(new Uint8Array([7]))).rejects.toThrow("quota exceeded");
          });
          await expect(session.close()).rejects.toThrow("quota exceeded");
        },
      );
    });

    it("an unreachable endpoint fails at first audio, not at session create", async () => {
      const service = new DeepgramStreamingSttService({
        apiKey: "k",
        wsUrl: "ws://127.0.0.1:1",
        timeoutMs: 500,
      });
      const session = service.createSession();
      // createSession is sync by interface: the socket dials on first audio.
      await expect(session.push(new Uint8Array([1]))).rejects.toThrow();
    });

    it("close with no audio never dials and reports zero", async () => {
      const seen = await withStub(
        () => {},
        async (url) => {
          const session = streamingService(url).createSession();
          expect(await session.close()).toEqual({ utterances: [], audioSeconds: 0 });
        },
      );
      expect(seen.connections).toBe(0);
    });

    it("selectSttService picks streaming behind LUCENT_STT_STREAMING=1", () => {
      expect(
        selectSttService({
          LUCENT_STT_PROVIDER: "deepgram",
          LUCENT_STT_KEY: "k",
          LUCENT_STT_STREAMING: "1",
        }).name,
      ).toBe("deepgram-stream");
      expect(selectSttService({ LUCENT_STT_PROVIDER: "deepgram", LUCENT_STT_KEY: "k" }).name).toBe(
        "deepgram",
      );
    });

    it("groupWordsIntoUtterances: cuts on speaker change, silence on empty", () => {
      expect(groupWordsIntoUtterances([])).toEqual([]);
      expect(
        groupWordsIntoUtterances([
          { word: "a", speaker: 0, start: 0, end: 0.1, confidence: 1 },
          { word: "b", speaker: 1, start: 0.2, end: 0.3, confidence: 1 },
        ]),
      ).toEqual([
        { text: "a", speaker: "spk_01", startedAt: 0, endedAt: 0.1, confidence: 1 },
        { text: "b", speaker: "spk_02", startedAt: 0.2, endedAt: 0.3, confidence: 1 },
      ]);
    });
  });

  it("mapDeepgramTranscript degrades: words, then bare transcript, then silence", () => {
    expect(deepgramSpeaker(0)).toBe("spk_01");
    expect(deepgramSpeaker(11)).toBe("spk_12");
    // Words grouped by speaker when utterances are absent.
    const grouped = mapDeepgramTranscript({
      metadata: {},
      results: {
        channels: [
          {
            alternatives: [
              {
                transcript: "a b",
                words: [
                  { word: "a", speaker: 0, start: 0, end: 1, confidence: 1 },
                  { word: "b", speaker: 2, start: 1, end: 2, confidence: 1 },
                ],
              },
            ],
          },
        ],
      },
    });
    expect(grouped.utterances.map((u) => [u.text, u.speaker])).toEqual([
      ["a", "spk_01"],
      ["b", "spk_03"],
    ]);
    // Bare transcript with no words: unattributed but present.
    const bare = mapDeepgramTranscript({
      results: { channels: [{ alternatives: [{ transcript: "solo" }] }] },
    });
    expect(bare.utterances).toEqual([{ text: "solo" }]);
    // Garbage is silence, never invention.
    expect(mapDeepgramTranscript(null)).toEqual({ utterances: [], durationSeconds: 0 });
    expect(mapDeepgramTranscript({ results: {} })).toEqual({ utterances: [], durationSeconds: 0 });
  });
});

describe("OpenAiSttService (UNVERIFIED — no key has exercised this path)", () => {
  function stubTranscribe(
    seen: Array<{ url: string; headers: Record<string, string>; multipart: boolean }>,
    body: unknown,
    status = 200,
  ): typeof fetch {
    return (async (url: unknown, init: unknown) => {
      const typed = init as { headers: Record<string, string>; body: unknown };
      seen.push({
        url: String(url),
        headers: typed.headers,
        multipart: typeof (typed.body as FormData)?.get === "function",
      });
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;
  }

  it("buffers to close, uploads multipart with Bearer auth, maps segments", async () => {
    const seen: Array<{ url: string; headers: Record<string, string>; multipart: boolean }> = [];
    const service = new OpenAiSttService({
      apiKey: "sk-test",
      fetchImpl: stubTranscribe(seen, {
        text: "full",
        segments: [
          { text: "hello", speaker: "SPEAKER_00", start: 0.0, end: 1.0 },
          { text: "hi", speaker: 1, start: 1.0, end: 2.0 },
          { text: "  " },
        ],
      }),
    });
    expect(service.name).toBe("openai");
    const session = service.createSession();
    expect(await session.push(new Uint8Array([1]))).toEqual({ utterances: [], speech: null });
    expect(seen).toHaveLength(0);
    const closed = await session.close();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(seen[0]!.headers.authorization).toBe("Bearer sk-test");
    expect(seen[0]!.multipart).toBe(true);
    expect(closed.utterances).toEqual([
      { text: "hello", speaker: "SPEAKER_00", startedAt: 0, endedAt: 1 },
      { text: "hi", speaker: "spk_02", startedAt: 1, endedAt: 2 },
    ]);
  });

  it("mapOpenAiTranscript degrades: segments, then bare text, then silence", () => {
    expect(mapOpenAiTranscript({ text: "solo", segments: [{ text: "  " }] })).toEqual([
      { text: "solo" },
    ]);
    expect(mapOpenAiTranscript(null)).toEqual([]);
    expect(mapOpenAiTranscript({})).toEqual([]);
  });

  it("throws on non-2xx for the route's 502", async () => {
    const failing = new OpenAiSttService({
      apiKey: "k",
      fetchImpl: stubTranscribe([], { error: "bad" }, 401),
    });
    const session = failing.createSession();
    await session.push(new Uint8Array([1]));
    await expect(session.close()).rejects.toThrow("401");
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
