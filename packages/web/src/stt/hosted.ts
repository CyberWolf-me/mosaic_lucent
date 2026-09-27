import { apiFetch } from "../http.js";
import type { SttProvider, VoiceHandlers, VoiceSession } from "./types.js";
import { eventConsumerFromCallbacks, type VoiceEventHandlers } from "./events.js";

/**
 * Server-hosted diarizing STT (docs/25 V1 — the fourth slot).
 *
 * The mic stays here, but transcription happens server-side: this provider
 * opens a session (`POST /api/stt/sessions`), streams MediaRecorder slices
 * as audio chunks, and surfaces the finals the server returns — each already
 * carrying the sidecar's speaker label, which rides `onFinal`'s meta so
 * meeting capture attributes turns to speakers on a shared mic.
 *
 * What this provider deliberately does NOT do:
 *
 * - No interim words. Chunk cadence (2s) is the deep loop's cadence, not the
 *   fast loop's: live captions stay the browser provider's job. Finals
 *   display immediately, exactly like every other provider.
 * - No client-held secrets. The session is authed by the caller's own
 *   session (cookie/bearer via `apiFetch`); the STT key never leaves the
 *   server, the same rule as every other provider key.
 * - No silent void. An unconfigured server answers 503, a forbidding org
 *   403, an exhausted allowance 402 — each becomes the `onError` message,
 *   never an empty transcript the user mistakes for silence.
 */

interface SessionResponse {
  sessionId?: string;
  /** "at-close" when the server's provider transcribes only at close. */
  mode?: string;
  error?: string;
}

