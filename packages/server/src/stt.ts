import { randomUUID } from "node:crypto";
import WebSocket from "ws";

/**
 * Server speech-to-text (docs/25 V1 — the diarizing slot).
 *
 * Lucent's STT seam lived client-side only (`web/src/stt/`: browser, Whisper,
 * LiveKit). A diarizing cloud provider cannot live there: API keys must never
 * reach the browser (AGENTS.md non-negotiables), so the fourth slot is a
 * server session — audio chunks ride authed POSTs, transcript finals come
 * back with speaker labels, and the key stays in this process exactly like
 * the model key.
 *
 * HONESTY RULES, stated because a transcription seam is where fake
 * helpfulness would do the most damage:
 *
 * - The default service is the mock, and the mock transcribes NOTHING. An
 *   unseeded `MockSttService` accepts chunks and returns no finals — a
 *   session against it yields no turns, never invented ones. Seeded scripts
 *   exist for tests only and are unreachable from any route.
 * - `live` tells the route (and through it the client) whether real
 *   transcription happens. An unconfigured deployment answers 503 — the same
 *   fail-open shape as LiveKit — instead of silently swallowing speech.
 * - Audio is EPHEMERAL (paste §2 of the production advisory, docs/20 §2):
 *   chunks live in the session handle and die with it. Nothing here touches
 *   Postgres; sessions are per-process like presence, with the same
 *   sticky-session caveat the checklist already records.
 */

/** One finalized, speaker-attributed span of speech. */
export interface SttUtterance {
  text: string;
  /**
   * Who spoke, as an opaque label (`spk_01`, a room identity — never a
   * person until something maps it). Absent when the provider does not
   * know; the client falls back to its honest default rather than a guess.
   */
  speaker?: string;
  /** Provider timestamps, when offered. Informational only. */
  startedAt?: number;
  endedAt?: number;
  /**
   * Provider confidence 0..1, when offered. Accepted and passed through;
   * acted on by nothing yet (a field nobody acts on stays inert).
   */
  confidence?: number;
}

/** One live transcription session: chunks in, finals out. */
export interface SttSession {
  /**
   * Offer audio bytes (any container the provider accepts — the client
   * sends MediaRecorder slices; the mock counts them). Returns the
   * utterances that finalized BECAUSE of this chunk, plus the sidecar's
   * VAD verdict on the delivered audio when it offers one (`speech`, docs/25
   * V5 stage 1: approximate boundaries inferred within chunks, not true
   * realtime onset — that needs the V8 transport; no consumer reads this
   * yet except the route, which forwards it).
   */
  push(chunk: Uint8Array): Promise<SttChunkResult>;
  /**
   * End the session: flush whatever finalized at the boundary and report
   * how much audio the session consumed (the voice-minutes meter reads
   * this, not a guess from byte counts — codecs lie about duration).
   */
  close(): Promise<{ utterances: SttUtterance[]; audioSeconds: number }>;
}

/** What one chunk produced: new finals, and the VAD verdict if offered. */
export interface SttChunkResult {
  utterances: SttUtterance[];
  /** The sidecar's speech verdict on this chunk; null when unoffered. */
  speech: boolean | null;
}

export interface SttService {
  /** The provider name surfaced in metering, the session response, and logs. */
  readonly name: string;
  /** False when this service transcribes nothing (offline mock): the route 503s. */
  readonly live: boolean;
  createSession(): SttSession;
}

/**
 * The offline double. Unseeded it is pure standby: chunks are accepted (so
 * the route's plumbing is exercisable) and no utterance ever finalizes.
 * A seeded script emits one utterance per `bytesPerUtterance` bytes pushed,
 * in order, then goes quiet — deterministic speaker labels for the route
 * and client tests. `live` is true only when seeded: a seeded mock stands
 * in for a live vendor in tests, and the route's 503-vs-200 behavior is
 * decided by exactly this flag.
 */
export class MockSttService implements SttService {
  readonly name = "mock";
  readonly live: boolean;
  private readonly script: SttUtterance[];
  private readonly bytesPerUtterance: number;
  private readonly now: () => number;

  constructor(
    options: { script?: SttUtterance[]; bytesPerUtterance?: number; now?: () => number } = {},
  ) {
    this.script = [...(options.script ?? [])];
    this.bytesPerUtterance = Math.max(1, options.bytesPerUtterance ?? 1024);
    this.now = options.now ?? Date.now;
    this.live = this.script.length > 0;
  }

