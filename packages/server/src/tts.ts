/**
 * Server text-to-speech proxy (docs/25 V7, M6.2).
 *
 * The browser must never hold a TTS key, so synthesis is proxied exactly
 * like hosted STT: text rides an authed POST in, audio bytes ride back,
 * the key stays in this process. The default service is the standby mock
 * (transcribes — synthesizes — nothing); unconfigured deployments answer
 * 503 and the client falls back to local speech synthesis, never to faked
 * audio. A mock that returned canned speech would put words in Lucent's
 * mouth that no model said.
 */

export interface TtsSynthesis {
  audio: Uint8Array;
  contentType: string;
}

export interface TtsService {
  /** Surfaced in metering, responses, and logs. */
  readonly name: string;
  /** False when this service synthesizes nothing: the route 503s. */
  readonly live: boolean;
  synthesize(input: { text: string; voice?: string }): Promise<TtsSynthesis>;
}

/**
 * The offline double. Unscripted it synthesizes nothing (standby); scripted
 * bytes stand in for a live sidecar in tests. `live` is true only when
 * scripted — the route's 503-vs-200 behavior keys on exactly this flag.
 */
export class MockTtsService implements TtsService {
  readonly name = "mock";
  readonly live: boolean;

  constructor(private readonly script?: { audio: Uint8Array; contentType?: string }) {
    this.live = script !== undefined;
  }

  async synthesize(input: { text: string }): Promise<TtsSynthesis> {
    if (!this.script || input.text.trim() === "") throw new Error("mock TTS is standby");
    return { audio: this.script.audio, contentType: this.script.contentType ?? "audio/mpeg" };
  }
}

/**
 * An OpenAI-style speech sidecar (`POST {url}/v1/audio/speech`,
 * `{input, voice?}` → audio bytes). Bearer key, timeout, non-2xx and empty
 * bodies throw — the route answers 502, the "provider failed" shape. No
 * vendor is live-verified in this repo; named-vendor adapters arrive
 * against the `TtsService` interface, not as route edits.
 */
export class GenericHttpTtsService implements TtsService {
  readonly name: string;
  readonly live = true;

  constructor(
    private readonly options: {
      url: string;
      apiKey: string;
      name?: string;
      voice?: string;
      timeoutMs?: number;
      fetchImpl?: typeof fetch;
    },
  ) {
    this.name = options.name ?? "custom-http";
  }