/** docs/28 F22: what the person is told when hosted capture works with less. */
export function hostedDegradedReason(atClose: boolean, droppedChunks: number): string | null {
  const parts: string[] = [];
  if (atClose) {
    parts.push(
      "This server's transcription returns the text when you stop, so Lucent can't answer or pick out decisions while the meeting runs.",
    );
  }
  if (droppedChunks > 0) {
    const seconds = droppedChunks * 2;
    parts.push(
      `About ${seconds} seconds of audio weren't transcribed — the server didn't answer. The rest is still being transcribed.`,
    );
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

interface ServerFinal {
  text?: unknown;
  speaker?: unknown;
  start?: unknown;
  end?: unknown;
  confidence?: unknown;
}

interface AudioResponse {
  finals?: ServerFinal[];
  error?: string;
}

interface CloseResponse extends AudioResponse {
  audioSeconds?: number;
  minutes?: number;
}

const CHUNK_MS = 2000;

async function readError(res: Response, fallback: string): Promise<string> {
  const data = (await res.json().catch(() => null)) as { error?: unknown } | null;
  return typeof data?.error === "string" && data.error !== "" ? data.error : fallback;
}

export const hostedSttProvider: SttProvider = {
  id: "hosted",

  isSupported() {
    // Mic only — no client configuration exists (the server decides
    // liveness at session creation and says 503 when unconfigured).
    return typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia);
  },

  unavailableReason() {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      return "This browser can't access the microphone.";
    }
    return null;
  },

  start(handlers: VoiceHandlers): VoiceSession | null {
    const withEvents = this.startWithEvents;
    if (!withEvents) return null;
    return withEvents.call(this, eventConsumerFromCallbacks(handlers));
  },

  startWithEvents(handlers: VoiceEventHandlers): VoiceSession | null {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      handlers.onError?.("This browser can't access the microphone.");
      return null;
    }

    let stopped = false;
    // `disposed` is the true teardown: only after the close flush completes do
    // we ignore finals. `stopped` (below) suppresses NEW work and errors the
    // moment the user stops, but the last chunk and the close-response finals
    // must still surface — F3: gating emits on `stopped` dropped every one.
    let disposed = false;
    let sessionId: string | null = null;
    let recorder: MediaRecorder | null = null;
    let stream: MediaStream | null = null;
    // Serialize chunk uploads: a 2s cadence never overlaps, and an ordering
    // guarantee the server does not need is still one less thing to reason
    // about when finals arrive out of order.
    let chain: Promise<void> = Promise.resolve();
    // docs/28 F22: failed chunk uploads used to vanish without a word.
    let atClose = false;
    let dropped = 0;
    const reportDegraded = (): void =>
      handlers.onDegraded?.(hostedDegradedReason(atClose, dropped));

    handlers.onStatus?.("connecting");

    const fail = (message: string): null => {
      if (!stopped) handlers.onError?.(message);
      return null;
    };

    const emitFinals = (finals: AudioResponse["finals"]): void => {
      if (disposed || !finals) return;
      for (const f of finals) {
        if (typeof f.text !== "string" || f.text.trim() === "") continue;
        // Mixed-stream labels stay opaque speakerIds (never persons); the
        // sidecar's timing rides along; confidence passes through inert.
        handlers.onEvent({
          type: "final",
          text: f.text,
          at: Date.now(),
          ...(typeof f.speaker === "string" && f.speaker !== "" ? { speakerId: f.speaker } : {}),
          ...(typeof f.start === "number" ? { startMs: f.start * 1000 } : {}),
          ...(typeof f.end === "number" ? { endMs: f.end * 1000 } : {}),
          ...(typeof f.confidence === "number" ? { confidence: f.confidence } : {}),
          source: "hosted",
        });
      }
    };

    const postChunk = (bytes: Blob): void => {
      if (disposed || sessionId === null || bytes.size === 0) return;
      const id = sessionId;
      chain = chain.then(async () => {
        if (disposed) return;
        let res: Response;
        try {
          res = await apiFetch(`/api/stt/sessions/${encodeURIComponent(id)}/audio`, {
            method: "POST",
            body: bytes,
          });
        } catch {
          if (!disposed) {
            dropped += 1;
            reportDegraded();
          }
          return;
        }
        if (disposed) return;
        if (!res.ok) {
          dropped += 1;
          reportDegraded();
          return;
        }
        const data = (await res.json().catch(() => null)) as AudioResponse | null;
        emitFinals(data?.finals);
      });
    };

    const closeSession = (): void => {
      if (sessionId === null) return;
      const id = sessionId;
      sessionId = null;
      chain = chain.then(async () => {
        let res: Response;
        try {
          res = await apiFetch(`/api/stt/sessions/${encodeURIComponent(id)}/close`, {
            method: "POST",
          });
        } catch {
          return;
        }
        if (!res.ok) return;
        const data = (await res.json().catch(() => null)) as CloseResponse | null;
        emitFinals(data?.finals);
        // Boundary flush first, stopped last: consumers must see every final
        // before the stream ends, or the last turn is silently losable.
        handlers.onEvent({ type: "speech_stopped", at: Date.now() });
        // Only now is the stream truly done — any late chunk response is inert.
        disposed = true;
      });
    };

    void (async () => {
      let created: Response;
      try {
        created = await apiFetch("/api/stt/sessions", { method: "POST" });
      } catch {
        if (!stopped) handlers.onError?.("Couldn't reach the transcription service.");
        return;
      }
      if (stopped) return;
      if (!created.ok) {
        if (created.status === 503) {
          fail(
            "Hosted transcription isn't configured on this server — nothing would be transcribed. Use on-device Whisper or LiveKit instead.",
          );
        } else {
          fail(await readError(created, `Hosted transcription failed (${created.status}).`));
        }
        return;
      }
      const data = (await created.json().catch(() => null)) as SessionResponse | null;
      if (!data?.sessionId) {
        fail("Hosted transcription answered without a session.");
        return;
      }
      sessionId = data.sessionId;
      if (data.mode === "at-close") {
        atClose = true;
        reportDegraded();
      }
      if (stopped) {
        closeSession();
        return;
      }
      let mic: MediaStream;
      try {
        mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        closeSession();
        fail("Microphone access was denied.");
        return;
      }
      if (stopped) {
        for (const track of mic.getTracks()) track.stop();
        closeSession();
        return;
      }
      stream = mic;
      try {
        recorder = new MediaRecorder(stream);
      } catch {
        for (const track of mic.getTracks()) track.stop();
        closeSession();
        fail("This browser can't record audio for upload.");
        return;
      }
      recorder.ondataavailable = (event: BlobEvent) => postChunk(event.data);
      recorder.onerror = () => {
        if (!stopped) handlers.onError?.("Audio upload failed; transcription stopped.");
        void session?.stop();
      };
      // Close only AFTER MediaRecorder has flushed its final chunk (onstop
      // fires after the last ondataavailable). Closing eagerly in stop() raced
      // the last chunk and dropped it — the recorder's own stop sequence is the
      // ordering guarantee (F3).
      recorder.onstop = () => {
        if (stream) {
          for (const track of stream.getTracks()) track.stop();
          stream = null;
        }
        closeSession();
      };
      try {
        recorder.start(CHUNK_MS);
      } catch {
        for (const track of mic.getTracks()) track.stop();
        closeSession();
        fail("This browser can't record audio for upload.");
        return;
      }
      handlers.onEvent({ type: "speech_started", at: Date.now() });
      handlers.onStatus?.("listening");
      handlers.onStart?.();
    })();

    const session: VoiceSession = {
      stop() {
        if (stopped) return;
        stopped = true;
        handlers.onStatus?.("idle");
        // Prefer the recorder's own stop: it flushes the final chunk and then
        // fires onstop, which stops the tracks and closes the session — so the
        // last chunk is uploaded before the close (F3). Only when there is no
        // active recorder (stopped mid-setup) do we tear down directly.
        const active = recorder;
        recorder = null;
        if (active) {
          try {
            active.stop();
            return;
          } catch {
            // Fall through to a direct teardown below.
          }
        }
        if (stream) {
          for (const track of stream.getTracks()) track.stop();
          stream = null;
        }
        closeSession();
      },
    };
    return session;
  },
};