  createSession(): SttSession {
    let pending = 0;
    let cursor = 0;
    const script = this.script;
    const stride = this.bytesPerUtterance;
    const now = this.now;
    const startedAt = now();
    const result = (utterances: SttUtterance[]): SttChunkResult => ({ utterances, speech: null });
    return {
      async push(chunk: Uint8Array): Promise<SttChunkResult> {
        pending += chunk.byteLength;
        const out: SttUtterance[] = [];
        while (pending >= stride && cursor < script.length) {
          pending -= stride;
          out.push(script[cursor]!);
          cursor += 1;
        }
        // Bytes beyond an exhausted script are absorbed, never invented
        // into: the mock must not hallucinate speech that never arrived.
        // The mock has no VAD: verdict null, always.
        if (cursor >= script.length) pending = 0;
        return result(out);
      },
      async close(): Promise<{ utterances: SttUtterance[]; audioSeconds: number }> {
        return { utterances: [], audioSeconds: Math.max(0, (now() - startedAt) / 1000) };
      },
    };
  }
}

/**
 * A self-hosted (or vendor-compatible) diarizing sidecar behind a minimal
 * documented contract, chosen the way `selectImageProvider` chooses: key +
 * URL configured means live, otherwise the mock.
 *
 * Contract (POST `{url}/transcribe`, Bearer key, binary body):
 * request carries `x-lucent-session` (opaque id) and `x-lucent-finalize:
 * true` on the closing call; response JSON is `{ finals?: Array<{ text:
 * string, speaker?: string, start?: number, end?: number, confidence?:
 * number }>, speech?: boolean }`, where `speech` is the sidecar's VAD
 * verdict on the delivered chunk (docs/25 V5 stage 1 — approximate
 * boundaries within chunks, never true onset). Anything
 * else — non-2xx, unparseable body, timeout — throws and the route answers
 * 502, the same "provider failed" shape generation uses. No vendor is
 * live-verified in this repo; Deepgram/OpenAI adapters arrive as follow-ups
 * against this interface, not as edits to the routes.
 */
export class GenericHttpSttService implements SttService {
  readonly name: string;
  readonly live = true;

  constructor(
    private readonly options: {
      url: string;
      apiKey: string;
      name?: string;
      timeoutMs?: number;
      fetchImpl?: typeof fetch;
    },
  ) {
    this.name = options.name ?? "custom-http";
  }

  createSession(): SttSession {
    const sessionId = randomUUID();
    const startedAt = Date.now();
    const timeoutMs = this.options.timeoutMs ?? 30_000;
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const sendChunk = async (chunk: Uint8Array, finalize: boolean): Promise<SttChunkResult> => {
      const endpoint = this.options.url.replace(/\/+$/, "") + "/transcribe";
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/octet-stream",
            authorization: `Bearer ${this.options.apiKey}`,
            "x-lucent-session": sessionId,
            ...(finalize ? { "x-lucent-finalize": "true" } : {}),
          },
          body: chunk,
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`sidecar answered ${res.status}`);
        const body = (await res.json().catch(() => null)) as {
          finals?: Array<{
            text?: unknown;
            speaker?: unknown;
            start?: unknown;
            end?: unknown;
            confidence?: unknown;
          }>;
          speech?: unknown;
        } | null;
        if (!body) return { utterances: [], speech: null };
        // Validate minimally: model output is untrusted input, and a sidecar
        // that echoes garbage must not become turns on a board. The VAD
        // verdict degrades to null (unknown), never to a guessed boolean.
        const speech = typeof body.speech === "boolean" ? body.speech : null;
        if (!Array.isArray(body.finals)) return { utterances: [], speech };
        const utterances = body.finals.flatMap((f) =>
          typeof f.text === "string" && f.text.trim() !== ""
            ? [
                {
                  text: f.text,
                  ...(typeof f.speaker === "string" && f.speaker !== ""
                    ? { speaker: f.speaker }
                    : {}),
                  ...(typeof f.start === "number" ? { startedAt: f.start } : {}),
                  ...(typeof f.end === "number" ? { endedAt: f.end } : {}),
                  ...(typeof f.confidence === "number" && f.confidence >= 0 && f.confidence <= 1
                    ? { confidence: f.confidence }
                    : {}),
                },
              ]
            : [],
        );
        return { utterances, speech };
      } finally {
        clearTimeout(timer);
      }
    };
    return {
      push: (chunk: Uint8Array) => sendChunk(chunk, false),
      close: async () => {
        const { utterances } = await sendChunk(new Uint8Array(0), true);
        return {
          utterances,
          audioSeconds: Math.max(0, (Date.now() - startedAt) / 1000),
        };
      },
    };
  }
}