  async synthesize(input: { text: string; voice?: string }): Promise<TtsSynthesis> {
    const endpoint = this.options.url.replace(/\/+$/, "") + "/v1/audio/speech";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 30_000);
    try {
      const res = await (this.options.fetchImpl ?? fetch)(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify({
          input: input.text,
          ...((input.voice ?? this.options.voice)
            ? { voice: input.voice ?? this.options.voice }
            : {}),
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`sidecar answered ${res.status}`);
      const buffer = new Uint8Array(await res.arrayBuffer());
      if (buffer.byteLength === 0) throw new Error("sidecar returned no audio");
      return {
        audio: buffer,
        contentType: res.headers.get("content-type")?.split(";")[0]?.trim() || "audio/mpeg",
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface TtsEnv {
  LUCENT_TTS_KEY?: string;
  LUCENT_STT_KEY?: string;
  OPENAI_API_KEY?: string;
  LUCENT_TTS_URL?: string;
  LUCENT_TTS_NAME?: string;
  LUCENT_TTS_VOICE?: string;
  /**
   * "deepgram" selects the Aura adapter, "openai" the OpenAI speech
   * adapter; anything else is the generic sidecar contract. Unknown names
   * fail loud at boot (same rule as STT).
   */
  LUCENT_TTS_PROVIDER?: string;
  LUCENT_DEEPGRAM_TTS_MODEL?: string;
  LUCENT_DEEPGRAM_TTS_ENCODING?: string;
  LUCENT_DEEPGRAM_TTS_SAMPLE_RATE?: string;
  LUCENT_OPENAI_TTS_MODEL?: string;
  LUCENT_OPENAI_TTS_VOICE?: string;
  LUCENT_TTS_TIMEOUT_MS?: string;
}

/**
 * OpenAI speech (`POST {base}/v1/audio/speech`, `{model, input, voice?}` →
 * audio bytes, Bearer key). UNVERIFIED — no key has ever exercised this
 * path; the shape follows the long-stable speech endpoint, and the first
 * live run owns confirming it. Until then it is a reviewed stub with
 * strict tests, not a claim.
 */
export class OpenAiTtsService implements TtsService {
  readonly name = "openai";
  readonly live = true;

  constructor(
    private readonly options: {
      apiKey: string;
      baseUrl?: string;
      model?: string;
      voice?: string;
      timeoutMs?: number;
      fetchImpl?: typeof fetch;
    },
  ) {}

  async synthesize(input: { text: string; voice?: string }): Promise<TtsSynthesis> {
    const text = input.text.trim();
    if (text === "") throw new Error("nothing to speak");
    const base = (this.options.baseUrl ?? "https://api.openai.com").replace(/\/+$/, "");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 60_000);
    try {
      const res = await (this.options.fetchImpl ?? fetch)(`${base}/v1/audio/speech`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify({
          model: this.options.model ?? "tts-1",
          input: text,
          voice: input.voice ?? this.options.voice ?? "alloy",
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`openai answered ${res.status}`);
      const buffer = new Uint8Array(await res.arrayBuffer());
      if (buffer.byteLength === 0) throw new Error("openai returned no audio");
      return {
        audio: buffer,
        contentType: res.headers.get("content-type")?.split(";")[0]?.trim() || "audio/mpeg",
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Deepgram Aura speech (`POST {base}/v1/speak?model=<voice>`,
 * `{ "text" }` → audio bytes, auth `Token`). One Deepgram project key
 * serves STT, TTS, and the voice agent alike, so the key falls back to
 * `LUCENT_STT_KEY` when no dedicated TTS key is set — documented, not
 * magic: same vendor, same project, one credential.
 */
export class DeepgramTtsService implements TtsService {
  readonly name = "deepgram";
  readonly live = true;

  constructor(
    private readonly options: {
      apiKey: string;
      baseUrl?: string;
      model?: string;
      encoding?: string;
      sampleRate?: number;
      timeoutMs?: number;
      fetchImpl?: typeof fetch;
    },
  ) {}

  async synthesize(input: { text: string; voice?: string }): Promise<TtsSynthesis> {
    const text = input.text.trim();
    if (text === "") throw new Error("nothing to speak");
    const base = (this.options.baseUrl ?? "https://api.deepgram.com").replace(/\/+$/, "");
    // Per-request voice wins (Aura voice id), then the deployment default.
    // Encoding/sample-rate are deployment-wide: callers ask for words, the
    // operator decides the wire format (mp3 default; linear16 for PCM work).
    const params = new URLSearchParams({
      model: input.voice ?? this.options.model ?? "aura-2-thalia-en",
    });
    if (this.options.encoding) params.set("encoding", this.options.encoding);
    if (this.options.sampleRate) params.set("sample_rate", String(this.options.sampleRate));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 60_000);
    try {
      const res = await (this.options.fetchImpl ?? fetch)(`${base}/v1/speak?${params}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Token ${this.options.apiKey}`,
        },
        body: JSON.stringify({ text }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`deepgram answered ${res.status}`);
      const buffer = new Uint8Array(await res.arrayBuffer());
      if (buffer.byteLength === 0) throw new Error("deepgram returned no audio");
      return {
        audio: buffer,
        contentType: res.headers.get("content-type")?.split(";")[0]?.trim() || "audio/mpeg",
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Key + provider means a live vendor; key + URL (no provider) means the
 * generic sidecar contract; anything less is the standby mock. Unknown
 * provider names fail loud at boot, same rule as STT.
 */
export function selectTtsService(env: TtsEnv = process.env): TtsService {
  const provider = (env.LUCENT_TTS_PROVIDER ?? "http").toLowerCase();
  if (provider === "openai") {
    const apiKey = env.LUCENT_TTS_KEY ?? env.LUCENT_STT_KEY ?? env.OPENAI_API_KEY;
    if (!apiKey) return new MockTtsService();
    return new OpenAiTtsService({
      apiKey,
      ...(env.LUCENT_TTS_URL ? { baseUrl: env.LUCENT_TTS_URL } : {}),
      ...(env.LUCENT_OPENAI_TTS_MODEL ? { model: env.LUCENT_OPENAI_TTS_MODEL } : {}),
      ...(env.LUCENT_TTS_VOICE ? { voice: env.LUCENT_TTS_VOICE } : {}),
      ...(env.LUCENT_TTS_TIMEOUT_MS && Number.isFinite(Number(env.LUCENT_TTS_TIMEOUT_MS))
        ? { timeoutMs: Number(env.LUCENT_TTS_TIMEOUT_MS) }
        : {}),
    });
  }
  if (provider === "deepgram") {
    const apiKey = env.LUCENT_TTS_KEY ?? env.LUCENT_STT_KEY;
    if (!apiKey) return new MockTtsService();
    return new DeepgramTtsService({
      apiKey,
      ...(env.LUCENT_TTS_URL ? { baseUrl: env.LUCENT_TTS_URL } : {}),
      ...(env.LUCENT_DEEPGRAM_TTS_MODEL ? { model: env.LUCENT_DEEPGRAM_TTS_MODEL } : {}),
      ...(env.LUCENT_DEEPGRAM_TTS_ENCODING ? { encoding: env.LUCENT_DEEPGRAM_TTS_ENCODING } : {}),
      ...(env.LUCENT_DEEPGRAM_TTS_SAMPLE_RATE &&
      Number.isFinite(Number(env.LUCENT_DEEPGRAM_TTS_SAMPLE_RATE))
        ? { sampleRate: Number(env.LUCENT_DEEPGRAM_TTS_SAMPLE_RATE) }
        : {}),
      ...(env.LUCENT_TTS_TIMEOUT_MS && Number.isFinite(Number(env.LUCENT_TTS_TIMEOUT_MS))
        ? { timeoutMs: Number(env.LUCENT_TTS_TIMEOUT_MS) }
        : {}),
    });
  }
  if (provider !== "http") {
    throw new Error(
      `LUCENT_TTS_PROVIDER="${env.LUCENT_TTS_PROVIDER}" is unknown (expected "http", "deepgram" or "openai")`,
    );
  }
  const apiKey = env.LUCENT_TTS_KEY;
  const url = env.LUCENT_TTS_URL;
  if (apiKey && url) {
    return new GenericHttpTtsService({
      url,
      apiKey,
      ...(env.LUCENT_TTS_NAME ? { name: env.LUCENT_TTS_NAME } : {}),
      ...(env.LUCENT_TTS_VOICE ? { voice: env.LUCENT_TTS_VOICE } : {}),
    });
  }
  return new MockTtsService();
}
