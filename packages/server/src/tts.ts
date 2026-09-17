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
  LUCENT_TTS_URL?: string;
  LUCENT_TTS_NAME?: string;
  LUCENT_TTS_VOICE?: string;
}

/** Key + URL means a live sidecar; anything less is the standby mock. */
export function selectTtsService(env: TtsEnv = process.env): TtsService {
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