export interface SttEnv {
  LUCENT_STT_KEY?: string;
  LUCENT_STT_URL?: string;
  LUCENT_STT_NAME?: string;
  /** "deepgram" / "openai" select vendor adapters; anything else is the generic contract. */
  LUCENT_STT_PROVIDER?: string;
  LUCENT_DEEPGRAM_MODEL?: string;
  LUCENT_DEEPGRAM_CONTENT_TYPE?: string;
  /**
   * "1" selects the live-streaming Deepgram session (continuous finals +
   * VAD onset) instead of buffer-at-close. Default off until streaming
   * soaks: the flag, not a rewrite, is the rollout.
   */
  LUCENT_STT_STREAMING?: string;
  LUCENT_OPENAI_STT_MODEL?: string;
  LUCENT_OPENAI_CONTENT_TYPE?: string;
  LUCENT_STT_TIMEOUT_MS?: string;
  OPENAI_API_KEY?: string;
}

/**
 * OpenAI transcription (`POST {base}/v1/audio/transcriptions`,
 * multipart `{file, model, response_format: "verbose_json"}`, Bearer key).
 * Same REST+diarization mapping as Deepgram (buffer at close — per-chunk
 * labels would restart per request). UNVERIFIED — no key has ever exercised
 * this path; the shape follows the long-stable transcriptions endpoint plus
 * the documented diarization segment fields, and every field is parsed
 * defensively (absent speaker/timing degrades to unattributed/untimed, the
 * first live run owns confirming the mapping). Until then a reviewed stub
 * with strict tests, not a claim.
 */
export class OpenAiSttService implements SttService {
  readonly name = "openai";
  readonly live = true;

  constructor(
    private readonly options: {
      apiKey: string;
      baseUrl?: string;
      model?: string;
      contentType?: string;
      timeoutMs?: number;
      fetchImpl?: typeof fetch;
    },
  ) {}

