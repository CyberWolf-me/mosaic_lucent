import { randomUUID } from "node:crypto";

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
}

/** Key + URL means a live sidecar; anything less is the standby mock. */
export function selectSttService(env: SttEnv = process.env): SttService {
  const apiKey = env.LUCENT_STT_KEY;
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