  createSession(): SttSession {
    const chunks: Uint8Array[] = [];
    return {
      push: async (chunk: Uint8Array): Promise<SttChunkResult> => {
        if (chunk.byteLength > 0) chunks.push(chunk);
        return { utterances: [], speech: null };
      },
      close: async (): Promise<{ utterances: SttUtterance[]; audioSeconds: number }> => {
        if (chunks.length === 0) return { utterances: [], audioSeconds: 0 };
        const total = chunks.reduce((n, c) => n + c.byteLength, 0);
        const audio = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          audio.set(chunk, offset);
          offset += chunk.byteLength;
        }
        chunks.length = 0;
        const started = Date.now();
        const utterances = await this.transcribe(audio);
        return { utterances, audioSeconds: Math.max(0, (Date.now() - started) / 1000) };
      },
    };
  }

  private async transcribe(audio: Uint8Array): Promise<SttUtterance[]> {
    const base = (this.options.baseUrl ?? "https://api.openai.com").replace(/\/+$/, "");
    const contentType = this.options.contentType ?? "audio/webm";
    const form = new FormData();
    form.append("file", new Blob([audio], { type: contentType }), fileNameFor(contentType));
    form.append("model", this.options.model ?? "gpt-4o-transcribe-diarize");
    form.append("response_format", "verbose_json");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 120_000);
    try {
      const res = await (this.options.fetchImpl ?? fetch)(`${base}/v1/audio/transcriptions`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.options.apiKey}` },
        body: form,
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`openai answered ${res.status}`);
      return mapOpenAiTranscript(await res.json().catch(() => null));
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Extension the transcription endpoint uses to sniff the container. */
function fileNameFor(contentType: string): string {
  const ext =
    contentType === "audio/wav" || contentType === "audio/x-wav"
      ? "wav"
      : contentType === "audio/mpeg" || contentType === "audio/mp3"
        ? "mp3"
        : contentType === "audio/ogg"
          ? "ogg"
          : "webm";
  return `audio.${ext}`;
}

/**
 * OpenAI verbose_json → our utterances. Segments preferred (with speaker
 * when the diarization model attaches one — string used as-is, number
 * mapped like any other 0-based label); otherwise the top-level text
 * unattributed. Garbage is silence; HTTP failures throw upstream.
 */
export function mapOpenAiTranscript(body: unknown): SttUtterance[] {
  if (typeof body !== "object" || body === null) return [];
  const root = body as Record<string, unknown>;
  if (Array.isArray(root.segments)) {
    const utterances: SttUtterance[] = [];
    for (const raw of root.segments as Record<string, unknown>[]) {
      if (typeof raw?.text !== "string" || raw.text.trim() === "") continue;
      const text = raw.text;
      const speaker = raw.speaker;
      const start = raw.start;
      const end = raw.end;
      utterances.push({
        text: text.trim(),
        ...(typeof speaker === "string" && speaker !== ""
          ? { speaker }
          : typeof speaker === "number"
            ? { speaker: deepgramSpeaker(speaker) }
            : {}),
        ...(typeof start === "number" ? { startedAt: start } : {}),
        ...(typeof end === "number" ? { endedAt: end } : {}),
      });
    }
    if (utterances.length > 0) return utterances;
  }
  if (typeof root.text === "string" && root.text.trim() !== "") {
    return [{ text: root.text.trim() }];
  }
  return [];
}

/**
 * Deepgram pre-recorded transcription (`POST {base}/v1/listen`, auth
 * `Authorization: Token <key>` — note: Token, not Bearer).
 *
 * The REST+diarization mapping is deliberate: the session buffers every
 * chunk and transcribes ONCE at close. Per-chunk transcription would be
 * livelier but WRONG — diarization labels restart per request, so chunk 1's
 * `spk_0` and chunk 2's `spk_0` would silently merge two different people.
 * Turns therefore arrive at session close (the client's close-flush path
 * already handles exactly this shape); true live diarization needs the
 * WebSocket adapter, which is a separate implementation against this same
 * interface, not an edit to callers. Duration comes from the response
 * metadata, never from a byte-count guess.
 */
export class DeepgramSttService implements SttService {
  readonly name: string;
  readonly live = true;

  constructor(
    private readonly options: {
      apiKey: string;
      baseUrl?: string;
      model?: string;
      contentType?: string;
      timeoutMs?: number;
      fetchImpl?: typeof fetch;
    },
  ) {
    this.name = "deepgram";
  }

  createSession(): SttSession {
    const chunks: Uint8Array[] = [];
    const transcribe = async (
      audio: Uint8Array,
    ): Promise<{ utterances: SttUtterance[]; durationSeconds: number }> => {
      const base = (this.options.baseUrl ?? "https://api.deepgram.com").replace(/\/+$/, "");
      const params = new URLSearchParams({
        model: this.options.model ?? "nova-3",
        smart_format: "true",
        punctuate: "true",
        diarize_model: "latest",
        utterances: "true",
      });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 120_000);
      try {
        const res = await (this.options.fetchImpl ?? fetch)(`${base}/v1/listen?${params}`, {
          method: "POST",
          headers: {
            authorization: `Token ${this.options.apiKey}`,
            "content-type": this.options.contentType ?? "audio/webm",
          },
          body: audio,
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`deepgram answered ${res.status}`);
        return mapDeepgramTranscript(await res.json().catch(() => null));
      } finally {
        clearTimeout(timer);
      }
    };
    return {
      push: async (chunk: Uint8Array): Promise<SttChunkResult> => {
        if (chunk.byteLength > 0) chunks.push(chunk);
        return { utterances: [], speech: null };
      },
      close: async (): Promise<{ utterances: SttUtterance[]; audioSeconds: number }> => {
        if (chunks.length === 0) return { utterances: [], audioSeconds: 0 };
        const total = chunks.reduce((n, c) => n + c.byteLength, 0);
        const audio = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          audio.set(chunk, offset);
          offset += chunk.byteLength;
        }
        chunks.length = 0;
        const { utterances, durationSeconds } = await transcribe(audio);
        return { utterances, audioSeconds: durationSeconds };
      },
    };
  }
}

/**
 * Deepgram LIVE streaming transcription (`wss://{host}/v1/listen`, auth
 * `Authorization: Token <key>` — the same Token scheme as REST).
 *
 * This is the V8 continuous transport, and it differs from the REST
 * sibling in exactly one structural way: the socket stays open across
 * chunks, so diarization labels are STABLE for the whole session and
 * finals can flow per chunk instead of all at close. Interim results
 * are received and DROPPED — never durable, the same rule the client
 * enforces (docs/25 V1b) — while `vad_events` speech onset rides the
 * `speech` verdict of the next push, which is what per-utterance
 * barge-in reads. Selected by `LUCENT_STT_STREAMING=1`; the default
 * stays buffer-at-close until streaming soaks in production.
 *
 * Failure posture, stated because a socket is livelier than a POST: a
 * dead socket makes push/close THROW (the route answers 502), never
 * empty-finals — silence must mean "nothing said", not "link down".
 * Audio stays ephemeral (session handle only, like the REST path).
 */
export class DeepgramStreamingSttService implements SttService {
  readonly name = "deepgram-stream";
  readonly live = true;

  constructor(
    private readonly options: {
      apiKey: string;
      /** REST base; the ws scheme is derived (`https://` → `wss://`). */
      baseUrl?: string;
      /** Full ws(s) URL override (tests point this at a local server). */
      wsUrl?: string;
      model?: string;
      /** End-of-utterance holdoff ms; Deepgram flushes finals past it. */
      utteranceEndMs?: number;
      /** Open/connect timeout ms. */
      timeoutMs?: number;
      closeTimeoutMs?: number;
      wsImpl?: typeof WebSocket;
    },
  ) {
    this.name = "deepgram-stream";
  }

  createSession(): SttSession {
    const opts = this.options;
    const WSCtor = opts.wsImpl ?? WebSocket;
    let socket: WebSocket | null = null;
    let ready: Promise<void> | null = null;
    let failure: Error | null = null;
    let closed = false;
    const finals: SttUtterance[] = [];
    let speechLatch: boolean | null = null;
    let audioSeconds = 0;

    const fail = (message: string): Error => {
      if (!failure) failure = new Error(message);
      try {
        socket?.terminate();
      } catch {
        // terminating a dead socket is best-effort by definition
      }
      socket = null;
      return failure;
    };

    const onText = (data: WebSocket.RawData): void => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString()) as Record<string, unknown>;
      } catch {
        return; // non-JSON control frames are noise, never content
      }
      const type = msg.type;
      if (type === "Results") {
        if (msg.is_final !== true) return; // interim: heard, never kept
        const alternative = (((msg.channel as Record<string, unknown> | undefined)
          ?.alternatives as unknown[]) ?? [])[0] as Record<string, unknown> | undefined;
        const words =
          alternative && Array.isArray(alternative.words)
            ? (alternative.words as Record<string, unknown>[])
            : [];
        for (const u of groupWordsIntoUtterances(words)) finals.push(u);
        const duration = msg.duration;
        if (typeof duration === "number" && duration > audioSeconds) audioSeconds = duration;
      } else if (type === "SpeechStarted") {
        // Genuine voice onset from the VAD (vad_events=true) — the field
        // per-utterance barge-in reads. Latched until the next push
        // reports it, then cleared: a stale "speech!" is a false onset.
        speechLatch = true;
      } else if (type === "UtteranceEnd") {
        const lastEnd = msg.last_word_end;
        if (typeof lastEnd === "number" && lastEnd > audioSeconds) audioSeconds = lastEnd;
      } else if (type === "Error") {
        const detail =
          typeof (msg as { description?: unknown }).description === "string"
            ? (msg as { description: string }).description
            : typeof (msg as { message?: unknown }).message === "string"
              ? (msg as { message: string }).message
              : "deepgram streaming error";
        fail(`deepgram streaming: ${detail}`);
      }
      // Metadata / Warning / interim: informational or ignored by rule.
    };

    const ensureOpen = (): Promise<void> => {
      if (failure) return Promise.reject(failure);
      if (socket && socket.readyState === WebSocket.OPEN) return Promise.resolve();
      if (!ready) {
        ready = new Promise<void>((resolve, reject) => {
          const base = (opts.baseUrl ?? "https://api.deepgram.com").replace(/\/+$/, "");
          const wsBase = opts.wsUrl ?? base.replace(/^http/, "ws");
          const params = new URLSearchParams({
            model: opts.model ?? "nova-3",
            smart_format: "true",
            punctuate: "true",
            diarize: "true",
            interim_results: "true",
            utterance_end_ms: String(opts.utteranceEndMs ?? 1000),
            vad_events: "true",
          });
          let s: WebSocket;
          try {
            s = new WSCtor(`${wsBase}/v1/listen?${params}`, {
              headers: { authorization: `Token ${opts.apiKey}` },
            });
          } catch (err) {
            reject(fail(`deepgram streaming connect failed: ${(err as Error).message}`));
            return;
          }
          const timer = setTimeout(() => {
            reject(fail("deepgram streaming connect timed out"));
          }, opts.timeoutMs ?? 15_000);
          s.on("open", () => {
            clearTimeout(timer);
            socket = s;
            resolve();
          });
          s.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
            if (!isBinary) onText(data);
          });
          s.on("error", (err: Error) => {
            clearTimeout(timer);
            if (!socket) reject(fail(`deepgram streaming connect failed: ${err.message}`));
            else fail(`deepgram streaming socket error: ${err.message}`);
          });
          s.on("close", (code: number, reason: Buffer) => {
            clearTimeout(timer);
            // An abnormal close mid-session is data loss until proven
            // otherwise: the buffered audio after the last final never got
            // transcribed, so the session must fail loud, not go quiet.
            // 1005 (no status) on a clean client-initiated close is fine —
            // `closed` distinguishes our own close from theirs.
            if (!closed && code !== 1000 && code !== 1005) {
              const why = reason?.length ? `: ${reason.toString().slice(0, 200)}` : "";
              fail(`deepgram streaming closed unexpectedly (${code}${why})`);
              if (!socket) reject(failure);
            } else if (!socket) {
              reject(fail(`deepgram streaming closed (${code}) before open`));
            }
            socket = null;
          });
        });
        // An unobserved rejection here would crash the process on some
        // Node versions; every consumer awaits `ready`, but belt it.
        ready.catch(() => {});
      }
      return ready;
    };

    return {
      push: async (chunk: Uint8Array): Promise<SttChunkResult> => {
        if (closed) throw failure ?? new Error("deepgram streaming session is closed");
        if (failure) throw failure;
        // Empty pushes never touch the socket: they drain whatever
        // finalized since the last push, which keeps finals flowing on
        // quiet ticks and gives callers a deterministic collect pump.
        // A session that never spoke never dials: with no connection
        // attempt in flight there can be nothing to drain.
        if (chunk.byteLength === 0) {
          if (!ready) return { utterances: [], speech: null };
          await ready.catch(() => {});
          if (failure) throw failure;
          const drained = finals.splice(0, finals.length);
          const latched = speechLatch;
          speechLatch = null;
          return { utterances: drained, speech: latched };
        }
        await ensureOpen();
        if (failure) throw failure;
        if (!socket || socket.readyState !== WebSocket.OPEN) {
          throw fail("deepgram streaming socket not open for send");
        }
        await new Promise<void>((resolve, reject) => {
          socket!.send(chunk, (err?: Error) => (err ? reject(err) : resolve()));
        }).catch((err: Error) => {
          throw fail(`deepgram streaming send failed: ${err.message}`);
        });
        const out = finals.splice(0, finals.length);
        const speech = speechLatch;
        speechLatch = null;
        return { utterances: out, speech };
      },
      close: async (): Promise<{ utterances: SttUtterance[]; audioSeconds: number }> => {
        closed = true;
        if (failure) throw failure;
        if (!socket) {
          // Never opened (no audio ever pushed): nothing to flush.
          // A socket that died takes the failure arm above instead.
          if (ready) {
            try {
              await ready;
            } catch (err) {
              throw err as Error;
            }
          } else {
            return { utterances: [], audioSeconds: 0 };
          }
        }
        if (socket && socket.readyState === WebSocket.OPEN) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(() => resolve(), opts.closeTimeoutMs ?? 10_000);
            socket!.once("close", () => {
              clearTimeout(timer);
              resolve();
            });
            try {
              socket!.send(JSON.stringify({ type: "CloseStream" }));
            } catch {
              clearTimeout(timer);
              resolve();
            }
          });
        }
        try {
          socket?.terminate();
        } catch {
          // already gone; the flush below is what matters
        }
        socket = null;
        if (failure) throw failure;
        const out = finals.splice(0, finals.length);
        return { utterances: out, audioSeconds };
      },
    };
  }
}
/**
 * Deepgram listen response → our utterances. Preference order, each a
 * strict downgrade of the last: pre-grouped `results.utterances` (speaker
 * turns with timing) → words grouped by speaker → the bare alternative
 * transcript (no attribution). Speaker numbers start at 0 on the wire and
 * become `spk_01`-style labels here, the seam's convention. Anything
 * unparseable is silence, never invention; HTTP failures throw upstream.
 */
export function mapDeepgramTranscript(body: unknown): {
  utterances: SttUtterance[];
  durationSeconds: number;
} {
  const none = { utterances: [], durationSeconds: 0 };
  if (typeof body !== "object" || body === null) return none;
  const root = body as Record<string, unknown>;
  const duration =
    typeof (root.metadata as Record<string, unknown> | undefined)?.duration === "number"
      ? ((root.metadata as Record<string, unknown>).duration as number)
      : 0;
  const channels = (root.results as Record<string, unknown> | undefined)?.channels;
  const alternative = Array.isArray(channels)
    ? ((channels[0] as Record<string, unknown> | undefined)?.alternatives as unknown[])
    : undefined;
  const first = (Array.isArray(alternative) ? alternative[0] : undefined) as
    | Record<string, unknown>
    | undefined;
  const rawUtterances = (root.results as Record<string, unknown> | undefined)?.utterances;
  const utterances: SttUtterance[] = [];
  if (Array.isArray(rawUtterances)) {
    for (const raw of rawUtterances) {
      const u = raw as Record<string, unknown>;
      if (typeof u.transcript !== "string" || u.transcript.trim() === "") continue;
      const words = Array.isArray(u.words) ? (u.words as Record<string, unknown>[]) : [];
      const confidences = words
        .map((w) => w.confidence)
        .filter((c): c is number => typeof c === "number");
      utterances.push({
        text: u.transcript.trim(),
        ...(typeof u.speaker === "number" ? { speaker: deepgramSpeaker(u.speaker) } : {}),
        ...(typeof u.start === "number" ? { startedAt: u.start } : {}),
        ...(typeof u.end === "number" ? { endedAt: u.end } : {}),
        // Rounded: a float-dust mean (0.8500000000000001) would leak
        // arithmetic noise into turns and tests alike.
        ...(confidences.length > 0
          ? {
              confidence:
                Math.round((confidences.reduce((a, b) => a + b, 0) / confidences.length) * 1000) /
                1000,
            }
          : {}),
      });
    }
    if (utterances.length > 0) return { utterances, durationSeconds: duration };
  }
  const firstWords =
    first && Array.isArray(first.words) ? (first.words as Record<string, unknown>[]) : [];
  const grouped = groupWordsIntoUtterances(firstWords);
  if (grouped.length > 0) return { utterances: grouped, durationSeconds: duration };
  if (first && typeof first.transcript === "string" && first.transcript.trim() !== "") {
    return {
      utterances: [{ text: first.transcript.trim() }],
      durationSeconds: duration,
    };
  }
  return { utterances: [], durationSeconds: duration };
}

/**
 * Deepgram words (pre-recorded alternative or one streaming Results
 * message) → speaker-grouped utterances. One function for both paths so
 * the streaming transport can never silently disagree with the REST
 * mapping about what a speaker turn is: consecutive same-speaker words
 * merge, a speaker change (or string/number/absent label change) cuts,
 * confidence is the rounded word mean. Empty words are silence.
 */
export function groupWordsIntoUtterances(words: Record<string, unknown>[]): SttUtterance[] {
  const utterances: SttUtterance[] = [];
  let current: (SttUtterance & { sum?: number; count?: number }) | null = null;
  let currentSpeaker: unknown = Symbol("none");
  const flush = () => {
    if (current && current.text.trim() !== "") {
      // Proper mean, rounded like the utterances path above.
      if (current.count !== undefined && current.count > 0) {
        current.confidence = Math.round(((current.sum ?? 0) / current.count) * 1000) / 1000;
      }
      delete current.sum;
      delete current.count;
      utterances.push(current);
    }
    current = null;
  };
  for (const w of words) {
    if (typeof w.word !== "string") continue;
    if (w.speaker !== currentSpeaker) {
      flush();
      currentSpeaker = w.speaker;
      current = {
        text: "",
        ...(typeof w.speaker === "number" ? { speaker: deepgramSpeaker(w.speaker) } : {}),
        ...(typeof w.start === "number" ? { startedAt: w.start } : {}),
      };
    }
    if (!current) {
      current = { text: "" };
    }
    current.text += (current.text === "" ? "" : " ") + w.word;
    if (typeof w.end === "number") current.endedAt = w.end;
    if (typeof w.confidence === "number") {
      current.sum = (current.sum ?? 0) + w.confidence;
      current.count = (current.count ?? 0) + 1;
    }
  }
  flush();
  return utterances;
}

/** Deepgram speaker number (0-based) → the seam's opaque label. */
export function deepgramSpeaker(n: number): string {
  return `spk_${String(n + 1).padStart(2, "0")}`;
}

/**
 * Key + provider means a live vendor; key + URL (no provider) means the
 * generic sidecar contract; anything less is the standby mock. An unknown
 * provider name is a configuration error that fails LOUD at boot, never a
 * silent mock — misconfiguration must not masquerade as privacy.
 */
export function selectSttService(env: SttEnv = process.env): SttService {
  const apiKey = env.LUCENT_STT_KEY;
  const provider = (env.LUCENT_STT_PROVIDER ?? "http").toLowerCase();
  if (provider === "openai") {
    const key = apiKey ?? env.OPENAI_API_KEY;
    if (!key) return new MockSttService();
    return new OpenAiSttService({
      apiKey: key,
      ...(env.LUCENT_STT_URL ? { baseUrl: env.LUCENT_STT_URL } : {}),
      ...(env.LUCENT_OPENAI_STT_MODEL ? { model: env.LUCENT_OPENAI_STT_MODEL } : {}),
      ...(env.LUCENT_OPENAI_CONTENT_TYPE ? { contentType: env.LUCENT_OPENAI_CONTENT_TYPE } : {}),
      ...(env.LUCENT_STT_TIMEOUT_MS && Number.isFinite(Number(env.LUCENT_STT_TIMEOUT_MS))
        ? { timeoutMs: Number(env.LUCENT_STT_TIMEOUT_MS) }
        : {}),
    });
  }
  if (provider === "deepgram") {
    if (!apiKey) return new MockSttService();
    const shared = {
      apiKey,
      ...(env.LUCENT_STT_URL ? { baseUrl: env.LUCENT_STT_URL } : {}),
      ...(env.LUCENT_DEEPGRAM_MODEL ? { model: env.LUCENT_DEEPGRAM_MODEL } : {}),
      ...(env.LUCENT_DEEPGRAM_CONTENT_TYPE
        ? { contentType: env.LUCENT_DEEPGRAM_CONTENT_TYPE }
        : {}),
      ...(env.LUCENT_STT_TIMEOUT_MS && Number.isFinite(Number(env.LUCENT_STT_TIMEOUT_MS))
        ? { timeoutMs: Number(env.LUCENT_STT_TIMEOUT_MS) }
        : {}),
    };
    if (env.LUCENT_STT_STREAMING === "1") return new DeepgramStreamingSttService(shared);
    return new DeepgramSttService(shared);
  }
  if (provider !== "http") {
    throw new Error(
      `LUCENT_STT_PROVIDER="${env.LUCENT_STT_PROVIDER}" is unknown (expected "http", "deepgram" or "openai")`,
    );
  }
  const url = env.LUCENT_STT_URL;
  if (apiKey && url) {
    return new GenericHttpSttService({
      url,
      apiKey,
      ...(env.LUCENT_STT_NAME ? { name: env.LUCENT_STT_NAME } : {}),
    });
  }
  return new MockSttService();
}

/* ------------------------- session registry ------------------------- */

export interface SttSessionEntry {
  id: string;
  userId: string;
  orgId: string | undefined;
  handle: SttSession;
  createdAt: number;
  lastSeenAt: number;
  audioBytes: number;
}

export interface SttRegistryOptions {
  now?: () => number;
  /** Wall-clock session TTL; sessions are ephemeral, never persisted. */
  ttlMs?: number;
  /** Hard cap: the oldest session is evicted past it (bounded memory). */
  maxSessions?: number;
}

function newSessionId(): string {
  return `stt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * The process-local session table. Ephemeral by design (see module header):
 * a restart drops sessions and in-flight audio with them, exactly like
 * presence — durable state was never here. Expiry is lazy (checked on
 * access) so no timer is needed; the cap bounds memory under abuse.
 */
export function createSttSessionRegistry(options: SttRegistryOptions = {}): {
  create(userId: string, orgId: string | undefined, handle: SttSession): SttSessionEntry;
  get(id: string): SttSessionEntry | undefined;
  touch(entry: SttSessionEntry, audioBytes?: number): void;
  remove(id: string): boolean;
  size(): number;
} {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? 15 * 60_000;
  const maxSessions = options.maxSessions ?? 1000;
  const entries = new Map<string, SttSessionEntry>();

  function expired(entry: SttSessionEntry, at: number): boolean {
    return at - entry.lastSeenAt > ttlMs;
  }

  function purge(at: number): void {
    for (const [id, entry] of entries) {
      if (expired(entry, at)) entries.delete(id);
    }
    while (entries.size > maxSessions) {
      const oldest = entries.keys().next();
      if (oldest.done) break;
      entries.delete(oldest.value);
    }
  }

  return {
    create(userId: string, orgId: string | undefined, handle: SttSession): SttSessionEntry {
      purge(now());
      const at = now();
      const entry: SttSessionEntry = {
        id: newSessionId(),
        userId,
        orgId,
        handle,
        createdAt: at,
        lastSeenAt: at,
        audioBytes: 0,
      };
      entries.set(entry.id, entry);
      purge(now());
      return entry;
    },
    get(id: string): SttSessionEntry | undefined {
      const entry = entries.get(id);
      if (!entry) return undefined;
      if (expired(entry, now())) {
        entries.delete(id);
        return undefined;
      }
      return entry;
    },
    touch(entry: SttSessionEntry, audioBytes = 0): void {
      entry.lastSeenAt = now();
      entry.audioBytes += audioBytes;
    },
    remove(id: string): boolean {
      return entries.delete(id);
    },
    size(): number {
      purge(now());
      return entries.size;
    },
  };
}

export type SttSessionRegistry = ReturnType<typeof createSttSessionRegistry>;
